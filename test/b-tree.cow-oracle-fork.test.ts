import { expect } from 'chai';
import { BTree, KeyBound, KeyRange, NodeCapacity } from '../src/index.js';
import { BranchNode } from '../src/nodes.js';
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

// Randomized COW-fork oracle / stress test — the copy-on-write counterpart to test/b-tree.oracle.test.ts.
//
// The base oracle (test/b-tree.oracle.test.ts) drives one tree against a trivially-correct reference model
// (a Map<number, Entry> + a sorted key array). This variant drives that same op stream against a BASE up to
// a fork point, then FORKS a copy-on-write child and continues the stream against the CHILD — each tree
// checked against its OWN independent reference model.
//
// Why a single shared model would be wrong: the base and the child hold DIFFERENT key sets after the fork,
// so one model could never predict both — and, crucially, sharing a model would hide exactly the failure we
// are hunting: a child write leaking into the base (or vice versa). Two independent models catch that as a
// divergence between a tree and its own model.
//
// THE BASE-IMMUTABILITY CONTRACT (why the base is frozen after the fork, not driven further): a derived
// child reads any un-modified node straight from `base.root` (src/b-tree.ts), so mutating a base that still
// has a live derived child corrupts that child's view of every node they share — a hazard pinned in
// test/b-tree.cow-clearbase.test.ts. So the honest, contract-respecting shape is: drive the base for the
// FIRST half of the stream (no child exists yet), fork, then drive the CHILD for the SECOND half while the
// base's model stays fixed. Each mutation re-checks the child against its evolving model AND re-checks the
// (frozen) base against its fixed model plus the ownership invariant — proving both the child's COW
// correctness and that not one base node drifted. The model is the source of truth for both; every
// assertion compares a tree to its model, never a tree to itself. All randomness flows through
// test/helpers/rng.ts, so a failure at op N under seed S replays exactly.

declare const process: { env: Record<string, string | undefined> };

interface Entry { key: number; val: number; }

const keyOf = (e: Entry): number => e.key;

// Per-seed op counts. Kept modest by default so the file finishes in a few seconds under `yarn test` (every
// child mutation pays a full structural traversal, and the sampled deep checks pay the ownership walk).
const PRE_OPS = Number(process.env.COW_ORACLE_PRE ?? 500);	// ops driven on the base before the fork
const POST_OPS = Number(process.env.COW_ORACLE_POST ?? 1500);	// ops driven on the child after the fork
// STRIDE gates only the O(n) full-traversal deep-equal and the ownership walk; assertTreeInvariants and the
// count check always run after every mutation.
const STRIDE = Number(process.env.COW_ORACLE_STRIDE ?? 20);

// Seeds and key spaces sized so the base is comfortably multi-level (a warmup guarantees it) and absent-key
// probes — the interesting "crack" cases — occur on a large fraction of reads.
const SEEDS: { seed: number; keyspace: number; warmup: number }[] = [
	{ seed: 0x5EED, keyspace: 1200, warmup: 700 },
	{ seed: 0xC0FFEE, keyspace: 1500, warmup: 900 },
];

type OpName = 'insert' | 'delete' | 'upsert' | 'merge' | 'update' | 'find' | 'range';

const WEIGHTS: [OpName, number][] = [
	['insert', 5], ['delete', 4], ['upsert', 2], ['merge', 2], ['update', 2], ['find', 2], ['range', 2],
];
const TOTAL_WEIGHT = WEIGHTS.reduce((s, [, w]) => s + w, 0);
const MUTATIONS = new Set<OpName>(['insert', 'delete', 'upsert', 'merge', 'update']);

function pickOp(rng: () => number): OpName {
	let r = rng() * TOTAL_WEIGHT;
	for (const [name, w] of WEIGHTS) {
		if ((r -= w) < 0) return name;
	}
	return 'insert';	// unreachable (weights sum to TOTAL_WEIGHT); satisfies the type checker
}

// --- sorted-key model helpers (a sorted number[] kept in sync with the Map, so no per-op re-sort) ---

function lowerBound(arr: number[], x: number): number {
	let lo = 0, hi = arr.length;
	while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
	return lo;
}
function upperBound(arr: number[], x: number): number {
	let lo = 0, hi = arr.length;
	while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= x) lo = m + 1; else hi = m; }
	return lo;
}

function hasLocalRoot(tree: BTree<number, Entry>): boolean {
	return Boolean((tree as any)['_root']);
}

