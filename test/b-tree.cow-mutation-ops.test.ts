import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { BranchNode, ITreeNode, LeafNode } from '../src/nodes.js';
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

/**
 * Regression + property suite for the copy-on-write behaviour of the higher-level mutators —
 * `upsert`, `merge`, and `updateAt` (same-key value replace AND key-change) — on a MULTI-LEVEL base.
 *
 * `test/cow.test.ts` only covers insert / same-key update / delete on a single-leaf base. Yet each of
 * these mutators routes through the exact same COW clone machinery the escaped delete/insert bugs lived
 * in (`mutableLeaf` / `mutableBranch` / `replaceRootward`, src/b-tree.ts):
 *
 *   - `upsert`  -> `mutableLeaf` (existing key, value replace) OR `internalInsertAt` (new key, may split).
 *   - `merge`   -> `updateAt` (existing key) OR `internalInsertAt` (new key, may split); its `getUpdated`
 *                  callback can also return an already-present key, which routes into the conflict path.
 *   - `updateAt` with a CHANGED key (src/b-tree.ts:433) is the single heaviest COW op: it runs
 *     `internalInsert` (which can split a full leaf and clone branches on the insert side) AND THEN
 *     `internalDelete` (which can borrow/merge against a sibling and clone branches on the delete side) —
 *     both against base-owned nodes, in one operation.
 *
 * Every case below builds an immutable, genuinely multi-level base, derives a COW child, and after each op
 * asserts: functional correctness (live set in BOTH directions + point lookups), the child is structurally
 * well-formed (`assertTreeInvariants`), its mutable spine is connected & base-disjoint (`assertOwnershipInvariant`),
 * and the base is proven pristine against a pre-mutation snapshot. NodeCapacity is 64; base sizes are well
 * above it so the trees are multi-level and the rebalance/split paths are real.
 */
