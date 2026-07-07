import { expect } from 'chai';
import { BTree, KeyBound, KeyRange, NodeCapacity, PathNotOnEntryError } from '../src/index.js';
import { BranchNode } from '../src/nodes.js';
import { assertTreeInvariants } from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

// Randomized oracle / stress test.
//
// A long stream of random operations is applied to a BTree AND, in lock-step, to a trivially-correct
// reference model (a Map<number, Entry> plus a sorted key array). After every operation the tree's return
// value is checked against the model's prediction, and after every *mutation* the tree's full ordering,
// count and structural invariants are checked against the model. Any ordering / rebalance regression - the
// class of bug the historical partition-corruption in src/b-tree.ts belonged to - fails within a few seconds
// and reproduces deterministically from its seed.
//
// The model is the source of truth. Every assertion compares the tree to the model, never the tree to
// itself. All randomness flows through test/helpers/rng.ts (never Math.random), so a failure at op N under
// seed S replays exactly.

// `process` is a Node global but @types/node is not a dependency of this package, so declare the sliver we
// need (env access) locally rather than pulling in the whole type package just for two env reads.
declare const process: { env: Record<string, string | undefined> };

interface Entry { key: number; val: number; }

// Op-count per seed (before per-seed opsScale). Default 1.5e4 - kept a touch under 2e4 so that, with the
// full invariant traversal running every op, the whole file still finishes in a few seconds under
// `yarn test`. A nightly/manual run sets ORACLE_OPS=1000000 to push each seed toward 1e6 (slow, opt-in).
// ORACLE_STRIDE gates only the O(n) full-traversal deep-equal (entries() vs model); assertTreeInvariants and
// the count check always run every mutation regardless of stride. Default stride 1 = the heaviest, every-op
// setting.
const OPS = Number(process.env.ORACLE_OPS ?? 15000);
const STRIDE = Number(process.env.ORACLE_STRIDE ?? 1);

// Per-test timeout, sized for the default run; disabled entirely for the opt-in big run. The global mocha
// timeout is deliberately left at its default (the ticket forbids raising it for the big run) - only these
// per-test timeouts move.
const TIMEOUT = OPS > 50000 ? 0 : 60000;

// Fixed seeds, each with its own key space so the file spans tree shapes from a single leaf up to a genuine
// 3-level tree. Key space is a few times the equilibrium fill, so absent keys - the interesting "crack"
// cases (between leaves, past the end) - occur on a large fraction of random probes. The `deep` seed's key
// space is chosen so the insert-weighted mix settles well above NodeCapacity^2 = 4096 entries, forcing
// branch-level splits and merges (see the assertion at the end of runSeed).
// `warmup` (deep seed only): insert this many distinct keys up front so the random stream operates on an
// already-3-level tree (> NodeCapacity^2 = 4096 entries) from op 0, exercising branch splits/merges/borrows
// throughout rather than only after a slow equilibrium climb. The key space is sized so the stream's
// equilibrium fill sits just above the warmup, keeping the tree at 3 levels for the whole run.
//
// `opsScale` scales this seed's op count relative to the shared OPS (default 1). The deep seed runs fewer
// ops: each of its ops pays the full per-op invariant traversal on a 4k-entry tree (~0.6ms), so a full OPS
// would dominate the file's wall-clock while adding little - branch-rebalance coverage saturates quickly.
// The small/fast seeds carry the high-volume ordering coverage. The scale still multiplies through
// ORACLE_OPS, so the opt-in 1e6 run scales every seed up together.
const SEEDS: { seed: number; keyspace: number; warmup?: number; opsScale?: number; deep?: boolean }[] = [
	{ seed: 1, keyspace: 64 },                                                  // single-leaf / near-empty shapes
	{ seed: 2, keyspace: 700 },                                                 // a few leaves under one branch (2-level)
	{ seed: 3, keyspace: 1500 },                                                // solid 2-level; leaf borrows/merges
	{ seed: 42, keyspace: 6500, warmup: 4300, opsScale: 0.3, deep: true },      // 3-level: branch splits/merges/borrows
	{ seed: 12345, keyspace: 1000 },                                            // mixed 2-level
];