/** Number of node levels: 1 = single leaf root, 2 = root branch over leaves, 3 = root branch over branches. */
function levelsOf(tree: BTree<number, Entry>): number {
	let node: any = (tree as any)['_root'];
	let d = 1;
	while (node instanceof BranchNode) { d++; node = node.nodes[0]; }
	return d;
}

// The exact key set a range() yields, derived from the sorted model keys — mirrors src/b-tree.ts range()
// semantics (direction-dependent bound roles; an omitted bound is open; a crossed range yields nothing).
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
	const first = rng() < 0.85 ? new KeyBound(lcgInt(rng, 0, keyspace), rng() < 0.5) : undefined;
	const last = rng() < 0.85 ? new KeyBound(lcgInt(rng, 0, keyspace), rng() < 0.5) : undefined;
	return new KeyRange(first, last, rng() < 0.5);
}

/**
 * Apply one random op to `tree`, asserting its return value against the (model, keys) reference, and keep the
 * reference in sync on a mutation. Returns the op name so the caller knows whether to run the after-mutation
 * invariant checks. `mk` mints distinct, monotonically-increasing values so an updated value is always
 * distinguishable from the original.
 */
function driveOp(
	tree: BTree<number, Entry>,
	model: Map<number, Entry>,
	keys: number[],
	rng: () => number,
	keyspace: number,
	mk: (key: number) => Entry,
	ctx: string,
): OpName {
	const modelInsert = (k: number, e: Entry) => { keys.splice(lowerBound(keys, k), 0, k); model.set(k, e); };
	const modelDelete = (k: number) => { keys.splice(lowerBound(keys, k), 1); model.delete(k); };

	const op = pickOp(rng);
	switch (op) {
		case 'insert': {
			const key = lcgInt(rng, 0, keyspace);
			const present = model.has(key);
			const entry = mk(key);
			const path = tree.insert(entry);
			expect(path.on, `${ctx} insert(${key}) on-state (present=${present})`).to.equal(!present);
			if (!present) {
				expect(tree.at(path), `${ctx} inserted entry`).to.deep.equal(entry);
				modelInsert(key, entry);
			} else {
				expect(tree.get(key), `${ctx} rejected insert leaves original`).to.deep.equal(model.get(key));
			}
			break;
		}
		case 'delete': {
			const key = lcgInt(rng, 0, keyspace);
			const present = model.has(key);
			const ok = tree.deleteAt(tree.find(key));
			expect(ok, `${ctx} deleteAt(find(${key})) result (present=${present})`).to.equal(present);
			if (present) modelDelete(key);
			break;
		}
		case 'upsert': {
			const key = lcgInt(rng, 0, keyspace);
			const present = model.has(key);
			const entry = mk(key);
			const path = tree.upsert(entry);
			// on === true iff the key was ALREADY present; on === false iff new (inverse of insert's contract).
			expect(path.on, `${ctx} upsert(${key}) on-state (present=${present})`).to.equal(present);
			expect(tree.get(key), `${ctx} upsert stores the entry`).to.deep.equal(entry);
			if (present) model.set(key, entry);
			else modelInsert(key, entry);
			break;
		}
		case 'merge': {
			const key = lcgInt(rng, 0, keyspace);
			const present = model.has(key);
			const newEntry = mk(key);
			const [path, wasUpdate] = tree.merge(newEntry, existing => ({ key: existing.key, val: existing.val + newEntry.val }));
			expect(path.on, `${ctx} merge(${key}) always lands on`).to.be.true;
			expect(wasUpdate, `${ctx} merge(${key}) wasUpdate (present=${present})`).to.equal(present);
			if (present) {
				const combined: Entry = { key, val: model.get(key)!.val + newEntry.val };
				expect(tree.at(path), `${ctx} merge combined value`).to.deep.equal(combined);
				model.set(key, combined);
			} else {
				expect(tree.at(path), `${ctx} merge inserted value`).to.deep.equal(newEntry);
				modelInsert(key, newEntry);
			}
			break;
		}
		case 'update': {
			if (keys.length === 0) break;	// need a present key; updateAt on a crack throws (covered elsewhere)
			const oldKey = keys[lcgInt(rng, 0, keys.length)];
			const newKey = rng() < 0.4 ? oldKey : lcgInt(rng, 0, keyspace);
			const newEntry = mk(newKey);
			const [path, wasUpdate] = tree.updateAt(tree.find(oldKey), newEntry);
			if (newKey === oldKey) {
				expect(path.on, `${ctx} updateAt same-key ${oldKey} on`).to.be.true;
				expect(wasUpdate, `${ctx} same-key update reports wasUpdate=true`).to.be.true;
				expect(tree.at(path), `${ctx} same-key updated value`).to.deep.equal(newEntry);
				model.set(oldKey, newEntry);
			} else if (!model.has(newKey)) {
				expect(path.on, `${ctx} updateAt relocate ${oldKey}->${newKey} on`).to.be.true;
				expect(wasUpdate, `${ctx} relocation reports wasUpdate=false (an insert)`).to.be.false;
				expect(tree.at(path), `${ctx} relocated value`).to.deep.equal(newEntry);
				modelDelete(oldKey);
				modelInsert(newKey, newEntry);
			} else {
				// key changed onto a different present key: the insert half fails, nothing changes, old key stays.
				expect(path.on, `${ctx} updateAt conflict ${oldKey}->${newKey} leaves path off`).to.be.false;
				expect(wasUpdate, `${ctx} conflict reports wasUpdate=false`).to.be.false;
				expect(tree.get(oldKey), `${ctx} conflict leaves old key present`).to.deep.equal(model.get(oldKey));
				expect(tree.get(newKey), `${ctx} conflict leaves target untouched`).to.deep.equal(model.get(newKey));
			}
			break;
		}
		case 'find': {
			const probe = lcgInt(rng, 0, keyspace);
			const present = model.has(probe);
			const path = tree.find(probe);
			expect(path.on, `${ctx} find(${probe}).on (present=${present})`).to.equal(present);
			expect(tree.get(probe), `${ctx} get(${probe})`).to.deep.equal(present ? model.get(probe) : undefined);
			if (!present) {
				// From the crack: next lands on the next-greater key (or off the end); prior on the next-smaller.
				const ub = upperBound(keys, probe);
				const nextGreater = ub < keys.length ? keys[ub] : undefined;
				const lb = lowerBound(keys, probe);
				const prevSmaller = lb > 0 ? keys[lb - 1] : undefined;
				const nxt = tree.next(path);
				if (nextGreater === undefined) {
					expect(nxt.on, `${ctx} next past crack ${probe} has no successor`).to.be.false;
				} else {
					expect(nxt.on, `${ctx} next past crack ${probe} advances`).to.be.true;
					expect(tree.at(nxt)!.key, `${ctx} next from crack ${probe}`).to.equal(nextGreater);
				}
				const prv = tree.prior(path);
				if (prevSmaller === undefined) {
					expect(prv.on, `${ctx} prior from crack ${probe} has no predecessor`).to.be.false;
				} else {
					expect(prv.on, `${ctx} prior from crack ${probe} advances`).to.be.true;
					expect(tree.at(prv)!.key, `${ctx} prior from crack ${probe}`).to.equal(prevSmaller);
				}
			}
			break;
		}
		case 'range': {
			const range = randomRange(rng, keyspace);
			const expected = modelRange(keys, range);
			let j = 0;
			let bad = false;
			for (const k of tree.keys(range)) {
				if (j >= expected.length || k !== expected[j]) { bad = true; break; }
				j++;
			}
			if (bad || j !== expected.length) {
				expect([...tree.keys(range)], `${ctx} range ${JSON.stringify(range)}`).to.deep.equal(expected);
			}
			break;
		}
	}
	return op;
}