describe('BTree COW mutation ops (upsert / merge / updateAt)', () => {
	interface Entry {
		id: number;
		value: string;
		origin: 'base' | 'derived';
	}

	const keyOf = (e: Entry): number => e.id;
	const cmp = (a: number, b: number): number => a - b;
	const byId = (a: Entry, b: Entry): number => a.id - b.id;

	// --- structural probes (reach into `_root` to validate our base constructions are what we think) ---

	/** assertTreeInvariants needs a local root to validate; a COW child with no writes legitimately has
	 * none (it defers entirely to its base), so guard structural checks behind this. */
	function hasLocalRoot(tree: BTree<number, Entry>): boolean {
		return Boolean((tree as any)['_root']);
	}

	/** Depth of the subtree at `node` (0 = leaf, 1 = branch-over-leaves, ...). */
	function depthOf(node: ITreeNode): number {
		let depth = 0;
		let n: ITreeNode | undefined = node;
		while (n instanceof BranchNode) {
			depth++;
			n = (n as BranchNode<number, any>).nodes[0];
		}
		return depth;
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

	/** The leaf node a key routes to, descending from a tree's local `_root`. (Tree must own a root.) */
	function leafForKey(tree: BTree<number, Entry>, key: number): LeafNode<Entry> {
		let node = (tree as any)['_root'] as ITreeNode | undefined;
		expect(node, 'leafForKey requires a local root').to.not.equal(undefined);
		while (node instanceof BranchNode) {
			const b = node as BranchNode<number, any>;
			node = b.nodes[childIndex(b.partitions, key)];
		}
		return node as LeafNode<Entry>;
	}

	/** All leaf nodes of a tree, left-to-right (descending from its local `_root`). */
	function enumerateLeaves(tree: BTree<number, Entry>): LeafNode<Entry>[] {
		const out: LeafNode<Entry>[] = [];
		const visit = (node: ITreeNode): void => {
			if (node instanceof BranchNode) {
				for (const c of (node as BranchNode<number, any>).nodes) visit(c);
			} else {
				out.push(node as LeafNode<Entry>);
			}
		};
		const root = (tree as any)['_root'] as ITreeNode | undefined;
		expect(root, 'enumerateLeaves requires a local root').to.not.equal(undefined);
		visit(root!);
		return out;
	}

	/** Count of nodes reachable from `root` whose owner is `owner` (used to prove "only the touched spine cloned"). */
	function countOwned(root: ITreeNode, owner: BTree<number, Entry>): number {
		let n = 0;
		const seen = new Set<ITreeNode>();
		const stack: ITreeNode[] = [root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (seen.has(node)) continue;
			seen.add(node);
			if (node.owner === owner.owner) n++;
			if (node instanceof BranchNode) {
				for (const c of (node as BranchNode<number, any>).nodes) stack.push(c);
			}
		}
		return n;
	}

	// --- ordered-iteration collectors (both directions, asserting strict order & no dupes) ---

	function collectAscending(tree: BTree<number, Entry>): Entry[] {
		const out: Entry[] = [];
		const path = tree.first();
		while (path.on) {
			const entry = tree.at(path);
			expect(entry, 'entry on a live ascending path').to.not.equal(undefined);
			if (out.length > 0) {
				expect(entry!.id, `strictly ascending after ${out[out.length - 1].id}`).to.be.greaterThan(out[out.length - 1].id);
			}
			out.push(entry!);
			tree.moveNext(path);
		}
		return out;
	}

	function collectDescending(tree: BTree<number, Entry>): Entry[] {
		const out: Entry[] = [];
		const path = tree.last();
		while (path.on) {
			const entry = tree.at(path);
			expect(entry, 'entry on a live descending path').to.not.equal(undefined);
			if (out.length > 0) {
				expect(entry!.id, `strictly descending after ${out[out.length - 1].id}`).to.be.lessThan(out[out.length - 1].id);
			}
			out.push(entry!);
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

	// --- base builders ---

	/** A genuinely multi-level base of object entries with ids `stride, 2*stride, ..., count*stride`,
	 * leaving `stride - 1` integer gaps between consecutive base keys for fresh interior inserts. */
	function makeBase(count: number, stride: number): { base: BTree<number, Entry>; ids: number[]; entries: Entry[] } {
		expect(count, 'count must exceed NodeCapacity to force a multi-level tree').to.be.greaterThan(NodeCapacity);
		const base = new BTree<number, Entry>(keyOf, cmp);
		const ids: number[] = [];
		const entries: Entry[] = [];
		for (let i = 1; i <= count; i++) {
			const id = i * stride;
			const e: Entry = { id, value: `base_${id}`, origin: 'base' };
			expect(base.insert(e).on, `base insert ${id}`).to.equal(true);
			ids.push(id);
			entries.push({ ...e });	// deep copy for value-level pristine comparisons
		}
		assertTreeInvariants(base);
		return { base, ids, entries };
	}

	/**
	 * A multi-level base with one INTERIOR base-owned leaf grown to exactly capacity (NodeCapacity entries),
	 * by inserting `need` fractional fill keys into the open interval (lo, lo+1) of that leaf (guaranteed to
	 * route there and be absent). Returns:
	 *   - `freshInFull`: a fresh key that also routes into the now-full leaf (so inserting it SPLITS it),
	 *   - `minFillKey` : an integer base key in a different, min-fill (32) interior leaf (so DELETING it
	 *                    forces a borrow/merge against a base-owned sibling).
	 * The two leaves are asserted distinct and base-owned — the raw material for the heaviest single COW op.
	 */
	function makeBaseWithFullLeaf(count: number, stride: number): {
		base: BTree<number, Entry>;
		ids: number[];
		freshInFull: number;
		minFillKey: number;
	} {
		const { base, ids } = makeBase(count, stride);

		// Grow an interior leaf (~25% in) to capacity.
		const fullHint = ids[Math.floor(count / 4)];
		const target = leafForKey(base, fullHint);
		const lo = keyOf(target.entries[0]);
		const need = NodeCapacity - target.entries.length;
		expect(need, 'target leaf must start below capacity').to.be.greaterThan(0);
		for (let k = 1; k <= need; k++) {
			const f = lo + k / (need + 1);	// strictly inside (lo, lo+1) => routes to this leaf, absent
			expect(base.get(f), `fill key ${f} absent`).to.equal(undefined);
			expect(base.insert({ id: f, value: `fill_${f}`, origin: 'base' }).on, `base fill insert ${f}`).to.equal(true);
		}
		const fullLeaf = leafForKey(base, fullHint);
		expect(fullLeaf.entries.length, 'engineered a full base leaf').to.equal(NodeCapacity);
		expect(fullLeaf.owner, 'full leaf is base-owned').to.equal(base.owner);

		const freshInFull = lo + 0.5;	// inside (lo, lo+1), not one of the k/(need+1) fills
		expect(base.get(freshInFull), 'split-trigger key absent from base').to.equal(undefined);
		expect(leafForKey(base, freshInFull), 'split-trigger key routes into the full leaf').to.equal(fullLeaf);

		// A min-fill interior leaf for the delete side of the heaviest op. Probe for a real one rather than
		// guessing by index: in a sequentially-built tree the rightmost leaf can itself be full, so a fixed
		// "3/4 of the way" position is not reliably a 32-fill leaf. Pick the last min-fill leaf that isn't the
		// one we just filled — it is far from the split site, so its sibling is an untouched base leaf at
		// delete time, giving a clean borrow/merge against base-owned structure.
		const minFillLeaves = enumerateLeaves(base).filter(l => l !== fullLeaf && l.entries.length === (NodeCapacity >>> 1));
		expect(minFillLeaves.length, 'a base-owned min-fill interior leaf exists for the delete side').to.be.greaterThan(0);
		const minLeaf = minFillLeaves[minFillLeaves.length - 1];
		expect(minLeaf.owner, 'delete-side leaf is base-owned').to.equal(base.owner);
		const minFillKey = keyOf(minLeaf.entries[minLeaf.entries.length >>> 1]);	// an interior key of that leaf

		assertTreeInvariants(base);
		return { base, ids: liveIds(base), freshInFull, minFillKey };
	}

	// =============================================================================================
	// upsert
	// =============================================================================================
	describe('upsert', () => {
		it('upserts a NEW interior key — clones the base-owned leaf + ancestors, base untouched', () => {
			const { base, ids } = makeBase(300, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const newId = 1505;	// interior gap (between base keys 1500 and 1510), absent
			expect(cow.find(newId).on, 'new key absent before upsert').to.equal(false);
			const path = cow.upsert({ id: newId, value: 'up_new', origin: 'derived' });
			// upsert's path.on contract is the INVERSE of insert's: on=false signals the key was NEWLY inserted
			// (on=true would mean it already existed). See BTree.upsert, src/b-tree.ts.
			expect(path.on, 'upsert of a NEW key reports on=false (was inserted)').to.equal(false);

			expect(cow.get(newId), 'child sees the upserted entry').to.deep.equal({ id: newId, value: 'up_new', origin: 'derived' });
			expect(base.get(newId), 'base never gained the key').to.equal(undefined);
			expect(leafForKey(cow, newId).owner, 'the touched leaf is now child-owned').to.equal(cow.owner);

			expect(liveIds(cow), 'live set is base ∪ {newId}').to.deep.equal([...ids, newId].sort(cmp));
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine').to.deep.equal(ids);
		});

		it('upserts a NEW key into a FULL base-owned leaf — splits it, cloning ancestors into the child', () => {
			const { base, ids, freshInFull } = makeBaseWithFullLeaf(200, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const path = cow.upsert({ id: freshInFull, value: 'up_split', origin: 'derived' });
			expect(path.on, 'upsert of a NEW key reports on=false (was inserted)').to.equal(false);
			expect(cow.get(freshInFull), 'child sees the split-causing upsert').to.deep.equal({ id: freshInFull, value: 'up_split', origin: 'derived' });

			expect(liveIds(cow), 'live set is base ∪ {freshInFull}').to.deep.equal([...ids, freshInFull].sort(cmp));
			expect(cow.root.owner, 'child owns its root after the split cascaded').to.equal(cow.owner);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine after the split happened in the child only').to.deep.equal(ids);
		});

		it('upserts an EXISTING base-owned key (value replace) — base entry object unchanged, child sees new value', () => {
			const { base, ids } = makeBase(300, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const k = 1500;	// a base key
			const baseRef = base.get(k);	// identity captured before the COW write
			expect(baseRef, 'base key present').to.deep.equal({ id: k, value: `base_${k}`, origin: 'base' });

			const path = cow.upsert({ id: k, value: 'up_replaced', origin: 'derived' });
			expect(path.on, 'upsert of existing key reports on').to.equal(true);
			expect(cow.get(k), 'child sees the replaced value').to.deep.equal({ id: k, value: 'up_replaced', origin: 'derived' });

			// Base entry object is the very same frozen object, with its original value.
			expect(base.get(k), 'base entry object identity unchanged').to.equal(baseRef);
			expect(base.get(k), 'base entry value unchanged').to.deep.equal({ id: k, value: `base_${k}`, origin: 'base' });

			expect(liveIds(cow), 'no keys added or removed by a value replace').to.deep.equal(ids);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine').to.deep.equal(ids);
		});
	});

	// =============================================================================================
	// merge
	// =============================================================================================
	describe('merge', () => {
		it('insert-branch: a fresh key is inserted (getUpdated never called)', () => {
			const { base, ids } = makeBase(300, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const newId = 2505;
			let updaterCalled = false;
			const [path, wasUpdate] = cow.merge(
				{ id: newId, value: 'mrg_new', origin: 'derived' },
				(existing) => { updaterCalled = true; return existing; },
			);
			expect(updaterCalled, 'getUpdated NOT called on the insert branch').to.equal(false);
			expect(wasUpdate, 'insert branch reports wasUpdate=false').to.equal(false);
			expect(path.on, 'merge-insert path is live').to.equal(true);
			expect(cow.get(newId), 'child sees the merged-in entry').to.deep.equal({ id: newId, value: 'mrg_new', origin: 'derived' });

			expect(liveIds(cow), 'live set is base ∪ {newId}').to.deep.equal([...ids, newId].sort(cmp));
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine').to.deep.equal(ids);
		});

		it('update-branch on a base-owned key: getUpdated rewrites the value, base object unchanged', () => {
			const { base, ids } = makeBase(300, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const k = 1800;
			const baseRef = base.get(k);
			let sawExisting: Entry | undefined;
			const [path, wasUpdate] = cow.merge(
				{ id: k, value: 'ignored-on-update-branch', origin: 'derived' },
				(existing) => { sawExisting = existing; return { id: k, value: 'mrg_updated', origin: 'derived' }; },
			);
			expect(sawExisting, 'getUpdated received the existing (base) entry').to.deep.equal({ id: k, value: `base_${k}`, origin: 'base' });
			expect(wasUpdate, 'update branch reports wasUpdate=true').to.equal(true);
			expect(path.on, 'update-branch path is live').to.equal(true);
			expect(cow.get(k), 'child sees the merged value').to.deep.equal({ id: k, value: 'mrg_updated', origin: 'derived' });

			expect(base.get(k), 'base entry object identity unchanged').to.equal(baseRef);
			expect(base.get(k), 'base entry value unchanged').to.deep.equal({ id: k, value: `base_${k}`, origin: 'base' });

			expect(liveIds(cow), 'no keys added/removed by an update').to.deep.equal(ids);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine').to.deep.equal(ids);
		});

		it('insert-branch whose insert SPLITS a full base-owned leaf', () => {
			const { base, ids, freshInFull } = makeBaseWithFullLeaf(200, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const [path, wasUpdate] = cow.merge(
				{ id: freshInFull, value: 'mrg_split', origin: 'derived' },
				(existing) => existing,
			);
			expect(wasUpdate, 'a fresh-key merge is an insert').to.equal(false);
			expect(path.on, 'merge-split path is live').to.equal(true);
			expect(cow.get(freshInFull), 'child sees the split-causing merge').to.deep.equal({ id: freshInFull, value: 'mrg_split', origin: 'derived' });

			expect(liveIds(cow), 'live set is base ∪ {freshInFull}').to.deep.equal([...ids, freshInFull].sort(cmp));
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine after the split (child only)').to.deep.equal(ids);
		});

		it('conflict path: getUpdated returns an ALREADY-PRESENT key — no change, path not on', () => {
			const { base, ids } = makeBase(300, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const k = 1500;	// present (the key we merge on)
			const other = 1700;	// present (the colliding key getUpdated tries to move k onto)
			const kRef = base.get(k);
			const otherRef = base.get(other);

			const [path, wasUpdate] = cow.merge(
				{ id: k, value: 'x', origin: 'derived' },
				() => ({ id: other, value: 'collision', origin: 'derived' }),	// key-change onto an occupied key
			);
			// internalUpdate -> key changed -> internalInsert(other) finds `other` present -> conflict (on=false),
			// so the original is NOT removed and the colliding entry is NOT touched.
			expect(wasUpdate, 'conflict reports wasUpdate=false').to.equal(false);
			expect(path.on, 'conflict path is NOT on (lands "near" the existing key)').to.equal(false);

			// Both keys survive untouched; the tree is exactly the base set.
			expect(cow.get(k), 'k still present, unchanged').to.deep.equal({ id: k, value: `base_${k}`, origin: 'base' });
			expect(cow.get(other), 'colliding key untouched').to.deep.equal({ id: other, value: `base_${other}`, origin: 'base' });
			expect(base.get(k), 'base k identity unchanged').to.equal(kRef);
			expect(base.get(other), 'base other identity unchanged').to.equal(otherRef);

			expect(liveIds(cow), 'no net change from a conflicting merge').to.deep.equal(ids);
			if (hasLocalRoot(cow)) assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine').to.deep.equal(ids);
		});
	});

	// =============================================================================================
	// updateAt — same key (value replace) deep in a base-owned leaf
	// =============================================================================================
	describe('updateAt same-key (value replace)', () => {
		it('replaces a value deep in a base-owned leaf, cloning ONLY the touched spine', () => {
			const { base, ids } = makeBase(400, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const k = 2000;	// deep interior base key
			const baseRef = base.get(k);
			const path = cow.find(k);
			expect(path.on, 'target key present').to.equal(true);

			const [resultPath, wasUpdate] = cow.updateAt(path, { id: k, value: 'ua_same', origin: 'derived' });
			expect(wasUpdate, 'same-key updateAt is an update').to.equal(true);
			expect(resultPath.on, 'result path on the entry').to.equal(true);
			expect(cow.get(k), 'child sees the new value').to.deep.equal({ id: k, value: 'ua_same', origin: 'derived' });

			// "clones only the touched spine": exactly leaf + ancestor branches (depth + 1) are child-owned.
			const spine = depthOf(cow.root) + 1;
			expect(countOwned(cow.root, cow), 'only the leaf + its ancestors were cloned').to.equal(spine);

			expect(base.get(k), 'base entry object identity unchanged').to.equal(baseRef);
			expect(base.get(k), 'base entry value unchanged').to.deep.equal({ id: k, value: `base_${k}`, origin: 'base' });

			expect(liveIds(cow), 'no keys added/removed').to.deep.equal(ids);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine').to.deep.equal(ids);
		});
	});

	// =============================================================================================
	// updateAt — key change (the heaviest single COW op)
	// =============================================================================================
	describe('updateAt key-change', () => {
		it('moves a key to a different base-owned leaf, keeping base + child consistent', () => {
			const { base, ids } = makeBase(300, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			const oldId = 500;	// present
			const newId = 2503;	// absent, far away (different base-owned leaf region)
			const path = cow.find(oldId);
			expect(path.on, 'old key present').to.equal(true);

			const [resultPath, wasUpdate] = cow.updateAt(path, { id: newId, value: 'ua_moved', origin: 'derived' });
			expect(wasUpdate, 'a key change is reported as an insert (wasUpdate=false)').to.equal(false);
			expect(resultPath.on, 'result path lands on the new entry').to.equal(true);

			expect(cow.get(oldId), 'old key gone from child').to.equal(undefined);
			expect(cow.get(newId), 'new key present in child').to.deep.equal({ id: newId, value: 'ua_moved', origin: 'derived' });

			const expected = ids.filter(k => k !== oldId).concat(newId).sort(cmp);
			expect(liveIds(cow), 'live set is base − old + new').to.deep.equal(expected);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base pristine (still has old, never had new)').to.deep.equal(ids);
		});

		// The heaviest single COW op: ONE updateAt whose insert side SPLITS a full base-owned leaf AND whose
		// delete side rebalances (borrow/merge) a min-fill leaf against a base-owned sibling. The base
		// construction asserts both preconditions, so the op is guaranteed to drive both clone paths at once.
		it('insert SPLITS a full leaf while the delete REBALANCES a base-owned sibling — spine stays connected', () => {
			const { base, ids, freshInFull, minFillKey } = makeBaseWithFullLeaf(256, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			// Sanity: the two leaves involved are distinct, base-owned, and at the fills we engineered.
			expect(leafForKey(base, freshInFull).entries.length, 'insert side targets a full leaf').to.equal(NodeCapacity);
			expect(leafForKey(base, minFillKey).entries.length, 'delete side targets a min-fill leaf').to.equal(NodeCapacity >>> 1);
			expect(leafForKey(base, freshInFull)).to.not.equal(leafForKey(base, minFillKey));

			// Capture the base-owned insert-side leaf so we can prove post-hoc that the split actually fired —
			// not merely that invariants happen to hold afterward (guards against a future refactor that changes
			// the precondition semantics and silently stops splitting). The robust signal is independent of
			// whether the delete side borrows or merges.
			const fullLeafBefore = leafForKey(base, freshInFull);

			const path = cow.find(minFillKey);
			expect(path.on, 'old key present').to.equal(true);

			// One operation: remove `minFillKey` (forces rebalance) and add `freshInFull` (forces split).
			const [resultPath, wasUpdate] = cow.updateAt(path, { id: freshInFull, value: 'ua_heavy', origin: 'derived' });
			expect(wasUpdate, 'key change reported as insert').to.equal(false);
			expect(resultPath.on, 'result lands on the new entry').to.equal(true);

			expect(cow.get(minFillKey), 'old (min-fill-leaf) key removed').to.equal(undefined);
			expect(cow.get(freshInFull), 'new (split) key present').to.deep.equal({ id: freshInFull, value: 'ua_heavy', origin: 'derived' });

			const expected = ids.filter(k => k !== minFillKey).concat(freshInFull).sort(cmp);
			expect(liveIds(cow), 'live set is base − minFillKey + freshInFull').to.deep.equal(expected);

			// Explicit proof the insert side actually SPLIT the full leaf (not just that invariants happen to
			// hold): the child's leaf now holding freshInFull is a fresh child-owned node, distinct from the
			// base's still-full leaf, and is itself below capacity (the 64-entry leaf was divided). The base's
			// original leaf is untouched at capacity. This is robust regardless of how the delete side rebalances.
			const splitLeaf = leafForKey(cow, freshInFull);
			expect(splitLeaf.owner, 'split produced a child-owned leaf').to.equal(cow.owner);
			expect(splitLeaf, 'split leaf is a clone, not the base leaf').to.not.equal(fullLeafBefore);
			expect(splitLeaf.entries.length, 'the full (64) leaf was split, so its halves are below capacity').to.be.lessThan(NodeCapacity);
			expect(fullLeafBefore.entries.length, 'base full leaf untouched at capacity').to.equal(NodeCapacity);
			expect(fullLeafBefore.owner, 'base full leaf still base-owned').to.equal(base.owner);

			// The heaviest path must leave the child well-formed, its spine connected & base-disjoint, base pristine.
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveIds(base), 'base untouched by the heaviest single op').to.deep.equal(ids);
		});

		it('full ordered set stays correct after every individual key-change (scattered)', () => {
			const { base, ids } = makeBase(200, 10);
			const cow = new BTree<number, Entry>(keyOf, cmp, { base });
			const snap = snapshotBase(base);

			// Move a scattered subset of base keys each to a fresh interior gap key (oldId+5), one at a time,
			// re-verifying the FULL ordered set (both directions) + ownership after every single op.
			const rng = lcg(0x5CA77E5);
			const present = new Set(ids);
			const order: number[] = [];
			for (let i = 0; i < 60; i++) {
				const k = ids[lcgInt(rng, 0, ids.length)];
				if (present.has(k) && !present.has(k + 5)) order.push(k);
			}

			for (const oldId of order) {
				if (!present.has(oldId)) continue;	// could have been moved already
				const newId = oldId + 5;	// fresh interior gap (base keys are multiples of 10)
				if (present.has(newId)) continue;
				const path = cow.find(oldId);
				expect(path.on, `key ${oldId} present before move`).to.equal(true);
				const [rp, wasUpdate] = cow.updateAt(path, { id: newId, value: `mv_${oldId}_${newId}`, origin: 'derived' });
				expect(wasUpdate, `move ${oldId}->${newId} is an insert`).to.equal(false);
				expect(rp.on, `move ${oldId}->${newId} landed`).to.equal(true);
				present.delete(oldId);
				present.add(newId);

				const expected = [...present].sort(cmp);
				expect(liveIds(cow), `ordered set after moving ${oldId}->${newId}`).to.deep.equal(expected);
				assertOwnershipInvariant(cow, base, snap);
			}

			assertTreeInvariants(cow);
			expect(liveIds(base), 'base untouched through the whole sequence').to.deep.equal(ids);
		});
	});

	// =============================================================================================
	// Seeded mixed stream (upsert / merge / updateAt-same / updateAt-keychange / delete / insert)
	// vs. a shadow Map — sampling invariants + ownership + base-pristine throughout.
	// =============================================================================================
	describe('seeded mixed-mutation stream vs. shadow Map', () => {
		const BASE_COUNT = 300;
		const BASE_STRIDE = 10;
		const NUM_OPS = 900;
		const FLOOR = NodeCapacity * 3;	// keep the child comfortably multi-level
		const CHECK_INTERVAL = 20;
		const SEEDS = [0xC0FFEE, 0x9E3779B1];

		for (const seed of SEEDS) {
			it(`stays consistent over ${NUM_OPS} mixed ops [seed 0x${seed.toString(16)}]`, function () {
				this.timeout(20000);
				const tag = `[seed 0x${seed.toString(16)}]`;
				const rng = lcg(seed);

				const { base, ids } = makeBase(BASE_COUNT, BASE_STRIDE);
				const baseEntries = liveSet(base).map(e => ({ ...e }));	// deep copy for value-level pristine checks
				const cow = new BTree<number, Entry>(keyOf, cmp, { base });
				const snap = snapshotBase(base);

				// Shadow mirrors expected child state; seed it with the base.
				const shadow = new Map<number, Entry>();
				for (const e of baseEntries) shadow.set(e.id, { ...e });

				let uid = 0;	// guarantees freshly-generated keys never collide
				const freshKey = (): number => {
					// Interior fractional keys (never a base multiple-of-stride, never previously issued).
					const k = lcgInt(rng, 1, BASE_COUNT * BASE_STRIDE) + (++uid) / 100000;
					return k;
				};
				const presentKeys = (): number[] => Array.from(shadow.keys());
				const pickPresent = (): number => {
					const keys = presentKeys();
					return keys[lcgInt(rng, 0, keys.length)];
				};

				const verify = (op: number) => {
					const ctx = `${tag} @op${op}`;
					if (hasLocalRoot(cow)) assertTreeInvariants(cow);
					assertOwnershipInvariant(cow, base, snap);
					const actual = liveSet(cow);
					const expected = Array.from(shadow.values()).sort(byId);
					expect(actual, `child matches shadow ${ctx}`).to.deep.equal(expected);
					expect(liveSet(base), `base value-pristine ${ctx}`).to.deep.equal(baseEntries);
				};

				verify(-1);	// initial: child reflects base exactly

				for (let i = 0; i < NUM_OPS; i++) {
					let roll = lcgInt(rng, 0, 100);
					if (shadow.size <= FLOOR) roll = 5;	// force an INSERT to stay multi-level

					if (roll < 20) {
						// INSERT a fresh key.
						const id = freshKey();
						const e: Entry = { id, value: `ins_${id}_op${i}`, origin: 'derived' };
						expect(cow.find(id).on, `${tag} fresh ${id} absent @op${i}`).to.equal(false);
						expect(cow.insert(e).on, `${tag} insert ${id} @op${i}`).to.equal(true);
						shadow.set(id, e);
					} else if (roll < 35 && shadow.size >= 2) {
						// DELETE a present key.
						const id = pickPresent();
						const path = cow.find(id);
						expect(path.on, `${tag} ${id} present before delete @op${i}`).to.equal(true);
						expect(cow.deleteAt(path), `${tag} delete ${id} @op${i}`).to.equal(true);
						shadow.delete(id);
					} else if (roll < 50) {
						// UPSERT — half existing (value replace), half fresh (insert).
						if (lcgInt(rng, 0, 2) === 0 && shadow.size > 0) {
							const id = pickPresent();
							const e: Entry = { id, value: `ups_${id}_op${i}`, origin: 'derived' };
							expect(cow.upsert(e).on, `${tag} upsert-existing ${id} @op${i}`).to.equal(true);
							shadow.set(id, e);
						} else {
							const id = freshKey();
							const e: Entry = { id, value: `upn_${id}_op${i}`, origin: 'derived' };
							// upsert reports on=false for a newly-inserted key (inverse of insert's contract).
							expect(cow.upsert(e).on, `${tag} upsert-new ${id} reports on=false @op${i}`).to.equal(false);
							shadow.set(id, e);
						}
					} else if (roll < 65) {
						// MERGE — half existing (getUpdated rewrites), half fresh (insert).
						if (lcgInt(rng, 0, 2) === 0 && shadow.size > 0) {
							const id = pickPresent();
							const updated: Entry = { id, value: `mru_${id}_op${i}`, origin: 'derived' };
							const [, wasUpdate] = cow.merge({ id, value: 'x', origin: 'derived' }, () => updated);
							expect(wasUpdate, `${tag} merge-existing ${id} wasUpdate @op${i}`).to.equal(true);
							shadow.set(id, updated);
						} else {
							const id = freshKey();
							const e: Entry = { id, value: `mri_${id}_op${i}`, origin: 'derived' };
							const [, wasUpdate] = cow.merge(e, (existing) => existing);
							expect(wasUpdate, `${tag} merge-new ${id} wasUpdate @op${i}`).to.equal(false);
							shadow.set(id, e);
						}
					} else if (roll < 80 && shadow.size > 0) {
						// UPDATEAT same-key value replace.
						const id = pickPresent();
						const path = cow.find(id);
						expect(path.on, `${tag} ${id} present before same-update @op${i}`).to.equal(true);
						const e: Entry = { id, value: `uas_${id}_op${i}`, origin: 'derived' };
						const [, wasUpdate] = cow.updateAt(path, e);
						expect(wasUpdate, `${tag} same-key updateAt ${id} @op${i}`).to.equal(true);
						shadow.set(id, e);
					} else if (shadow.size > 0) {
						// UPDATEAT key-change: present old -> fresh new.
						const oldId = pickPresent();
						const newId = freshKey();
						const path = cow.find(oldId);
						expect(path.on, `${tag} ${oldId} present before key-change @op${i}`).to.equal(true);
						const e: Entry = { id: newId, value: `uak_${oldId}->${newId}_op${i}`, origin: 'derived' };
						const [rp, wasUpdate] = cow.updateAt(path, e);
						expect(wasUpdate, `${tag} key-change ${oldId}->${newId} wasUpdate=false @op${i}`).to.equal(false);
						expect(rp.on, `${tag} key-change ${oldId}->${newId} landed @op${i}`).to.equal(true);
						shadow.delete(oldId);
						shadow.set(newId, e);
					}

					if (i % CHECK_INTERVAL === 0 || i === NUM_OPS - 1) verify(i);
				}

				// Final full verification.
				const finalExpected = Array.from(shadow.values()).sort(byId);
				expect(liveSet(cow), `${tag} final child matches shadow`).to.deep.equal(finalExpected);
				expect(cow.getCount(), `${tag} final count matches shadow`).to.equal(shadow.size);
				expect(liveSet(base), `${tag} base value-pristine at end`).to.deep.equal(baseEntries);
				expect(liveIds(base), `${tag} base key-pristine at end`).to.deep.equal(ids);
			});
		}
	});
});
