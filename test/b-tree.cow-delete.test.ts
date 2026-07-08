import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt, shuffle } from './helpers/rng.js';

/**
 * Regression + property suite for copy-on-write DELETE rebalancing.
 *
 * A COW child tree — `new BTree(keyFn, cmp, { base })` — inherits an immutable base and
 * absorbs writes copy-on-write. Deleting a key that triggers a sibling *borrow* or
 * *merge* during rebalance must clone the affected sibling/parent into the child and
 * re-link the clone rootward. Two bugs broke this:
 *
 *   1. `replaceRootward` returned without linking the freshly-cloned child into an
 *      already-owned ancestor, orphaning the clone — the owned ancestor kept pointing
 *      at the stale base node.
 *   2. the cloned sibling path failed to shift its parent-slot index by the borrow/merge
 *      delta, so the wrong slot was made mutable. (That index-shift now lives inlined in
 *      `mutableLeaf`'s sibling form; the old `leafSibPath` helper was removed.)
 *
 * Either bug drops deletions and/or produces phantom-repeated keys on iteration.
 * Deleting the leftmost leaf only ever borrows/merges with a *right* sibling, which
 * dodges the bug — so a front-anchored `id <= k` delete passes even on a broken tree.
 * The predicate cases here therefore use NON-front-anchored delete sets.
 *
 * NodeCapacity is 64; sizes are chosen well above it to force multi-level trees whose
 * deletes provoke real structural rebalancing.
 */
