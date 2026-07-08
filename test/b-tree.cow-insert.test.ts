import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { BranchNode, ITreeNode } from '../src/nodes.js';
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt, shuffle } from './helpers/rng.js';

/**
 * Regression + property suite for copy-on-write INSERT splitting.
 *
 * A COW child tree — `new BTree(keyFn, cmp, base)` — inherits an immutable base and absorbs writes
 * copy-on-write. Inserting a key into a leaf that is *full* splits that leaf, and the split may
 * cascade up: each affected branch must be cloned into the child and the freshly-cloned child re-linked
 * rootward (`leafInsert` -> `mutableLeaf`, then `branchInsert` -> `mutableBranch` -> `replaceRootward`,
 * src/b-tree.ts). A full root branch splits into a brand-new root that must exist in the child only.
 *
 * This is the structural twin of the COW *delete* rebalance path (see test/b-tree.cow-delete.test.ts).
 * The delete fix turned on a bug in `replaceRootward`: when a freshly-cloned child had to be linked into
 * an *already-owned* ancestor, the link was dropped, orphaning the clone and leaving the owned ancestor
 * pointing at a stale base node — dropping/duplicating keys on iteration. The insert side runs the exact
 * same rootward re-linking, so the same class of bug can live here.
 *
 * Why not just append? Appending keys past the current maximum only ever splits the right-most leaf and
 * appends the new leaf at the end of the spine the child already cloned on the first write — it never
 * exercises "link a fresh clone into an ancestor the child *already owns* from an earlier, unrelated
 * write". That re-link path is the one the delete bug lived in. So the discriminating cases here insert
 * into INTERIOR regions and into MULTIPLE distinct regions / scattered keys, forcing independent clones
 * that must each be re-linked into the already-owned spine. (Front-anchored append/prepend appear only as
 * controls.) This mirrors why the delete suite uses non-front-anchored delete sets.
 *
 * NodeCapacity is 64; base sizes are chosen well above it to force genuinely multi-level trees, and one
 * case uses a near-full 2-level root so child inserts overflow and split it into a new root.
 */