type OpName = 'insert' | 'delete' | 'upsert' | 'merge' | 'update' | 'find' | 'range';

// Insert-weighted so the tree grows through splits and settles at a high fill (~0.69 of the key space);
// deleteAt provides the shrink through merges/borrows. upsert/merge/updateAt exercise the value semantics.
// find/range are read-only probes (they also carry the find(absentKey)->next crack guard and the range
// contract). Weights are the same for every seed; only the key space varies.
const WEIGHTS: [OpName, number][] = [
	['insert', 5], ['delete', 4], ['upsert', 2], ['merge', 2], ['update', 2], ['find', 2], ['range', 2],
];
const TOTAL_WEIGHT = WEIGHTS.reduce((s, [, w]) => s + w, 0);
// Ops that can change the entry set/values - the ones that trigger the after-every-mutation checks. Reads
// (find/range) are excluded: they can't change the tree, so re-checking invariants after them is wasted work.
const MUTATIONS = new Set<OpName>(['insert', 'delete', 'upsert', 'merge', 'update']);

function pickOp(rng: () => number): OpName {
	let r = rng() * TOTAL_WEIGHT;
	for (const [name, w] of WEIGHTS) {
		if ((r -= w) < 0) return name;
	}
	return 'insert';	// unreachable (weights sum to TOTAL_WEIGHT); satisfies the type checker
}

// --- sorted-key model helpers (keep a sorted number[] in sync with the Map, so no per-op re-sort) --------

// First index i with arr[i] >= x (lower bound).
function lowerBound(arr: number[], x: number): number {
	let lo = 0, hi = arr.length;
	while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
	return lo;
}
// First index i with arr[i] > x (upper bound).
function upperBound(arr: number[], x: number): number {
	let lo = 0, hi = arr.length;
	while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
	return lo;
}

// Number of levels: 1 = single leaf root, 2 = root branch over leaves, 3 = root branch over branches, ...
function levelsOf(tree: BTree<number, Entry>): number {
	let node: any = (tree as any)['_root'];
	let d = 1;
	while (node instanceof BranchNode) { d++; node = node.nodes[0]; }
	return d;
}

// The exact key set a range() yields, derived from the sorted model keys. Mirrors src/b-tree.ts range()
// semantics precisely, including the direction-dependent role of the bounds:
//   ascending  -> `first` is the lower bound (>=/>), `last` is the upper bound (<=/<)
//   descending -> `first` is the upper bound (<=/<), `last` is the lower bound (>=/>)
// An omitted bound is open. A backwards / crossed range (no key satisfies both bounds) yields nothing - the
// same empty result src/b-tree.ts produces via its "start already past end" check.
function modelRange(sortedAsc: number[], range: KeyRange<number>): number[] {
	const { first, last, isAscending } = range;
	// NOTE: inclusive/isAscending default to true in b-tree.ts (treated as "!== false"), but this oracle reads
	// them truthily, so an omitted (undefined) inclusive/isAscending here would model as exclusive/descending -
	// diverging from the real tree. Safe only because randomRange() always supplies explicit booleans; if you
	// ever feed a default-bound KeyRange into this model, switch these reads to `!== false` to match b-tree.ts.
	const passesAsc = (k: number) =>
		(first ? (first.inclusive ? k >= first.key : k > first.key) : true) &&
		(last ? (last.inclusive ? k <= last.key : k < last.key) : true);
	const passesDesc = (k: number) =>
		(first ? (first.inclusive ? k <= first.key : k < first.key) : true) &&
		(last ? (last.inclusive ? k >= last.key : k > last.key) : true);
	const kept = sortedAsc.filter(isAscending ? passesAsc : passesDesc);
	return isAscending ? kept : kept.reverse();
}

function randomRange(rng: () => number, keyspace: number): KeyRange<number> {
	// Sometimes omit a bound (open end); bounds and their inclusivity are drawn independently, so backwards
	// and crossed ranges arise naturally and must (per modelRange) come back empty.
	const first = rng() < 0.85 ? new KeyBound(lcgInt(rng, 0, keyspace), rng() < 0.5) : undefined;
	const last = rng() < 0.85 ? new KeyBound(lcgInt(rng, 0, keyspace), rng() < 0.5) : undefined;
	return new KeyRange(first, last, rng() < 0.5);
}