describe('BTree COW delete rebalancing', () => {
	const idFn = (e: number): number => e;
	const cmp = (a: number, b: number): number => a - b;

	function range(lo: number, hi: number): number[] {
		const out: number[] = [];
		for (let i = lo; i <= hi; i++) out.push(i);
		return out;
	}

	/** assertTreeInvariants needs a local root to validate; a COW child with no writes legitimately
	 * has none (it defers entirely to its base), so guard structural checks behind this. */
	function hasLocalRoot(tree: BTree<number, number>): boolean {
		return Boolean((tree as any)['_root']);
	}

	/** A base tree filled 1..n and a COW child inheriting it (the consumer's layering shape). */
	function makeCow(n: number): { base: BTree<number, number>; cow: BTree<number, number> } {
		expect(n, 'n must exceed NodeCapacity to force a multi-level tree').to.be.greaterThan(NodeCapacity);
		const base = new BTree<number, number>(idFn, cmp);
		for (let i = 1; i <= n; i++) {
			expect(base.insert(i).on, `base insert ${i}`).to.equal(true);
		}
		const cow = new BTree<number, number>(idFn, cmp, { base });
		return { base, cow };
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

	/** Delete every key in [1..n] matching `pred` from the COW tree; each must be present and deletable. */
	function deleteWhere(cow: BTree<number, number>, n: number, pred: (k: number) => boolean): number {
		let deleted = 0;
		for (let i = 1; i <= n; i++) {
			if (!pred(i)) continue;
			const path = cow.find(i);
			expect(path.on, `key ${i} present before delete`).to.equal(true);
			expect(cow.deleteAt(path), `deleteAt ${i}`).to.equal(true);
			deleted++;
		}
		return deleted;
	}

	/** Run one predicate against a fresh COW tree: matched == deleted, survivors == complement, base untouched. */
	function checkPredicate(n: number, pred: (k: number) => boolean): void {
		const { base, cow } = makeCow(n);
		const snap = snapshotBase(base);	// capture base before any COW writes, for the ownership invariant
		const expected = range(1, n).filter(k => !pred(k));
		const matched = range(1, n).filter(pred).length;

		const deleted = deleteWhere(cow, n, pred);
		expect(deleted, 'matched == deleted').to.equal(matched);

		const remaining = liveSet(cow);
		expect(remaining.length, 'remaining count == n - deleted').to.equal(n - deleted);
		expect(remaining, 'surviving set is exactly the complement').to.deep.equal(expected);

		// Point lookups agree: deleted keys gone, survivors intact.
		for (let i = 1; i <= n; i++) {
			expect(cow.get(i), `cow.get(${i})`).to.equal(pred(i) ? undefined : i);
		}

		// Additive structural/ownership cross-checks (never weaken the functional assertions above):
		// the COW child is internally well-formed and its mutable spine is connected & base-disjoint,
		// with the base proven pristine against the pre-delete snapshot.
		if (deleted > 0) {	// a no-op predicate leaves the child deferring to base (no local root to validate)
			assertTreeInvariants(cow);
		}
		assertOwnershipInvariant(cow, base, snap);

		// The inherited base must be unmodified by the COW child's deletes.
		expect(liveSet(base), 'base tree unaffected by COW deletes').to.deep.equal(range(1, n));
	}

	describe('non-front-anchored predicate deletes', () => {
		it('tail predicate (id > 100) deletes every matching key', () => {
			checkPredicate(200, k => k > 100);
		});

		it('between predicate (51..150) deletes an interior band', () => {
			checkPredicate(200, k => k >= 51 && k <= 150);
		});

		it('interleaved predicate (id % 2 == 0) deletes every other key', () => {
			checkPredicate(200, k => k % 2 === 0);
		});

		it('sparse interleaved predicate (id % 3 == 0) over a larger tree', () => {
			checkPredicate(400, k => k % 3 === 0);
		});

		it('a pseudo-random non-contiguous key set', () => {
			const next = lcg(12345);
			const drop = new Set<number>();
			for (let i = 0; i < 70; i++) drop.add(lcgInt(next, 1, 201));
			checkPredicate(200, k => drop.has(k));
		});

		it('a high-edge tail (only the last leaf-ish slice)', () => {
			checkPredicate(200, k => k > 190);
		});

		it('control: front-anchored prefix (id <= 100) still deletes correctly', () => {
			checkPredicate(200, k => k <= 100);
		});

		it('control: empty predicate is a no-op leaving all rows', () => {
			checkPredicate(200, () => false);
		});
	});

	describe('per-step iteration integrity', () => {
		// The original corruption only surfaced under specific borrow/merge timing, and a
		// forward-only get() check can miss a phantom-repeated key. Deleting one key at a
		// time and re-verifying the FULL ordered set after every single delete pins down the
		// exact structural transition that breaks, in both iteration directions.
		it('full ordered set stays correct after every individual delete (scattered order)', () => {
			const n = 200;
			const { base, cow } = makeCow(n);
			const snap = snapshotBase(base);

			// Scattered deletion order so each delete hits a different structural spot.
			const order = shuffle(range(1, n), lcg(98765));

			const survivors = new Set(range(1, n));
			for (const k of order) {
				const path = cow.find(k);
				expect(path.on, `key ${k} present before delete`).to.equal(true);
				expect(cow.deleteAt(path), `deleteAt ${k}`).to.equal(true);
				survivors.delete(k);

				const expected = [...survivors].sort(cmp);
				expect(liveSet(cow), `ordered set after deleting ${k}`).to.deep.equal(expected);
				// Ownership stays intact at every structural transition (base proven pristine vs snapshot).
				assertOwnershipInvariant(cow, base, snap);
			}

			expect(liveSet(cow), 'tree empties out cleanly').to.deep.equal([]);
			expect(liveSet(base), 'base untouched through the whole sequence').to.deep.equal(range(1, n));
		});
	});

	describe('cascading rebalance to empty', () => {
		// Deleting down to a single key, then to empty, forces merges to cascade up every
		// level — the heaviest COW re-linking path.
		it('deletes interior-first down to one survivor, then empty', () => {
			const n = 150;
			const { base, cow } = makeCow(n);
			const snap = snapshotBase(base);

			// Delete everything except the median, interior keys first (never the leftmost leaf head).
			const keep = 75;
			for (const k of range(2, n)) {
				if (k === keep) continue;
				expect(cow.deleteAt(cow.find(k)), `deleteAt ${k}`).to.equal(true);
			}
			// Now only key 1 and key 75 remain.
			expect(liveSet(cow), 'two survivors').to.deep.equal([1, keep]);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);

			expect(cow.deleteAt(cow.find(keep)), 'delete survivor 75').to.equal(true);
			expect(liveSet(cow), 'one survivor').to.deep.equal([1]);
			expect(cow.deleteAt(cow.find(1)), 'delete last').to.equal(true);
			expect(liveSet(cow), 'empty').to.deep.equal([]);
			// Drained to empty: the child still owns a (now-empty) root and the base is untouched.
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);

			expect(liveSet(base), 'base untouched by full drain').to.deep.equal(range(1, n));
		});
	});

	describe('multi-level inheritance', () => {
		// base -> mid (COW of base) -> leaf (COW of mid). A non-front-anchored delete on the
		// leaf must isolate both ancestors, even when the borrowed/merged sibling is still
		// owned by an ancestor rather than the leaf tree.
		it('delete on a grandchild leaves base and mid intact', () => {
			const n = 200;
			const base = new BTree<number, number>(idFn, cmp);
			for (let i = 1; i <= n; i++) base.insert(i);
			const baseSnap = snapshotBase(base);

			const mid = new BTree<number, number>(idFn, cmp, { base });
			// A few mid-level writes so mid owns some nodes but inherits others.
			for (const k of [60, 120, 180]) expect(mid.deleteAt(mid.find(k)), `mid delete ${k}`).to.equal(true);
			const midExpected = range(1, n).filter(k => ![60, 120, 180].includes(k));
			expect(liveSet(mid), 'mid state after its own deletes').to.deep.equal(midExpected);
			assertTreeInvariants(mid);
			assertOwnershipInvariant(mid, base, baseSnap);	// mid's spine owns rootward; base pristine
			const midSnap = snapshotBase(mid);

			const leaf = new BTree<number, number>(idFn, cmp, { base: mid });
			// Non-front-anchored band delete on the grandchild — only keys actually present in
			// mid (60/120 were already removed a level up, so they are legitimately absent here).
			const band = (k: number) => k >= 51 && k <= 150;
			const toDelete = midExpected.filter(band);
			for (const k of toDelete) {
				expect(leaf.deleteAt(leaf.find(k)), `leaf deleteAt ${k}`).to.equal(true);
			}
			const leafExpected = midExpected.filter(k => !band(k));
			expect(liveSet(leaf), 'leaf surviving set').to.deep.equal(leafExpected);
			// The grandchild is well-formed and its spine is connected through mid (its immediate base),
			// which in turn stays connected over base — every level isolated, both ancestors pristine.
			assertTreeInvariants(leaf);
			assertOwnershipInvariant(leaf, mid, midSnap);
			assertOwnershipInvariant(mid, base, baseSnap);

			// Ancestors unaffected.
			expect(liveSet(mid), 'mid unaffected by grandchild deletes').to.deep.equal(midExpected);
			expect(liveSet(base), 'base unaffected by grandchild deletes').to.deep.equal(range(1, n));
		});
	});

	describe('randomized differential (delete-heavy) vs. reference model', () => {
		// Mixed insert/delete on a COW child, checked against a shadow Set after each op for
		// exact set equality plus the strictly-ordered/unique invariant in both directions.
		// Delete-weighted to stress the rebalance path that the COW bug lived in.
		it('matches a shadow set over a long randomized op stream while base stays pristine', () => {
			const INITIAL = 300;
			const OPS = 4000;
			const MAX_KEY = 600;

			const base = new BTree<number, number>(idFn, cmp);
			for (let i = 1; i <= INITIAL; i++) base.insert(i);
			const baseSnapshot = range(1, INITIAL);

			const cow = new BTree<number, number>(idFn, cmp, { base });
			const snap = snapshotBase(base);
			const shadow = new Set<number>(baseSnapshot);

			const next = lcg(0xC0FFEE);
			for (let op = 0; op < OPS; op++) {
				const key = lcgInt(next, 1, MAX_KEY + 1);
				const roll = lcgInt(next, 0, 100);
				const path = cow.find(key);

				if (roll < 60) {
					// DELETE (60%) — the path under test.
					if (path.on) {
						expect(cow.deleteAt(path), `deleteAt ${key} @op${op}`).to.equal(true);
						shadow.delete(key);
					} else {
						expect(shadow.has(key), `absent key ${key} not in shadow @op${op}`).to.equal(false);
					}
				} else {
					// INSERT (40%).
					if (!path.on) {
						expect(cow.insert(key).on, `insert ${key} @op${op}`).to.equal(true);
						shadow.add(key);
					} else {
						expect(shadow.has(key), `present key ${key} in shadow @op${op}`).to.equal(true);
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
