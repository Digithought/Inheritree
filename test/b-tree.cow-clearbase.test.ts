import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { BranchNode, ITreeNode, LeafNode } from '../src/nodes.js';
import { assertTreeInvariants, reachableNodesOf, sharedReachableNodes } from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

/**
 * Two related correctness edges around the `base` relationship, both pinned here as PROPERTY/REGRESSION
 * tests against a genuinely multi-level tree (NodeCapacity is 64; bases are built well above it):
 *
 *   1. clearBase AT SCALE. The pre-existing `clearBase` coverage (test/cow.test.ts) operates on a tiny
 *      single-leaf tree, where the child's writes clone the whole tree so the flattened child shares
 *      nothing with its former base. That hides the at-scale reality: `clearBase` (src/b-tree.ts) merely
 *      drops the `base` pointer (pinning `_root`) — it does NOT deep-copy. After a multi-level child has
 *      done real borrows/merges/splits, it OWNS only its mutated spine and still SHARES every untouched
 *      subtree with the former base. These tests prove the flattened child is internally correct and that
 *      its key set survives `clearBase`, then pin exactly which isolation does and does not hold.
 *
 *   2. THE BASE-IMMUTABILITY CONTRACT. A derived tree reads `base.root` for any un-owned path
 *      (src/b-tree.ts), so mutating a base that still has live derived children corrupts those children's
 *      view of any node they share. The same hazard outlives `clearBase`, because the flattened child can
 *      still share nodes with the former base (and, once `base` is undefined, NEITHER tree copies-on-write
 *      anymore, so a write to a shared node mutates it in place for both). This is currently a doc-only
 *      contract (readme.md + the doc comments on `clearBase` and the `base` constructor param); the tests
 *      below PIN the current (unguarded) behavior so that adding a runtime guard or a deep-copying
 *      `clearBase` later shows up as an intentional, visible diff.
 *
 * NOTE ON HONESTY: the ticket hoped `clearBase` would yield a child that "shares no node with the former
 * base" and is fully isolated from later base mutations. At scale that is FALSE, and these tests assert the
 * truth (sharing persists; untouched-region base mutations leak) rather than a convenient fiction. See the
 * review handoff for the resulting decision note.
 */
