import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { BranchNode, ITreeNode, LeafNode } from '../src/nodes.js';
import {
	assertTreeInvariants,
	assertOwnershipInvariant,
	snapshotBase,
	reachableNodesOf,
	sharedReachableNodes,
} from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

/**
 * COW × the capabilities the upstream Digitree v1.5.0 merge added — pinned where they INTERSECT the
 * copy-on-write (COW) inheritance layer. The individual features already have their own suites
 * (test/b-tree.bulk-load.test.ts, test/b-tree.count.test.ts, test/b-tree.options.test.ts,
 * test/b-tree.path-invalidation.test.ts) and COW has its own (test/cow.test.ts,
 * test/b-tree.cow-*.test.ts) — but none exercises the two together, and each intersection has a concrete
 * way to silently regress:
 *
 *   - buildFrom base: bulk-loaded nodes are owner-stamped by the loader (src/b-tree.ts). If a regression
 *     stamped them wrong, a derived child would think it already owns the shared nodes and mutate them in
 *     place — disabling COW cloning and corrupting the base. Proven here by deriving a child from a
 *     bulk-loaded base and asserting the child clones a private spine while the base stays byte-for-byte.
 *   - clear() on a derived child: the merge decided clear() DROPS the base (an empty tree inherits nothing)
 *     and installs a fresh empty root — so unlike clearBase() it leaves NO node shared with the former base.
 *   - counts on children: a child starts at its base's O(1) stored count and tracks its own delta
 *     (src/b-tree.ts constructor + internalInsertAt/internalDelete). Pinned after derive, after child
 *     insert/delete, and through a base -> c1 -> c2 chain, each independent.
 *   - freeze:false via the 4-argument constructor `new BTree(k, c, base, { freeze:false })`: the
 *     options-after-base overload the merge introduced has no direct test. Pinned to actually take effect
 *     (a child written with it stores unfrozen entries; a sibling built without it freezes) and to still
 *     COW-clone correctly.
 *   - delete-while-iterating on a child: deleteAt re-stamps the path it is given (src/b-tree.ts) so a
 *     following moveNext advances with no re-find. On a COW child that path is ALSO remapped onto the
 *     freshly-cloned nodes (mutableLeaf -> path.remap, src/b-tree.ts) — so the re-stamp lands on the
 *     remapped path. Pinned across a clone boundary.
 *
 * NodeCapacity is 64; every base is built well above it so the trees are genuinely multi-level and the
 * split/rebalance/clone paths are real. Every mutating case re-checks functional correctness (the live set
 * in BOTH directions), structural well-formedness (assertTreeInvariants), a connected & base-disjoint
 * mutable spine (assertOwnershipInvariant), and the base proven pristine.
 */