describe('BTree COW insert splitting', () => {
	const idFn = (e: number): number => e;
	const cmp = (a: number, b: number): number => a - b;

	/** Depth of the subtree at `node` (0 = leaf, 1 = branch-over-leaves, ...). Used to prove a child root
	 * split actually deepened the child without deepening the base. */
	function depthOf(node: ITreeNode): number {
		let depth = 0;
		let n: ITreeNode | undefined = node;
		while (n instanceof BranchNode) {
			depth++;
			n = (n as BranchNode<number, any>).nodes[0];
		}
		return depth;
	}

	/** Number of children at the root branch (0 if the root is a leaf). A non-root branch split that does
	 * not deepen the tree manifests as the root gaining a child (the promoted half), so comparing this
	 * before/after — with depth held constant — proves an intermediate branch actually split. */
	function rootChildCount(tree: BTree<number, number>): number {
		const r = tree.root;
		return r instanceof BranchNode ? (r as BranchNode<number, any>).nodes.length : 0;
	}

	/** assertTreeInvariants needs a local root to validate; a COW child with no writes legitimately has
	 * none (it defers entirely to its base), so guard structural checks behind this. */
	function hasLocalRoot(tree: BTree<number, number>): boolean {
		return Boolean((tree as any)['_root']);
	}

	/**
	 * A multi-level base whose keys are spaced `stride` apart (`stride, 2*stride, ... count*stride`),
	 * leaving `stride - 1` insertable integer gaps between every pair of base keys (and `stride - 1`
	 * gaps below the minimum). COW inserts target those gaps so they land in interior, base-owned leaves.
	 * Returns the base and its ordered key list.
	 */
	function makeBase(count: number, stride: number): { base: BTree<number, number>; keys: number[] } {
		expect(count, 'count must exceed NodeCapacity to force a multi-level tree').to.be.greaterThan(NodeCapacity);
		const base = new BTree<number, number>(idFn, cmp);
		const keys: number[] = [];
		for (let i = 1; i <= count; i++) {
			const k = i * stride;
			expect(base.insert(k).on, `base insert ${k}`).to.equal(true);
			keys.push(k);
		}
		return { base, keys };
	}

	/** `n` consecutive *insertable* integers starting just above `startKey` (skips multiples of `stride`,
	 * which are base keys). A dense interior band — enough of these in one place forces leaf/branch splits. */
	function freshBlock(startKey: number, n: number, stride: number): number[] {
		const out: number[] = [];
		let k = startKey + 1;
		while (out.length < n) {
			if (k % stride !== 0) out.push(k);
			k++;
		}
		return out;
	}

	/** `n` distinct *insertable* keys scattered (seeded) across `[minKey, maxKey)`. Scatter forces splits in
	 * many different base-owned regions, so several independent clones must each re-link into the spine. */
	function scatteredFreshKeys(seed: number, n: number, minKey: number, maxKey: number, stride: number): number[] {
		const next = lcg(seed);
		const set = new Set<number>();
		while (set.size < n) {
			const k = lcgInt(next, minKey, maxKey);
			if (k % stride !== 0) set.add(k);
		}
		return [...set];
	}

	/** Collect ascending, asserting strictly-increasing & duplicate-free (catches phantom repeats / drops). */
	function collectAscending(tree: BTree<number, number>): number[] {
		const out: number[] = [];
		const path = tree.first();
		while (path.on) {
			const entry = tree.at(path);
			expect(entry, 'entry on a live ascending path').to.not.equal(undefined);
			if (out.length > 0) {
				expect(entry!, `strictly ascending after ${out[out.length - 1]}`).to.be.greaterThan(out[out.length - 1]);
			}
			out.push(entry!);
			tree.moveNext(path);
		}
		return out;
	}

	/** Collect descending, asserting strictly-decreasing & duplicate-free. Returned ascending for easy compare. */
	function collectDescending(tree: BTree<number, number>): number[] {
		const out: number[] = [];
		const path = tree.last();
		while (path.on) {
			const entry = tree.at(path);
			expect(entry, 'entry on a live descending path').to.not.equal(undefined);
			if (out.length > 0) {
				expect(entry!, `strictly descending after ${out[out.length - 1]}`).to.be.lessThan(out[out.length - 1]);
			}
			out.push(entry!);
			tree.movePrior(path);
		}
		return out.reverse();
	}

	/** Both iteration directions must agree on the exact same ordered set. */
	function liveSet(tree: BTree<number, number>): number[] {
		const asc = collectAscending(tree);
		const desc = collectDescending(tree);
		expect(desc, 'descending iteration agrees with ascending').to.deep.equal(asc);
		return asc;
	}

	/** Insert every key into the COW child, asserting each is absent first and inserts cleanly. */
	function insertAll(cow: BTree<number, number>, keys: number[]): void {
		for (const k of keys) {
			expect(cow.find(k).on, `key ${k} absent before insert`).to.equal(false);
			expect(cow.insert(k).on, `insert ${k}`).to.equal(true);
		}
	}

	/**
	 * Run one insert set against a fresh COW child over a `(count, stride)` base:
	 *   - every inserted key was absent and inserts cleanly,
	 *   - the live set (both directions) is exactly base ∪ inserts, point lookups agree,
	 *   - the child is structurally well-formed and its mutable spine is connected & base-disjoint,
	 *   - the base is byte-for-byte untouched.
	 * When `expectChildDeeperThanBase`, also asserts the child root split deeper than the base (root split).
	 * When `expectNonRootBranchSplit`, asserts an *intermediate* (non-root) branch split occurred: the tree
	 * depth is unchanged but the root gained a child (the promoted half of the split branch).
	 */
	function checkInsertScenario(
		count: number,
		stride: number,
		insertKeys: number[],
		opts: { expectChildDeeperThanBase?: boolean; expectNonRootBranchSplit?: boolean } = {},
	): { base: BTree<number, number>; cow: BTree<number, number> } {
		const { base, keys } = makeBase(count, stride);
		const baseSet = new Set(keys);
		expect(new Set(insertKeys).size, 'insert keys are unique').to.equal(insertKeys.length);
		for (const k of insertKeys) {
			expect(baseSet.has(k), `insert key ${k} must be absent from base`).to.equal(false);
		}

		const cow = new BTree<number, number>(idFn, cmp, base);
		const snap = snapshotBase(base);	// capture base before any COW write, for the ownership invariant
		const baseDepth = depthOf(base.root);
		const baseRootChildren = rootChildCount(base);

		insertAll(cow, insertKeys);

		const expected = [...keys, ...insertKeys].sort(cmp);
		const live = liveSet(cow);
		expect(live.length, 'count == base + inserts').to.equal(keys.length + insertKeys.length);
		expect(live, 'live set is exactly base ∪ inserts').to.deep.equal(expected);

		// Point lookups agree: inserted keys present with their own value, a spot-check of base keys intact.
		for (const k of insertKeys) {
			expect(cow.get(k), `cow.get(${k}) (inserted)`).to.equal(k);
		}
		for (let i = 0; i < keys.length; i += Math.max(1, Math.floor(keys.length / 50))) {
			expect(cow.get(keys[i]), `cow.get(${keys[i]}) (base)`).to.equal(keys[i]);
		}

		// Additive structural/ownership cross-checks (never weaken the functional assertions above):
		// the child is internally well-formed and its mutable spine is connected & base-disjoint,
		// with the base proven pristine against the pre-insert snapshot.
		assertTreeInvariants(cow);
		assertOwnershipInvariant(cow, base, snap);

		// The inherited base must be unmodified by the COW child's inserts.
		expect(liveSet(base), 'base tree unaffected by COW inserts').to.deep.equal(keys);

		if (opts.expectChildDeeperThanBase) {
			expect(depthOf(cow.root), 'child root split deeper than the base').to.be.greaterThan(baseDepth);
			expect(depthOf(base.root), 'base depth unchanged by child split').to.equal(baseDepth);
			expect(cow.root.owner, 'child owns its (split) root').to.equal(cow.owner);
		}

		if (opts.expectNonRootBranchSplit) {
			// A non-root branch split promotes one half up to the parent without deepening the tree, so the
			// depth is unchanged while the root gains a child. If this assertion ever fails, the chosen sizes
			// stopped exercising the `branchInsert` -> split -> propagate path on an intermediate branch.
			expect(depthOf(cow.root), 'tree depth unchanged (split stayed below the root)').to.equal(baseDepth);
			expect(rootChildCount(cow), 'an intermediate branch split pushed a new child up to the root')
				.to.be.greaterThan(baseRootChildren);
		}

		return { base, cow };
	}

	describe('leaf splits in base-owned regions', () => {
		// A dense block of inserts in one interior gap region overflows the base-owned leaf that covers it,
		// forcing a leaf split. The child must clone that leaf AND its branch ancestors up to the root.
		it('a dense interior block splits a base-owned leaf and clones its branch ancestors', () => {
			checkInsertScenario(200, 100, freshBlock(10000, 120, 100));
		});

		it('a wider interior band spanning several base-owned leaves', () => {
			checkInsertScenario(200, 100, freshBlock(5000, 400, 100));
		});

		it('a near-tail interior band (just below the maximum, but not an append)', () => {
			checkInsertScenario(200, 100, freshBlock(19000, 90, 100));
		});
	});

	describe('branch and root splits cascade into the child only', () => {
		// A near-full 2-level base (~62 root children): a dense interior block adds enough new leaves to
		// overflow the *cloned* root branch, splitting it and creating a NEW ROOT that lives in the child
		// only. The base must stay 2-level and untouched.
		it('root split: a near-full 2-level base gains a new, deeper root owned by the child', () => {
			checkInsertScenario(2000, 100, freshBlock(100000, 600, 100), { expectChildDeeperThanBase: true });
		});

		// A 3-level base: a dense interior block cascades leaf splits up into an intermediate branch, forcing
		// a non-root branch split (the `branchInsert` -> split -> propagate path) without disturbing the base.
		// The 1500-key block concentrated in one intermediate branch's region pushes its child count past
		// NodeCapacity, so it splits and promotes a child to the (still 2-child) root — depth stays 2.
		// `expectNonRootBranchSplit` hard-asserts that split actually happened (root child count grew, depth
		// unchanged), so the case cannot silently stop exercising the path it is named for.
		it('branch split: inserts cascade up a 3-level base while it stays pristine', () => {
			checkInsertScenario(2100, 100, freshBlock(120000, 1500, 100), { expectNonRootBranchSplit: true });
		});
	});

	describe('multiple distinct regions clone independently', () => {
		// Insert dense blocks into several well-separated interior regions. After the first region the child
		// owns its root; every later region must re-link its fresh clones into that ALREADY-OWNED spine — the
		// exact re-link path the COW bug lived in. Invariants + base-pristine are re-checked after each region.
		it('several separated interior regions each clone and re-link into the owned spine', () => {
			const { base, keys } = makeBase(400, 100);	// keys 100..40000, 2-level
			const cow = new BTree<number, number>(idFn, cmp, base);
			const snap = snapshotBase(base);
			const baseSet = new Set(keys);

			const regionStarts = [2000, 12000, 22000, 32000];	// interior base keys, well separated
			const inserted: number[] = [];
			for (const start of regionStarts) {
				const block = freshBlock(start, 90, 100);
				for (const k of block) {
					expect(baseSet.has(k), `region key ${k} absent from base`).to.equal(false);
					expect(cow.insert(k).on, `insert ${k}`).to.equal(true);
					inserted.push(k);
				}
				// After each region the child is well-formed, its spine connected & base-disjoint, base pristine.
				assertTreeInvariants(cow);
				assertOwnershipInvariant(cow, base, snap);
				expect(liveSet(base), `base pristine after region @${start}`).to.deep.equal(keys);
			}

			expect(liveSet(cow), 'final live set is base ∪ all inserted regions')
				.to.deep.equal([...keys, ...inserted].sort(cmp));
		});
	});

	describe('non-front-anchored insert sets', () => {
		it('interior band (single contiguous gap region) inserts correctly', () => {
			checkInsertScenario(300, 100, freshBlock(15000, 250, 100));
		});

		it('scattered seeded keys spread across the whole key domain', () => {
			// Scatter across [1, 30000): forces splits in many independent base-owned regions at once.
			checkInsertScenario(300, 100, scatteredFreshKeys(0xC0FFEE, 300, 1, 30000, 100));
		});

		it('a second scattered seed (different stream) over a larger child', () => {
			checkInsertScenario(300, 100, scatteredFreshKeys(0x9E3779B1, 500, 1, 30000, 100));
		});

		// Controls: the easy, front-anchored paths must of course still work — they just don't exercise the
		// re-link-into-owned-ancestor case that the interior/scattered cases above do.
		it('control: a pure append block (keys above the maximum) still inserts correctly', () => {
			checkInsertScenario(200, 100, freshBlock(20000, 200, 100));	// 20000 is the base max; all keys above it
		});

		it('control: a pure prepend block (keys below the minimum) still inserts correctly', () => {
			// Base min is 100; keys 1..99 sit below every base key.
			checkInsertScenario(200, 100, [1, 7, 13, 23, 31, 42, 53, 64, 75, 86, 97]);
		});
	});

	describe('per-step iteration integrity', () => {
		// A single re-link error only surfaces under a specific split timing, and a forward-only check can miss
		// a phantom-repeated key. Inserting one key at a time in scattered order and re-verifying the FULL
		// ordered set (both directions) after every single insert pins down the exact structural transition
		// that breaks.
		it('full ordered set stays correct after every individual insert (scattered order)', () => {
			const { base, keys } = makeBase(200, 100);	// keys 100..20000
			const cow = new BTree<number, number>(idFn, cmp, base);
			const snap = snapshotBase(base);

			// Scattered fresh keys (some below the base min, some interior), shuffled so each insert hits a
			// different structural spot.
			const fresh = scatteredFreshKeys(0xABCDEF, 160, 1, 20000, 100);
			const order = shuffle(fresh, lcg(0x13579));

			const present = new Set(keys);
			for (const k of order) {
				expect(cow.insert(k).on, `insert ${k}`).to.equal(true);
				present.add(k);

				const expected = [...present].sort(cmp);
				expect(liveSet(cow), `ordered set after inserting ${k}`).to.deep.equal(expected);
				// Ownership stays intact at every structural transition (base proven pristine vs snapshot).
				assertOwnershipInvariant(cow, base, snap);
			}

			assertTreeInvariants(cow);
			expect(liveSet(base), 'base untouched through the whole sequence').to.deep.equal(keys);
		});
	});

	describe('multi-level inheritance', () => {
		// base -> mid (COW of base) -> leaf (COW of mid). An interior insert on the grandchild must isolate
		// both ancestors, even when the split clones leaves/branches still owned by an ancestor. Mirrors the
		// delete suite's `multi-level inheritance` block, on the insert path.
		it('insert on a grandchild leaves base and mid intact', () => {
			const { base, keys } = makeBase(300, 100);	// keys 100..30000
			const baseSnap = snapshotBase(base);

			const mid = new BTree<number, number>(idFn, cmp, base);
			// A few mid-level inserts so mid owns some nodes but inherits others (all fresh, interior gaps).
			const midInserts = [550, 15050, 25050];
			for (const k of midInserts) expect(mid.insert(k).on, `mid insert ${k}`).to.equal(true);
			const midExpected = [...keys, ...midInserts].sort(cmp);
			expect(liveSet(mid), 'mid state after its own inserts').to.deep.equal(midExpected);
			assertTreeInvariants(mid);
			assertOwnershipInvariant(mid, base, baseSnap);	// mid's spine owns rootward; base pristine
			const midSnap = snapshotBase(mid);

			const leaf = new BTree<number, number>(idFn, cmp, mid);
			// A dense interior band on the grandchild — forces leaf/branch clones through mid into base.
			const band = freshBlock(10000, 140, 100);
			for (const k of band) expect(leaf.insert(k).on, `leaf insert ${k}`).to.equal(true);
			const leafExpected = [...midExpected, ...band].sort(cmp);
			expect(liveSet(leaf), 'leaf surviving set').to.deep.equal(leafExpected);
			// The grandchild is well-formed and its spine is connected through mid (its immediate base), which
			// in turn stays connected over base — every level isolated, both ancestors pristine.
			assertTreeInvariants(leaf);
			assertOwnershipInvariant(leaf, mid, midSnap);
			assertOwnershipInvariant(mid, base, baseSnap);

			// Ancestors unaffected.
			expect(liveSet(mid), 'mid unaffected by grandchild inserts').to.deep.equal(midExpected);
			expect(liveSet(base), 'base unaffected by grandchild inserts').to.deep.equal(keys);
		});
	});

	describe('randomized differential (insert-heavy) vs. reference model', () => {
		// Mixed insert/delete on a COW child, checked against a shadow Set after each sampled op for exact set
		// equality plus the strictly-ordered/unique invariant in both directions. Insert-weighted to stress the
		// split / rootward re-link path this suite targets, while the churn keeps the tree genuinely multi-level.
		it('matches a shadow set over a long randomized op stream while base stays pristine', () => {
			const OPS = 4000;
			const STRIDE = 50;
			const COUNT = 300;
			const MAX_KEY = COUNT * STRIDE;	// base keys are 50..15000

			const { base, keys } = makeBase(COUNT, STRIDE);
			const baseSnapshot = [...keys];
			const cow = new BTree<number, number>(idFn, cmp, base);
			const snap = snapshotBase(base);
			const shadow = new Set<number>(keys);

			const next = lcg(0x5EED1234);
			for (let op = 0; op < OPS; op++) {
				const key = lcgInt(next, 1, MAX_KEY + 1);
				const roll = lcgInt(next, 0, 100);
				const path = cow.find(key);

				if (roll < 70) {
					// INSERT (70%) — the path under test.
					if (!path.on) {
						expect(cow.insert(key).on, `insert ${key} @op${op}`).to.equal(true);
						shadow.add(key);
					} else {
						expect(shadow.has(key), `present key ${key} in shadow @op${op}`).to.equal(true);
					}
				} else {
					// DELETE (30%) — keeps the tree churning so inserts keep hitting fresh structural spots.
					if (path.on) {
						expect(cow.deleteAt(path), `deleteAt ${key} @op${op}`).to.equal(true);
						shadow.delete(key);
					} else {
						expect(shadow.has(key), `absent key ${key} not in shadow @op${op}`).to.equal(false);
					}
				}

				// Spot-check structural integrity periodically (full O(n) scan is too slow every op).
				if (op % 200 === 0 || op === OPS - 1) {
					const expected = [...shadow].sort(cmp);
					expect(liveSet(cow), `live set matches shadow @op${op}`).to.deep.equal(expected);
					expect(collectAscending(base), `base pristine @op${op}`).to.deep.equal(baseSnapshot);
					// Structural + ownership invariants at the sampling interval (base proven pristine vs snapshot).
					if (hasLocalRoot(cow)) assertTreeInvariants(cow);
					assertOwnershipInvariant(cow, base, snap);
				}
			}

			expect(liveSet(cow), 'final live set matches shadow').to.deep.equal([...shadow].sort(cmp));
			expect(collectAscending(base), 'base pristine at end').to.deep.equal(baseSnapshot);
		});
	});
});