describe('BTree clearBase at scale & the base-immutability contract', () => {
	interface Entry {
		id: number;
		value: string;
		tag: string;
	}

	const keyOf = (e: Entry): number => e.id;
	const cmp = (a: number, b: number): number => a - b;
	const byId = (a: Entry, b: Entry): number => a.id - b.id;

	// --- structural probes (mirrors test/b-tree.cow-fork.test.ts) ---

	function hasLocalRoot(tree: BTree<number, Entry>): boolean {
		return Boolean((tree as any)['_root']);
	}

	function baseOf(tree: BTree<number, Entry>): BTree<number, Entry> | undefined {
		return (tree as any)['base'];
	}

	function depthOf(node: ITreeNode): number {
		let depth = 0;
		let n: ITreeNode | undefined = node;
		while (n instanceof BranchNode) {
			depth++;
			n = (n as BranchNode<number>).nodes[0];
		}
		return depth;
	}

	/** Replicates BTree.indexOfKey: the child slot a key descends into. */
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

	/** The leaf a key routes to, descending from a tree's effective root. */
	function leafForKey(tree: BTree<number, Entry>, key: number): LeafNode<Entry> {
		let node: ITreeNode = tree.root;
		while (node instanceof BranchNode) {
			const b = node as BranchNode<number>;
			node = b.nodes[childIndex(b.partitions, key)];
		}
		return node as LeafNode<Entry>;
	}

	// --- ordered-iteration collectors (both directions; strict order asserted) ---

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

	// --- base builder ---

	/** A genuinely multi-level base with ids `stride, 2*stride, ..., count*stride`, leaving `stride-1`
	 * integer gaps between consecutive base keys for fresh interior inserts. */
	function makeBase(count: number, stride: number): { base: BTree<number, Entry>; ids: number[]; entries: Entry[] } {
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

	/**
	 * Drives a seeded, delete-biased op stream against a child + its shadow Map. Deletes hit INTERIOR keys
	 * (index >= 1, never the running minimum) so they provoke real borrows/merges (a front-anchored delete
	 * only ever rebalances rightward and dodges that path — see test/b-tree.cow-delete.test.ts). Inserts use
	 * fresh interior keys (forcing splits). A FLOOR keeps the tree comfortably multi-level throughout.
	 */
	function driveOps(
		child: BTree<number, Entry>,
		shadow: Map<number, Entry>,
		rng: () => number,
		count: number,
		floor: number,
		maxKey: number,
		tagPrefix: string,
	): void {
		let uid = 0;
		for (let i = 0; i < count; i++) {
			let roll = lcgInt(rng, 0, 100);
			if (shadow.size <= floor) roll = 99; // force INSERT to stay multi-level

			if (roll < 55 && shadow.size >= 2) {
				const sortedKeys = Array.from(shadow.keys()).sort(cmp);
				const id = sortedKeys[lcgInt(rng, 1, sortedKeys.length)]; // index >= 1 => non-front-anchored
				expect(child.deleteAt(child.find(id)), `${tagPrefix} delete ${id} @op${i}`).to.equal(true);
				shadow.delete(id);
			} else if (roll < 70 && shadow.size > 0) {
				const keys = Array.from(shadow.keys());
				const id = keys[lcgInt(rng, 0, keys.length)];
				const e: Entry = { id, value: `${tagPrefix}_upd_${id}_op${i}`, tag: tagPrefix };
				child.updateAt(child.find(id), e);
				shadow.set(id, e);
			} else {
				const id = lcgInt(rng, 1, maxKey) + (++uid) / 1_000_000; // fresh interior key
				const e: Entry = { id, value: `${tagPrefix}_ins_${id}_op${i}`, tag: tagPrefix };
				expect(child.insert(e).on, `${tagPrefix} insert ${id} @op${i}`).to.equal(true);
				shadow.set(id, e);
			}
		}
	}

	const BASE_COUNT = 400;
	const BASE_STRIDE = 10;
	const MAX_KEY = BASE_COUNT * BASE_STRIDE; // 4000
	const FLOOR = NodeCapacity * 3; // keep the tree comfortably multi-level

	// =================================================================================================
	// 1. clearBase at scale
	// =================================================================================================
	describe('clearBase at scale', () => {
		it('flattens a heavily-mutated multi-level child: key set preserved, structure valid, base detached', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			expect(depthOf(base.root), 'base must be multi-level').to.be.greaterThanOrEqual(1);

			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const shadow = new Map<number, Entry>(); // seed with the base's view
			for (const p of (function* () { const pp = base.first(); while (pp.on) { yield base.at(pp)!; base.moveNext(pp); } })()) shadow.set(p.id, { ...p });

			// A substantial non-front-anchored mix that forces borrows/merges (deletes) and splits (inserts).
			driveOps(child, shadow, lcg(0xC0FFEE), 500, FLOOR, MAX_KEY, 'c');
			assertTreeInvariants(child);

			const idsBefore = liveIds(child);
			const expected = Array.from(shadow.values()).sort(byId);
			expect(liveSet(child), 'child matches shadow before clearBase').to.deep.equal(expected);

			child.clearBase();

			// The defining guarantees of clearBase: the child's key set is untouched and the dependency is gone.
			expect(liveIds(child), 'clearBase preserves the child key set').to.deep.equal(idsBefore);
			expect(baseOf(child), 'clearBase drops the base pointer').to.equal(undefined);
			expect((child.root as ITreeNode).tree, 'a written child owns its pinned root after clearBase').to.equal(child);
			assertTreeInvariants(child);
			expect(liveSet(child), 'child still matches shadow after clearBase').to.deep.equal(expected);
		});

		it('after clearBase, a follow-up op batch on the flattened child stays internally correct', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const shadow = new Map<number, Entry>();
			const seed = base.first(); while (seed.on) { const e = base.at(seed)!; shadow.set(e.id, { ...e }); base.moveNext(seed); }

			driveOps(child, shadow, lcg(0x9E3779B1), 400, FLOOR, MAX_KEY, 'pre');
			child.clearBase();
			assertTreeInvariants(child);

			// Now drive a second batch on the detached (baseless) tree; it must behave like any normal B+tree.
			driveOps(child, shadow, lcg(0xBADF00D), 400, FLOOR, MAX_KEY, 'post');
			assertTreeInvariants(child);
			expect(liveSet(child), 'flattened child matches shadow after a follow-up op batch')
				.to.deep.equal(Array.from(shadow.values()).sort(byId));
			expect(child.getCount(), 'count matches shadow after follow-up ops').to.equal(shadow.size);
		});

		it('clearBase severs the dependency cheaply: a flattened child still SHARES untouched nodes with its former base (no deep copy)', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			// Write only in a narrow region so most subtrees remain inherited (and therefore shared).
			for (const id of [2010, 2020, 2030, 2040, 2050]) expect(child.deleteAt(child.find(id)), `del ${id}`).to.equal(true);
			for (const id of [2011, 2021, 2031]) expect(child.insert({ id, value: `c_${id}`, tag: 'c' }).on, `ins ${id}`).to.equal(true);

			child.clearBase();

			// PINNED REALITY (contradicts the ticket's "shares no node" hope): clearBase does not deep-copy, so
			// untouched subtrees stay shared by identity. If clearBase ever starts deep-copying, this flips and
			// the assertions below are the intentional, visible diff.
			const shared = sharedReachableNodes(child, base);
			expect(shared.length, 'flattened child still shares untouched nodes with its former base').to.be.greaterThan(0);

			// Quantify it: a narrow write clones only the spine it touched, so the *vast majority* of the
			// child's structure is still the former base's nodes — strictly stronger than "> 0", and the
			// clearest possible evidence that clearBase is a pointer drop, not a deep copy.
			const childNodeCount = reachableNodesOf(child).size;
			expect(shared.length, 'most of the flattened child is still physically the former base').to.be.greaterThan(childNodeCount / 2);
		});

		it('isolation that DOES hold: after clearBase, mutating the former base in a region the child REWROTE does not affect the child', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			// The child rewrites key 2000 -> it clones the leaf holding 2000; base keeps its own original leaf.
			const REWRITTEN = 2000;
			child.updateAt(child.find(REWRITTEN), { id: REWRITTEN, value: 'child_owned', tag: 'c' });
			expect(leafForKey(child, REWRITTEN), 'child owns the rewritten leaf').to.not.equal(leafForKey(base, REWRITTEN));

			child.clearBase();

			// Mutate the former base across that now-private leaf; the child must not see any of it.
			base.updateAt(base.find(REWRITTEN), { id: REWRITTEN, value: 'base_changed_after_clear', tag: 'base' });
			base.deleteAt(base.find(REWRITTEN - 10));
			base.insert({ id: REWRITTEN + 1, value: 'base_new', tag: 'base' });

			expect(child.get(REWRITTEN), 'child keeps its own value for the rewritten key').to.deep.equal({ id: REWRITTEN, value: 'child_owned', tag: 'c' });
			expect(child.get(REWRITTEN - 10), "base's later delete does not reach the child's owned leaf").to.not.equal(undefined);
			expect(child.get(REWRITTEN + 1), "base's later insert does not reach the child's owned leaf").to.equal(undefined);
			assertTreeInvariants(child);
		});

		it('clearBase on an INTERMEDIATE tree in a deep chain (base -> c1 -> c2) flattens c2 correctly and leaves c1/base intact', () => {
			// The base->child case above exercises the mechanism, but a clearBase() called on a tree whose own
			// base itself has a base is its own routing case worth pinning: c2.root falls through c1 to base for
			// any path none of the three has rewritten.
			const { base, ids: baseIds, entries: baseEntries } = makeBase(BASE_COUNT, BASE_STRIDE);

			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			const shadow1 = new Map<number, Entry>();
			for (const id of baseIds) shadow1.set(id, { id, value: `base_${id}`, tag: 'base' });
			driveOps(c1, shadow1, lcg(0xD15EA5E), 300, FLOOR, MAX_KEY, 'c1');
			assertTreeInvariants(c1);

			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
			const shadow2 = new Map<number, Entry>(shadow1); // c2 initially sees c1's view
			driveOps(c2, shadow2, lcg(0x5CA1AB1E), 300, FLOOR, MAX_KEY, 'c2');
			assertTreeInvariants(c2);

			const c2IdsBefore = liveIds(c2);
			const c2Expected = Array.from(shadow2.values()).sort(byId);
			expect(liveSet(c2), 'c2 matches its shadow before clearBase').to.deep.equal(c2Expected);

			c2.clearBase();

			// c2 is now a standalone, valid tree presenting exactly its own key set.
			expect(baseOf(c2), 'clearBase drops c2 -> c1 pointer').to.equal(undefined);
			expect(liveIds(c2), 'clearBase preserves c2 key set').to.deep.equal(c2IdsBefore);
			assertTreeInvariants(c2);
			expect(liveSet(c2), 'c2 still matches its shadow after clearBase').to.deep.equal(c2Expected);

			// The ancestors c2 detached from are untouched by the detach itself and remain valid.
			assertTreeInvariants(c1);
			assertTreeInvariants(base);
			expect(liveSet(c1), 'c1 unchanged by c2.clearBase').to.deep.equal(Array.from(shadow1.values()).sort(byId));
			expect(liveSet(base), 'base value-unchanged by a downstream clearBase').to.deep.equal(baseEntries);
		});
	});

	// =================================================================================================
	// 2. The base-immutability contract — pinned hazards (current, unguarded behavior)
	// =================================================================================================
	describe('the base-immutability contract (pinned hazards)', () => {
		it('mutating a base while a derived child is LIVE leaks into the child (why the base must be frozen)', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			// Child writes only near key 2000; key 50 lives in a leaf the child never touches, so the child
			// still reads it straight from the base.
			child.insert({ id: 2005, value: 'c_2005', tag: 'c' });
			const UNTOUCHED = 50;
			expect(leafForKey(child, UNTOUCHED), 'child shares the untouched leaf with its base').to.equal(leafForKey(base, UNTOUCHED));
			expect(child.get(UNTOUCHED), 'child reads the untouched key from the base').to.deep.equal({ id: UNTOUCHED, value: `base_${UNTOUCHED}`, tag: 'base' });

			// VIOLATE the contract: structurally mutate the base while the child is live.
			base.deleteAt(base.find(UNTOUCHED));

			// PINNED HAZARD: the deletion leaks into the live child's view of the shared leaf.
			expect(child.get(UNTOUCHED), "base mutation leaks into the live child's shared region (pinned hazard)").to.equal(undefined);
		});

		it('after clearBase, mutating the former base in an UNTOUCHED region still leaks into the flattened child (pinned hazard)', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			for (const id of [2010, 2020, 2030]) child.deleteAt(child.find(id)); // write only near 2000
			child.clearBase();

			const UNTOUCHED = 50;
			expect(leafForKey(child, UNTOUCHED), 'flattened child still shares the untouched leaf').to.equal(leafForKey(base, UNTOUCHED));

			base.deleteAt(base.find(UNTOUCHED)); // former base mutated in place on a still-shared node

			expect(child.get(UNTOUCHED), "former-base mutation still leaks into the flattened child's shared region (pinned hazard)").to.equal(undefined);
		});

		it('after clearBase, mutating the flattened CHILD in a shared region corrupts the former base (pinned hazard, both directions)', () => {
			const { base } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			for (const id of [2010, 2020, 2030]) child.deleteAt(child.find(id));
			child.clearBase();

			const SHARED = 60;
			expect(leafForKey(child, SHARED), 'flattened child shares this leaf with the former base').to.equal(leafForKey(base, SHARED));

			// After clearBase the child has base === undefined, so it no longer copies-on-write: this write
			// mutates the shared node in place, corrupting the former base.
			child.updateAt(child.find(SHARED), { id: SHARED, value: 'child_changed_after_clear', tag: 'c' });

			expect(base.get(SHARED), "child's post-clearBase write corrupts the former base's shared node (pinned hazard)")
				.to.deep.equal({ id: SHARED, value: 'child_changed_after_clear', tag: 'c' });
		});

		it('clearBase on a NEVER-written child pins the base root, fully aliasing the two trees', () => {
			const { base, ids, entries } = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			// Never written: the child has no local root and defers entirely to the base.
			expect(hasLocalRoot(child), 'unwritten child has no local root before clearBase').to.equal(false);

			child.clearBase();

			// clearBase pins `_root` to the (still base-owned) base root and drops the base pointer.
			expect(baseOf(child), 'base pointer dropped').to.equal(undefined);
			expect(child.root, 'child root is the former base root (pinned, not copied)').to.equal(base.root);
			expect(liveIds(child), 'flattened child presents the full base key set').to.deep.equal(ids);
			assertTreeInvariants(child); // it is still a valid standalone tree
			expect(liveSet(base), 'base value-unchanged so far').to.deep.equal(entries);

			// Follow-up op batch on the now-baseless tree: it behaves correctly as a standalone tree...
			const SHARED = 70;
			child.updateAt(child.find(SHARED), { id: SHARED, value: 'child_after_clear', tag: 'c' });
			expect(child.get(SHARED), 'child reflects its own write').to.deep.equal({ id: SHARED, value: 'child_after_clear', tag: 'c' });
			assertTreeInvariants(child);

			// ...but because the two fully alias, that write corrupts the former base (pinned hazard).
			expect(base.get(SHARED), "child's write corrupts the fully-aliased former base (pinned hazard)")
				.to.deep.equal({ id: SHARED, value: 'child_after_clear', tag: 'c' });
		});
	});
});