function runSeed(cfg: { seed: number; keyspace: number; warmup?: number; opsScale?: number; deep?: boolean }): void {
	const { seed, keyspace, warmup, deep } = cfg;
	const seedOps = Math.max(1, Math.round(OPS * (cfg.opsScale ?? 1)));
	const rng = lcg(seed);
	const tree = new BTree<number, Entry>(e => e.key);

	// Model: Map for O(1) value lookup + a sorted key array kept in sync via binary insert/delete.
	const model = new Map<number, Entry>();
	const keys: number[] = [];	// ascending; parallel to model's key set
	const modelInsert = (k: number, e: Entry) => { keys.splice(lowerBound(keys, k), 0, k); model.set(k, e); };
	const modelDelete = (k: number) => { keys.splice(lowerBound(keys, k), 1); model.delete(k); };

	let v = 0;	// running counter -> distinct, monotonically-increasing values, so an updated value is
				// distinguishable from the original and value assertions have teeth.
	const mk = (key: number): Entry => ({ key, val: v++ });

	let maxSize = 0;
	let sawThreeLevels = false;

	// Full agreement check run after every mutation (the O(n) traversal deep-equal is gated by STRIDE; the
	// count check always runs). This is what makes even a modest op count catch ordering/rebalance bugs.
	//
	// The traversal comparison is done in plain JS and only escalates to a (descriptive) chai assertion on a
	// mismatch. Calling `expect().to.deep.equal` once per entry per op is ~100x slower than a plain compare
	// (chai builds an Assertion object each call), and at this op count that overhead dominated everything.
	const checkFull = (doTraversal: boolean) => {
		assertTreeInvariants(tree);	// structural floor: fill bounds, partition separation, order, bidi, count
		expect(tree.size, 'size vs model').to.equal(model.size);
		expect(tree.getCount(), 'getCount() vs model').to.equal(model.size);
		if (!doTraversal) return;
		// One ascending pass: entries() is aliasing-free, so reading each yielded entry directly is safe (never
		// spread ascending()/descending()/range() - those re-yield one cursor). Check key order against the
		// model's sorted array and the value against the model's Map in the same step.
		let idx = 0;
		let mismatch = false;
		for (const e of tree.entries()) {
			const m = model.get(e.key);
			if (e.key !== keys[idx] || m === undefined || e.val !== m.val) { mismatch = true; break; }
			idx++;
		}
		if (mismatch || idx !== keys.length) {
			// Slow path: rebuild explicit arrays so chai prints a useful diff of exactly what diverged.
			const treeEntries = [...tree.entries()];
			expect(treeEntries.map(e => e.key), 'ascending keys vs model').to.deep.equal(keys);
			for (const e of treeEntries) {
				expect(e, `entry for key ${e.key}`).to.deep.equal(model.get(e.key));
			}
			// Order/length matched key-wise but a value slipped through the fast check - surface it.
			expect(treeEntries.length, 'entry count vs model').to.equal(keys.length);
		}
	};

	// Optional warmup: bulk-insert distinct keys so the random stream starts on a genuinely deep tree.
	if (warmup) {
		for (let k = 0; k < warmup; k++) {
			const entry = mk(k);
			expect(tree.insert(entry).on, `warmup insert ${k}`).to.be.true;
			modelInsert(k, entry);
		}
		checkFull(true);	// invariants + full agreement once after the bulk build
		maxSize = tree.size;
		if (levelsOf(tree) >= 3) sawThreeLevels = true;
	}

	for (let i = 0; i < seedOps; i++) {
		const op = pickOp(rng);
		switch (op) {
			case 'insert': {
				const key = lcgInt(rng, 0, keyspace);
				const present = model.has(key);
				const entry = mk(key);
				const path = tree.insert(entry);
				// on === true iff the key was absent (inserted); on === false iff already present (rejected, no change).
				expect(path.on, `insert(${key}) on-state (present=${present})`).to.equal(!present);
				if (!present) {
					expect(tree.at(path), 'inserted entry').to.deep.equal(entry);
					modelInsert(key, entry);
				} else {
					// Rejected duplicate: the tree is unchanged and still holds the original value.
					expect(tree.get(key), 'rejected insert leaves original').to.deep.equal(model.get(key));
				}
				break;
			}
			case 'delete': {
				// Random key (present or not) so both the delete-hit and delete-miss (off-entry path) contracts
				// are exercised. deleteAt(find(absent)) returns false and changes nothing.
				const key = lcgInt(rng, 0, keyspace);
				const present = model.has(key);
				const ok = tree.deleteAt(tree.find(key));
				expect(ok, `deleteAt(find(${key})) result (present=${present})`).to.equal(present);
				if (present) modelDelete(key);
				break;
			}
			case 'upsert': {
				const key = lcgInt(rng, 0, keyspace);
				const present = model.has(key);
				const entry = mk(key);
				const path = tree.upsert(entry);
				// Never fails. on === true iff the key was ALREADY present; on === false iff new.
				expect(path.on, `upsert(${key}) on-state (present=${present})`).to.equal(present);
				expect(tree.get(key), 'upsert stores the entry').to.deep.equal(entry);
				if (present) model.set(key, entry);	// value replaced; key already in `keys`
				else modelInsert(key, entry);		// new key
				break;
			}
			case 'merge': {
				const key = lcgInt(rng, 0, keyspace);
				const present = model.has(key);
				const newEntry = mk(key);
				// getUpdated is key-preserving (combines values only) so the model stays a plain Map. Returns a
				// fresh object (never mutates `existing`, which is frozen) as merge requires.
				const [path, wasUpdate] = tree.merge(newEntry, existing => ({ key: existing.key, val: existing.val + newEntry.val }));
				expect(path.on, `merge(${key}) always lands on`).to.be.true;
				expect(wasUpdate, `merge(${key}) wasUpdate (present=${present})`).to.equal(present);
				if (present) {
					const combined: Entry = { key, val: model.get(key)!.val + newEntry.val };
					expect(tree.at(path), 'merge combined value').to.deep.equal(combined);
					model.set(key, combined);	// key already in `keys`
				} else {
					expect(tree.at(path), 'merge inserted value').to.deep.equal(newEntry);
					modelInsert(key, newEntry);
				}
				break;
			}
			case 'update': {
				if (keys.length === 0) break;	// need a present key; updateAt on a crack throws (unit-tested below)
				const oldKey = keys[lcgInt(rng, 0, keys.length)];
				// Choose the new key: often the same key (value-only update), otherwise a random key that may be
				// absent (relocate) or present-and-different (conflict / failed insert).
				const newKey = rng() < 0.4 ? oldKey : lcgInt(rng, 0, keyspace);
				const newEntry = mk(newKey);
				const [path, wasUpdate] = tree.updateAt(tree.find(oldKey), newEntry);
				if (newKey === oldKey) {
					// same key: value replaced in place.
					expect(path.on, `updateAt same-key ${oldKey} on`).to.be.true;
					expect(wasUpdate, 'same-key update reports wasUpdate=true').to.be.true;
					expect(tree.at(path), 'same-key updated value').to.deep.equal(newEntry);
					model.set(oldKey, newEntry);
				} else if (!model.has(newKey)) {
					// key changed to an absent key: delete old + insert new.
					expect(path.on, `updateAt relocate ${oldKey}->${newKey} on`).to.be.true;
					expect(wasUpdate, 'relocation reports wasUpdate=false (an insert)').to.be.false;
					expect(tree.at(path), 'relocated value').to.deep.equal(newEntry);
					modelDelete(oldKey);
					modelInsert(newKey, newEntry);
				} else {
					// key changed to a different, present key: the insert half fails, so nothing changes and the
					// OLD key is still present (the failed insert never deletes the original). Easy to get wrong.
					expect(path.on, `updateAt conflict ${oldKey}->${newKey} leaves path off`).to.be.false;
					expect(wasUpdate, 'conflict reports wasUpdate=false').to.be.false;
					expect(tree.get(oldKey), 'conflict leaves old key present').to.deep.equal(model.get(oldKey));
					expect(tree.get(newKey), 'conflict leaves target untouched').to.deep.equal(model.get(newKey));
				}
				break;
			}
			case 'find': {
				const probe = lcgInt(rng, 0, keyspace);
				const present = model.has(probe);
				const path = tree.find(probe);
				expect(path.on, `find(${probe}).on (present=${present})`).to.equal(present);
				expect(tree.get(probe), `get(${probe})`).to.deep.equal(present ? model.get(probe) : undefined);
				if (!present) {
					// §1.1 regression guard: from the crack, next lands on the next-greater key (or off the end),
					// prior lands on the next-smaller key (or off the start).
					const ub = upperBound(keys, probe);
					const nextGreater = ub < keys.length ? keys[ub] : undefined;
					const lb = lowerBound(keys, probe);
					const prevSmaller = lb > 0 ? keys[lb - 1] : undefined;
					const nxt = tree.next(path);
					if (nextGreater === undefined) {
						expect(nxt.on, `next past crack ${probe} has no successor`).to.be.false;
					} else {
						expect(nxt.on, `next past crack ${probe} advances`).to.be.true;
						expect(tree.at(nxt)!.key, `next from crack ${probe}`).to.equal(nextGreater);
					}
					const prv = tree.prior(path);
					if (prevSmaller === undefined) {
						expect(prv.on, `prior from crack ${probe} has no predecessor`).to.be.false;
					} else {
						expect(prv.on, `prior from crack ${probe} advances`).to.be.true;
						expect(tree.at(prv)!.key, `prior from crack ${probe}`).to.equal(prevSmaller);
					}
				}
				break;
			}
			case 'range': {
				const range = randomRange(rng, keyspace);
				const expected = modelRange(keys, range);
				// tree.keys(range) is aliasing-free (yields distinct keys), so iterating/spreading it is safe.
				// Compare in plain JS; only build the (stringified) chai failure on an actual mismatch.
				let j = 0;
				let bad = false;
				for (const k of tree.keys(range)) {
					if (j >= expected.length || k !== expected[j]) { bad = true; break; }
					j++;
				}
				if (bad || j !== expected.length) {
					expect([...tree.keys(range)], `range ${JSON.stringify(range)}`).to.deep.equal(expected);
				}
				break;
			}
		}

		if (MUTATIONS.has(op)) {
			checkFull(i % STRIDE === 0);
			maxSize = Math.max(maxSize, tree.size);
			if (!sawThreeLevels && levelsOf(tree) >= 3) sawThreeLevels = true;
		}
	}

	// Final exhaustive comparison regardless of stride.
	checkFull(true);

	if (deep) {
		// Prove the run actually stressed the branch machinery: a tree past NodeCapacity^2 entries is at least
		// 3 levels, so its splits/merges exercised branch nodes, not just leaves.
		expect(maxSize, `deep seed ${seed} should exceed NodeCapacity^2 (${NodeCapacity * NodeCapacity}) entries`)
			.to.be.greaterThan(NodeCapacity * NodeCapacity);
		expect(sawThreeLevels, `deep seed ${seed} should reach a 3-level tree`).to.be.true;
	}
}

describe('Randomized oracle (tree vs sorted-model reference)', () => {
	for (const cfg of SEEDS) {
		const seedOps = Math.max(1, Math.round(OPS * (cfg.opsScale ?? 1)));
		it(`seed ${cfg.seed} (keyspace ${cfg.keyspace}${cfg.deep ? ', deep' : ''}) matches the model over ${seedOps} ops`,
			() => runSeed(cfg)
		).timeout(TIMEOUT);
	}

	// updateAt on an off-entry (crack) path is illegal - asserted here as a small deterministic case rather
	// than in the random stream (the stream only ever calls updateAt on a present key).
	it('updateAt on an off-entry path throws PathNotOnEntryError and writes nothing', () => {
		const tree = new BTree<number, Entry>(e => e.key);
		tree.insert({ key: 1, val: 1 });
		tree.insert({ key: 9, val: 9 });
		const crack = tree.find(5);	// between 1 and 9: a valid path, but not on an entry
		expect(crack.on).to.be.false;
		expect(() => tree.updateAt(crack, { key: 5, val: 99 })).to.throw(PathNotOnEntryError);
		expect(tree.get(5), 'no phantom entry written').to.be.undefined;
		expect(tree.getCount(), 'tree unchanged').to.equal(2);
	});
});