/** Structural floor + count + (optional) full ascending agreement of `tree` against its (model, keys). */
function checkAgree(tree: BTree<number, Entry>, model: Map<number, Entry>, keys: number[], doTraversal: boolean, ctx: string): void {
	if (hasLocalRoot(tree)) assertTreeInvariants(tree);	// unwritten COW child defers to base; its base validates that structure
	expect(tree.size, `${ctx} size vs model`).to.equal(model.size);
	expect(tree.getCount(), `${ctx} getCount() vs model`).to.equal(model.size);
	if (!doTraversal) return;
	// One aliasing-free ascending pass: compare key order to the sorted model and value to the model Map.
	let idx = 0;
	let mismatch = false;
	for (const e of tree.entries()) {
		const m = model.get(e.key);
		if (e.key !== keys[idx] || m === undefined || e.val !== m.val) { mismatch = true; break; }
		idx++;
	}
	if (mismatch || idx !== keys.length) {
		const treeEntries = [...tree.entries()];
		expect(treeEntries.map(e => e.key), `${ctx} ascending keys vs model`).to.deep.equal(keys);
		for (const e of treeEntries) {
			expect(e, `${ctx} entry for key ${e.key}`).to.deep.equal(model.get(e.key));
		}
		expect(treeEntries.length, `${ctx} entry count vs model`).to.equal(keys.length);
	}
}