describe('BTree COW × merged tree capabilities', () => {
	interface Entry {
		id: number;
		value: string;
		tag: string;
	}

	const keyOf = (e: Entry): number => e.id;
	const cmp = (a: number, b: number): number => a - b;
	const byId = (a: Entry, b: Entry): number => a.id - b.id;

	// --- structural probes (mirror the other COW suites) ---

	/** assertTreeInvariants needs a local root; an unwritten COW child legitimately has none (it defers to
	 * its base), so guard structural checks behind this. */
	function hasLocalRoot(tree: BTree<number, Entry>): boolean {
		return Boolean((tree as any)['_root']);
	}

	/** The base pointer a child derives from (undefined for a standalone or detached tree). */
	function baseOf(tree: BTree<number, Entry>): BTree<number, Entry> | undefined {
		return (tree as any)['base'];
	}

	/** Replicates BTree.indexOfKey: the child slot a key descends into (partition[i] = min key of nodes[i+1]). */
	function childIndex(partitions: number[], key: number): number {
		let lo = 0;
		let hi = partitions.length - 1;
		while (lo <= hi) {
			const split = (lo + hi) >>> 1;
			const result = cmp(key, partitions[split]);
			if (result === 0) return split + 1;
			else if (result < 0) hi = split - 1;
			else lo = split + 1;
		}
		return lo;
	}

	/** The leaf a key routes to, descending from a tree's effective root (falls through to the base for an
	 * unwritten child). */
	function leafForKey(tree: BTree<number, Entry>, key: number): LeafNode<Entry> {
		let node: ITreeNode = tree.root;
		while (node instanceof BranchNode) {
			const b = node as BranchNode<number, any>;
			node = b.nodes[childIndex(b.partitions, key)];
		}
		return node as LeafNode<Entry>;
	}

	// --- ordered-iteration collectors (both directions, strict order asserted) ---

	function collectAscending(tree: BTree<number, Entry>): Entry[] {
		const out: Entry[] = [];
		const path = tree.first();
		while (path.on) {
			const entry = tree.at(path)!;
			if (out.length > 0) expect(entry.id, `strictly ascending after ${out[out.length - 1].id}`).to.be.greaterThan(out[out.length - 1].id);
			out.push(entry);
			tree.moveNext(path);
		}
		return out;
	}

	function collectDescending(tree: BTree<number, Entry>): Entry[] {
		const out: Entry[] = [];
		const path = tree.last();
		while (path.on) {
			out.push(tree.at(path)!);
			tree.movePrior(path);
		}
		return out.reverse();
	}

	/** Both iteration directions must agree on the exact same ordered entry list. */
	function liveSet(tree: BTree<number, Entry>): Entry[] {
		const asc = collectAscending(tree);
		const desc = collectDescending(tree);
		expect(desc, 'descending iteration agrees with ascending').to.deep.equal(asc);
		return asc;
	}

	function liveIds(tree: BTree<number, Entry>): number[] {
		return liveSet(tree).map(keyOf);
	}

	/** Ground-truth count via a full public traversal (never the stored O(1) count). */
	function walkCount(tree: BTree<number, Entry>): number {
		let n = 0;
		for (const _ of tree.entries()) n++;
		return n;
	}

	// --- base builders ---

	/** A genuinely multi-level, insert-built base with ids `stride, 2*stride, ..., count*stride`, leaving
	 * `stride - 1` integer gaps between consecutive base keys for fresh interior inserts. */
	function makeInsertBase(count: number, stride: number): { base: BTree<number, Entry>; ids: number[]; entries: Entry[] } {
		expect(count, 'count must exceed NodeCapacity to force a multi-level tree').to.be.greaterThan(NodeCapacity);
		const base = new BTree<number, Entry>(keyOf, cmp);
		const ids: number[] = [];
		const entries: Entry[] = [];
		for (let i = 1; i <= count; i++) {
			const id = i * stride;
			const e: Entry = { id, value: `base_${id}`, tag: 'base' };
			expect(base.insert(e).on, `base insert ${id}`).to.equal(true);
			ids.push(id);
			entries.push({ ...e });
		}
		assertTreeInvariants(base);
		return { base, ids, entries };
	}

	/** Already-sorted rows for a bulk load (same id spacing as makeInsertBase). */
	function sortedRows(count: number, stride: number): Entry[] {
		return Array.from({ length: count }, (_, i) => {
			const id = (i + 1) * stride;
			return { id, value: `base_${id}`, tag: 'base' };
		});
	}

	// =============================================================================================
	// 1. COW over a buildFrom (bulk-loaded) base
	// =============================================================================================
	describe('COW over a buildFrom (bulk-loaded) base', () => {
		it('derives a child from a bulk-loaded base, mutates it, and keeps ownership + base immutability', () => {
			const stride = 10;
			const count = 500;	// > NodeCapacity -> a genuinely multi-level, densely-packed base
			const rows = sortedRows(count, stride);
			const base = BTree.buildFrom<number, Entry>(rows, keyOf, cmp);
			assertTreeInvariants(base);

			const baseIds = rows.map(keyOf);
			const baseEntries = rows.map(e => ({ ...e }));
			// The loader owner-stamps every node it builds — the precondition COW relies on to know a shared
			// node still belongs to the base and must be cloned before the child writes it.
			expect(base.root.owner, 'bulk-loaded root is owned by the base').to.equal(base.owner);

			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);
			// An unwritten child defers entirely to the bulk-loaded nodes (shares the base root by identity).
			expect(hasLocalRoot(child), 'unwritten child has no local root').to.equal(false);
			expect(child.root, 'unwritten child resolves to the bulk-loaded base root').to.equal(base.root);
			expect(child.size, 'child count starts at the base count').to.equal(base.size);

			// Interior inserts (fresh gap keys, several into dense/full base-owned leaves -> splits) + deletes.
			const ins = [55, 155, 2005, 3005, 4995];
			for (const id of ins) expect(child.insert({ id, value: `c_${id}`, tag: 'c' }).on, `child insert ${id}`).to.equal(true);
			const del = [1000, 2000, 3000, 4000];
			for (const id of del) expect(child.deleteAt(child.find(id)), `child delete ${id}`).to.equal(true);

			// The child cloned a private spine out of the bulk-loaded nodes: it owns its root and the leaves it
			// wrote. If the loader had mis-stamped ownership, the child would have skipped cloning and mutated the
			// base in place — which assertOwnershipInvariant's base-immutability check (below) would then catch.
			expect(child.root.owner, 'child owns its cloned root after writing').to.equal(child.owner);
			for (const id of ins) expect(leafForKey(child, id).owner, `inserted ${id} lands in a child-owned leaf`).to.equal(child.owner);

			const expected = [...baseIds, ...ins].filter(k => !del.includes(k)).sort(cmp);
			expect(liveIds(child), 'child live set is bulk-load ∪ inserts − deletes').to.deep.equal(expected);
			expect(child.size, 'child stored count tracks its delta').to.equal(expected.length);
			expect(walkCount(child), 'child stored count matches a full traversal').to.equal(expected.length);
			assertTreeInvariants(child);
			assertOwnershipInvariant(child, base, snap);

			// The bulk-loaded base is untouched, structurally and value-wise.
			expect(liveSet(base), 'bulk-loaded base value-pristine').to.deep.equal(baseEntries);
			expect(liveIds(base), 'bulk-loaded base key-pristine').to.deep.equal(baseIds);
			expect(base.size, 'bulk-loaded base count unchanged').to.equal(count);
		});

		it('randomized differential: a child over a bulk-loaded base matches a shadow while the base stays pristine', () => {
			const stride = 10;
			const count = 400;
			const maxKey = count * stride;
			const base = BTree.buildFrom<number, Entry>(sortedRows(count, stride), keyOf, cmp);
			const baseEntries = liveSet(base).map(e => ({ ...e }));
			const baseIds = baseEntries.map(keyOf);

			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);
			const shadow = new Map<number, Entry>(baseEntries.map(e => [e.id, { ...e }]));

			const rng = lcg(0xB0114D);
			const OPS = 1500;
			const FLOOR = NodeCapacity * 2;	// keep the child comfortably multi-level
			let uid = 0;
			for (let op = 0; op < OPS; op++) {
				let roll = lcgInt(rng, 0, 100);
				if (shadow.size <= FLOOR) roll = 95;	// force an INSERT to stay multi-level

				if (roll < 55 && shadow.size >= 2) {
					// DELETE an interior (non-front-anchored) present key — the rebalance/clone path.
					const keys = Array.from(shadow.keys()).sort(cmp);
					const id = keys[lcgInt(rng, 1, keys.length)];
					expect(child.deleteAt(child.find(id)), `delete ${id} @op${op}`).to.equal(true);
					shadow.delete(id);
				} else if (roll < 70 && shadow.size > 0) {
					// UPSERT-existing (value replace) — clones the leaf, no count change.
					const keys = Array.from(shadow.keys());
					const id = keys[lcgInt(rng, 0, keys.length)];
					const e: Entry = { id, value: `up_${id}_op${op}`, tag: 'c' };
					expect(child.upsert(e).on, `upsert ${id} @op${op}`).to.equal(true);
					shadow.set(id, e);
				} else {
					// INSERT a fresh interior key (splits dense base-owned leaves).
					const id = lcgInt(rng, 1, maxKey) + (++uid) / 1_000_000;
					const e: Entry = { id, value: `ins_${id}_op${op}`, tag: 'c' };
					expect(child.insert(e).on, `insert ${id} @op${op}`).to.equal(true);
					shadow.set(id, e);
				}

				if (op % 100 === 0 || op === OPS - 1) {
					expect(liveSet(child), `child matches shadow @op${op}`).to.deep.equal(Array.from(shadow.values()).sort(byId));
					expect(child.size, `child count matches shadow @op${op}`).to.equal(shadow.size);
					if (hasLocalRoot(child)) assertTreeInvariants(child);
					assertOwnershipInvariant(child, base, snap);
					expect(liveSet(base), `base pristine @op${op}`).to.deep.equal(baseEntries);
				}
			}
			expect(liveSet(child), 'final child matches shadow').to.deep.equal(Array.from(shadow.values()).sort(byId));
			expect(liveIds(base), 'base key-pristine at end').to.deep.equal(baseIds);
		});
	});

	// =============================================================================================
	// 2. clear() on a derived child
	// =============================================================================================
	describe('clear() on a derived child', () => {
		it('drops the base, empties the child, leaves the base untouched, and shares no node', () => {
			const { base, ids, entries } = makeInsertBase(400, 10);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			// Write only in a narrow region so the child owns a spine yet still SHARES most base subtrees.
			for (const id of [2010, 2020, 2030]) expect(child.deleteAt(child.find(id)), `del ${id}`).to.equal(true);
			for (const id of [2011, 2021]) expect(child.insert({ id, value: `c_${id}`, tag: 'c' }).on, `ins ${id}`).to.equal(true);
			expect(sharedReachableNodes(child, base).length, 'child shares untouched base nodes before clear').to.be.greaterThan(0);

			const baseNodesBefore = reachableNodesOf(base).size;
			child.clear();

			// Base is entirely untouched — value, key set, structure, and node identities.
			expect(liveSet(base), 'base value-pristine after child.clear()').to.deep.equal(entries);
			expect(liveIds(base), 'base key-pristine after child.clear()').to.deep.equal(ids);
			expect(reachableNodesOf(base).size, 'base structure unchanged').to.equal(baseNodesBefore);
			assertTreeInvariants(base);

			// The child is empty, detached, and — unlike clearBase(), which pins the shared base root — clear()
			// installs a FRESH empty root, so the flattened child shares NO node with the former base.
			expect(child.size, 'cleared child size is 0').to.equal(0);
			expect(child.getCount(), 'cleared child getCount() is 0').to.equal(0);
			expect(baseOf(child), 'clear() detaches the base').to.equal(undefined);
			expect(sharedReachableNodes(child, base).length, 'cleared child shares no node with the former base').to.equal(0);
			expect(liveIds(child), 'cleared child iterates empty').to.deep.equal([]);
			assertTreeInvariants(child);

			// Re-insertable, and genuinely independent of the base (no shared-node aliasing to leak through).
			for (const id of [1, 2000, 9999]) expect(child.insert({ id, value: `n_${id}`, tag: 'n' }).on, `re-insert ${id}`).to.equal(true);
			expect(liveIds(child), 'child usable after clear()').to.deep.equal([1, 2000, 9999]);
			expect(child.size, 'count resumes from 0 after clear()').to.equal(3);
			assertTreeInvariants(child);
			// The child's post-clear inserts never reach the base (2000 was a base key; the base still has it).
			expect(liveIds(base), 'base unaffected by the cleared child’s later inserts').to.deep.equal(ids);
			expect(base.get(2000), 'base keeps its own 2000').to.deep.equal({ id: 2000, value: 'base_2000', tag: 'base' });
		});

		it('clear() on a NEVER-written child also detaches cleanly and shares nothing', () => {
			const { base, ids, entries } = makeInsertBase(200, 10);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			// Never written: it fully defers to the base and shares its whole structure.
			expect(hasLocalRoot(child), 'unwritten child has no local root').to.equal(false);
			expect(sharedReachableNodes(child, base).length, 'unwritten child shares the whole base structure').to.be.greaterThan(0);

			child.clear();

			expect(baseOf(child), 'clear() detaches the base').to.equal(undefined);
			expect(child.size, 'cleared child is empty').to.equal(0);
			expect(sharedReachableNodes(child, base).length, 'cleared child shares no node with the former base').to.equal(0);
			assertTreeInvariants(child);
			// Base still whole.
			expect(liveSet(base), 'base value-pristine').to.deep.equal(entries);
			expect(liveIds(base), 'base key-pristine').to.deep.equal(ids);
		});
	});

	// =============================================================================================
	// 3. Counts on children (O(1) stored count) — after derive, after mutation, through a chain
	// =============================================================================================
	describe('counts on children', () => {
		it('a freshly-derived child reports the base count with no traversal', () => {
			const { base } = makeInsertBase(300, 10);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			// Immediately after derive, before any write: size / getCount() equal the base's, and a full walk agrees.
			expect(child.size, 'derived child size == base size').to.equal(base.size);
			expect(child.getCount(), 'derived child getCount() == base getCount()').to.equal(base.getCount());
			expect(walkCount(child), 'derived child count matches a full traversal').to.equal(base.size);
		});

		it('child inserts and deletes move the child count only, never the base count', () => {
			const { base } = makeInsertBase(300, 10);
			const baseCount = base.size;
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			for (const id of [55, 155, 255]) expect(child.insert({ id, value: `c_${id}`, tag: 'c' }).on).to.equal(true);
			expect(child.size, 'child grew by its inserts').to.equal(baseCount + 3);
			expect(base.size, 'base count untouched by child inserts').to.equal(baseCount);

			for (const id of [500, 1000, 1500, 2000]) expect(child.deleteAt(child.find(id))).to.equal(true);
			expect(child.size, 'child shrank by its deletes').to.equal(baseCount + 3 - 4);
			expect(base.size, 'base count untouched by child deletes').to.equal(baseCount);

			// No-op mutations on the child must not move its count either.
			expect(child.insert({ id: 55, value: 'dup', tag: 'c' }).on, 'duplicate insert rejected').to.equal(false);
			child.upsert({ id: 155, value: 'in-place', tag: 'c' });	// existing -> in-place replace
			expect(child.deleteAt(child.find(999999)), 'absent-key delete is a no-op').to.equal(false);
			expect(child.size, 'no-op mutations leave the child count unchanged').to.equal(baseCount + 3 - 4);

			expect(walkCount(child), 'stored count still matches a full traversal').to.equal(child.size);
			expect(walkCount(base), 'base traversal count unchanged').to.equal(baseCount);
			assertTreeInvariants(child);
			assertTreeInvariants(base);
		});

		it('a base -> c1 -> c2 chain keeps three independent, correct counts', () => {
			const { base } = makeInsertBase(200, 10);
			const baseCount = base.size;	// 200

			// c1 derives from base, then mutates. (base is frozen for the rest of the test.)
			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			expect(c1.size, 'c1 starts at base count').to.equal(baseCount);
			for (const id of [5, 15, 25, 35, 45]) expect(c1.insert({ id, value: `c1_${id}`, tag: 'c1' }).on).to.equal(true);	// +5
			for (const id of [100, 200, 300]) expect(c1.deleteAt(c1.find(id))).to.equal(true);	// -3
			const c1Count = baseCount + 5 - 3;	// 202
			expect(c1.size, 'c1 count tracks its own delta').to.equal(c1Count);

			// c2 derives from the (now frozen) c1, snapshotting c1's current count, then mutates independently.
			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
			expect(c2.size, 'c2 starts at c1 count (the O(1) read at derive time)').to.equal(c1Count);
			for (const id of [6, 16, 26, 36, 46, 56, 66, 76, 86, 96]) expect(c2.insert({ id, value: `c2_${id}`, tag: 'c2' }).on).to.equal(true);	// +10
			for (const id of [110, 120, 130, 140]) expect(c2.deleteAt(c2.find(id))).to.equal(true);	// -4
			const c2Count = c1Count + 10 - 4;	// 208
			expect(c2.size, 'c2 count tracks its own delta from c1').to.equal(c2Count);

			// All three counts are independent and each matches a full traversal of that tree.
			expect(base.size, 'base count still original').to.equal(baseCount);
			expect(c1.size, 'c1 count unchanged by c2 mutations').to.equal(c1Count);
			expect(c2.size, 'c2 count').to.equal(c2Count);
			expect(walkCount(base), 'base walk == base count').to.equal(baseCount);
			expect(walkCount(c1), 'c1 walk == c1 count').to.equal(c1Count);
			expect(walkCount(c2), 'c2 walk == c2 count').to.equal(c2Count);
			assertTreeInvariants(base);
			assertTreeInvariants(c1);
			assertTreeInvariants(c2);

			// The partial getCount({ path }) overload also works from a child cursor (walks, not the stored count).
			expect(c2.getCount({ path: c2.first() }), 'partial forward count from first == full count').to.equal(c2Count);
			expect(c2.getCount({ path: c2.last(), ascending: false }), 'partial backward count from last == full count').to.equal(c2Count);
		});
	});

	// =============================================================================================
	// 4. freeze:false children via the 4-argument options constructor form
	// =============================================================================================
	describe('freeze:false children (the `new BTree(k, c, base, { freeze:false })` form)', () => {
		it('the 4-arg options actually take effect: a freeze:false child stores unfrozen entries, a default sibling freezes', () => {
			const { base, ids } = makeInsertBase(200, 10);
			const snap = snapshotBase(base);

			const loose = new BTree<number, Entry>(keyOf, cmp, base, { freeze: false });
			const strict = new BTree<number, Entry>(keyOf, cmp, base);	// default (freeze: true), same base

			// Both children are genuinely derived from the base (the 4th arg didn't clobber the base wiring).
			expect(loose.get(1500), 'freeze:false child inherits base data').to.deep.equal({ id: 1500, value: 'base_1500', tag: 'base' });
			expect(strict.get(1500), 'default child inherits base data').to.deep.equal({ id: 1500, value: 'base_1500', tag: 'base' });

			// A key each child writes: the loose child leaves it mutable; the strict child freezes it.
			const looseEntry: Entry = { id: 555, value: 'loose', tag: 'c' };
			expect(loose.insert(looseEntry).on, 'loose insert').to.equal(true);
			expect(Object.isFrozen(loose.get(555)), 'freeze:false leaves the child-written entry unfrozen').to.equal(false);

			const strictEntry: Entry = { id: 666, value: 'strict', tag: 'c' };
			expect(strict.insert(strictEntry).on, 'strict insert').to.equal(true);
			expect(Object.isFrozen(strict.get(666)), 'default child freezes the entry it writes').to.equal(true);

			// The unfrozen stored entry is genuinely mutable (a non-key field sticks) — the whole point of the opt-out.
			(loose.get(555) as Entry).value = 'MUTATED';
			expect(loose.get(555)!.value, 'a non-key field of an unfrozen stored entry is mutable').to.equal('MUTATED');

			// A value-replace (upsert of an existing base key) on the loose child also stores an unfrozen entry.
			const replace: Entry = { id: 1500, value: 'loose_replaced', tag: 'c' };
			expect(loose.upsert(replace).on, 'upsert of an existing key reports on=true').to.equal(true);
			expect(Object.isFrozen(loose.get(1500)), 'value-replace on a freeze:false child is unfrozen too').to.equal(false);

			// COW still isolated the writes: base untouched (its own 1500 kept its frozen original), each child valid.
			expect(base.get(1500), 'base 1500 unchanged').to.deep.equal({ id: 1500, value: 'base_1500', tag: 'base' });
			expect(Object.isFrozen(base.get(1500)), 'the base entry is still frozen (base built with defaults)').to.equal(true);
			expect(loose.get(666), 'strict child’s insert is invisible to the loose child').to.equal(undefined);
			expect(strict.get(555), 'loose child’s insert is invisible to the strict child').to.equal(undefined);
			assertTreeInvariants(loose);
			assertTreeInvariants(strict);
			assertOwnershipInvariant(loose, base, snap);
			assertOwnershipInvariant(strict, base, snap);
			expect(liveIds(base), 'base key-pristine under both children').to.deep.equal(ids);
		});

		it('a freeze:false child that COW-clones a base leaf keeps the clone correctly owner-stamped and independently mutable', () => {
			const { base, ids, entries } = makeInsertBase(300, 10);
			const snap = snapshotBase(base);
			const child = new BTree<number, Entry>(keyOf, cmp, base, { freeze: false });

			// Force a clone of a base-owned leaf by writing a fresh interior key into it.
			const K = 1505;	// gap between base 1500 and 1510
			expect(leafForKey(child, K).owner, 'target leaf is base-owned before the write').to.equal(base.owner);
			expect(child.insert({ id: K, value: 'cloned', tag: 'c' }).on, `insert ${K}`).to.equal(true);

			const clonedLeaf = leafForKey(child, K);
			expect(clonedLeaf.owner, 'the COW clone is owner-stamped to the child').to.equal(child.owner);
			expect(clonedLeaf, 'the clone is not the base leaf').to.not.equal(leafForKey(base, K));
			expect(Object.isFrozen(child.get(K)), 'the entry stored into the clone is unfrozen').to.equal(false);

			assertTreeInvariants(child);
			assertOwnershipInvariant(child, base, snap);
			expect(liveIds(child), 'child live set is base ∪ {K}').to.deep.equal([...ids, K].sort(cmp));
			expect(liveSet(base), 'base value-pristine').to.deep.equal(entries);
		});
	});

	// =============================================================================================
	// 5. Delete-while-iterating on a child across a COW clone boundary
	// =============================================================================================
	describe('delete-while-iterating on a child (deleteAt re-stamp across a clone boundary)', () => {
		it('deleteAt on an inherited path clones the leaf, remaps + re-stamps that path, and moveNext advances with no re-find', () => {
			const { base, ids, entries } = makeInsertBase(300, 10);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);

			const K = 1500;	// interior base key
			const idx = ids.indexOf(K);
			const successor = ids[idx + 1];	// 1510

			const path = child.find(K);
			expect(path.on, 'target key present in child').to.equal(true);
			// The path descends through INHERITED (base-owned) nodes: nothing is cloned yet.
			expect((path as any).leafNode.owner, 'path is on a base-owned (inherited) leaf before the delete').to.equal(base.owner);

			// deleteAt clones the leaf + rootward spine into the child, remaps THIS path onto the clones
			// (mutableLeaf -> path.remap), and re-stamps the bumped version onto that same remapped path.
			expect(child.deleteAt(path), `delete ${K}`).to.equal(true);
			expect((path as any).leafNode.owner, 'the delete remapped the path onto the child-owned clone').to.equal(child.owner);

			// No intervening find: moveNext on the remapped+re-stamped path recovers onto the deleted key's successor.
			child.moveNext(path);
			expect(path.on, 'moveNext recovers onto an entry across the clone boundary').to.equal(true);
			expect(child.at(path)!.id, 'moveNext lands exactly on the successor').to.equal(successor);

			assertTreeInvariants(child);
			assertOwnershipInvariant(child, base, snap);
			expect(liveIds(child), 'child lost exactly the one deleted key').to.deep.equal(ids.filter(k => k !== K));
			expect(liveSet(base), 'base value-pristine').to.deep.equal(entries);
		});

		it('a full delete-while-iterating sweep over a child threads one path across many clone boundaries', () => {
			const { base, ids, entries } = makeInsertBase(300, 10);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);

			// Delete every third base key using the README delete-while-iterating idiom: a SINGLE path, no re-find.
			// The child starts fully inherited, so the first delete in each not-yet-cloned leaf crosses a clone
			// boundary (remap + re-stamp), and the following moveNext must navigate the freshly-cloned spine.
			const shouldDelete = (id: number): boolean => (id / 10) % 3 === 0;
			const survivors = ids.filter(id => !shouldDelete(id));

			const p = child.first();
			let deletes = 0;
			while (p.on) {
				const id = child.at(p)!.id;
				if (shouldDelete(id)) {
					expect(child.deleteAt(p), `delete ${id}`).to.equal(true);	// p now sits at the successor's crack
					deletes++;
				}
				child.moveNext(p);	// after a delete: recovers onto the successor; otherwise: advances normally
			}
			expect(deletes, 'the sweep actually deleted a large subset').to.be.greaterThan(NodeCapacity);

			expect(liveIds(child), 'child holds exactly the survivors').to.deep.equal(survivors);
			expect(child.size, 'child count == survivors').to.equal(survivors.length);
			expect(walkCount(child), 'stored count matches a full traversal').to.equal(survivors.length);
			assertTreeInvariants(child);
			assertOwnershipInvariant(child, base, snap);
			expect(liveSet(base), 'base value-pristine through the whole sweep').to.deep.equal(entries);
			expect(liveIds(base), 'base key-pristine through the whole sweep').to.deep.equal(ids);
		});
	});
});