function runForkSeed(cfg: { seed: number; keyspace: number; warmup: number }): void {
	const { seed, keyspace, warmup } = cfg;
	const tag = `[seed 0x${seed.toString(16)}]`;
	const rng = lcg(seed);

	let v = 0;	// running counter -> distinct, monotonically-increasing values
	const mk = (key: number): Entry => ({ key, val: v++ });

	// ---- Base model + tree ----
	const base = new BTree<number, Entry>(keyOf);
	const baseModel = new Map<number, Entry>();
	const baseKeys: number[] = [];	// ascending; parallel to baseModel's key set

	// Warmup: bulk-insert distinct keys so the base is genuinely multi-level from op 0 of the random stream.
	for (let k = 0; k < warmup; k++) {
		const entry = mk(k);
		expect(base.insert(entry).on, `${tag} warmup insert ${k}`).to.be.true;
		baseKeys.splice(lowerBound(baseKeys, k), 0, k);
		baseModel.set(k, entry);
	}
	checkAgree(base, baseModel, baseKeys, true, `${tag} base @warmup`);
	expect(levelsOf(base), `${tag} base must be multi-level after warmup`).to.be.greaterThanOrEqual(2);

	// ---- Phase 1: drive the base for PRE_OPS (no child exists yet, so mutating the base is safe) ----
	for (let i = 0; i < PRE_OPS; i++) {
		const op = driveOp(base, baseModel, baseKeys, rng, keyspace, mk, `${tag} base op${i}`);
		if (MUTATIONS.has(op)) checkAgree(base, baseModel, baseKeys, i % STRIDE === 0, `${tag} base @op${i}`);
	}
	checkAgree(base, baseModel, baseKeys, true, `${tag} base @fork`);

	// ---- Fork: derive the child; freeze the base's model as the fixed reference from here on ----
	const child = new BTree<number, Entry>(keyOf, undefined, base);
	const snap = snapshotBase(base);	// captured BEFORE any child write, for the ownership invariant
	// The child's independent model starts as a copy of the base's model at the fork point.
	const childModel = new Map<number, Entry>(Array.from(baseModel, ([k, e]) => [k, e]));
	const childKeys = [...baseKeys];
	// The base's model is now frozen: baseModel / baseKeys must not change again.
	const baseSizeAtFork = base.size;
	expect(child.size, `${tag} child count == base count at fork`).to.equal(baseSizeAtFork);
	checkAgree(child, childModel, childKeys, true, `${tag} child @fork`);

	// ---- Phase 2: drive the CHILD for POST_OPS; the base stays frozen and is re-verified alongside ----
	let childMutations = 0;
	for (let i = 0; i < POST_OPS; i++) {
		const op = driveOp(child, childModel, childKeys, rng, keyspace, mk, `${tag} child op${i}`);
		if (MUTATIONS.has(op)) {
			childMutations++;
			const heavy = i % STRIDE === 0;
			checkAgree(child, childModel, childKeys, heavy, `${tag} child @op${i}`);
			if (heavy) {
				// The child's spine is connected & base-disjoint, and the base is proven pristine (keys +
				// node identities) against the pre-fork snapshot...
				assertOwnershipInvariant(child, base, snap);
				// ...and the frozen base still matches its own fixed model, structurally and value-wise.
				checkAgree(base, baseModel, baseKeys, true, `${tag} base (frozen) @op${i}`);
			}
		}
	}

	// ---- Final exhaustive agreement for both trees, plus proof the fork actually diverged the two ----
	checkAgree(child, childModel, childKeys, true, `${tag} child @final`);
	assertOwnershipInvariant(child, base, snap);
	checkAgree(base, baseModel, baseKeys, true, `${tag} base (frozen) @final`);
	expect(childMutations, `${tag} the child was actually mutated after the fork`).to.be.greaterThan(0);
	expect(base.size, `${tag} base count never moved after the fork`).to.equal(baseSizeAtFork);
}

describe('Randomized COW-fork oracle (base + forked child vs independent models)', () => {
	for (const cfg of SEEDS) {
		it(`seed 0x${cfg.seed.toString(16)} (keyspace ${cfg.keyspace}): base ${PRE_OPS} ops, fork, child ${POST_OPS} ops — both match their own model`, function () {
			this.timeout(60000);
			runForkSeed(cfg);
		});
	}
});
