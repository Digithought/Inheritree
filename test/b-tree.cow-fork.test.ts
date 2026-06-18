import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { BranchNode, ITreeNode, LeafNode } from '../src/nodes.js';
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt, shuffle } from './helpers/rng.js';

/**
 * Regression + property suite for two copy-on-write shapes the rest of the COW suites never exercise,
 * both central to why this library exists (inheritance + forking):
 *
 *   1. MULTI-CHILD FORK. Two (or more) COW children forked off the *same* base and mutated
 *      independently. This is the classic aliasing bug: child A's rebalance/split accidentally mutates a
 *      node still shared with `base`, so child B (or `base`) sees the corruption. Because every child reads
 *      the shared base through `base.root` (src/b-tree.ts), correctness hinges entirely on COW never
 *      mutating a base-owned node in place. The cow-delete / cow-insert / cow-mutation suites each test a
 *      *single* child against its base; none proves two live children stay mutually isolated.
 *
 *   2. DEEP CHAINS. `test/b-tree.cow-delete.test.ts` covers base -> mid -> leaf (3 trees). Chains of
 *      4-5 trees (base -> c1 -> c2 -> c3 -> c4), where a mutation on the deepest child must clone rootward
 *      through several *un-owned* ancestor levels, are uncovered. The most dangerous case is a delete on the
 *      deepest child that borrows/merges against a sibling still owned several levels up the chain — the
 *      exact rootward-clone-through-unowned-ancestors path the escaped COW-delete bug lived in
 *      (`replaceRootward` / `mutableLeaf` / `mutableBranch`, src/b-tree.ts).
 *
 * Every case builds a genuinely multi-level base (NodeCapacity is 64; sizes are chosen well above it) and,
 * after each step, asserts functional correctness (live set in BOTH directions), structural well-formedness
 * (`assertTreeInvariants`), connected & base-disjoint ownership (`assertOwnershipInvariant`), and that every
 * ancestor is left pristine against a pre-mutation snapshot. Inserts/deletes are NON-front-anchored: a
 * front-anchored `id <= k` delete only ever borrows/merges with a right sibling, dodging the bug class.
 */
describe('BTree COW multi-child fork & deep inheritance chains', () => {
	interface Entry {
		id: number;
		value: string;
		tag: string;	// origin marker (base / A / B / c1.. / op id) — lets value-isolation be asserted
	}

	const keyOf = (e: Entry): number => e.id;
	const cmp = (a: number, b: number): number => a - b;
	const byId = (a: Entry, b: Entry): number => a.id - b.id;

	// --- structural probes ---

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
			n = (n as BranchNode<number>).nodes[0];
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

	/** The node chain (root -> ... -> leaf) a key routes through, descending from a tree's *effective* root
	 * (`tree.root`, which falls through to the base for an unwritten child). Used to prove the deepest
	 * child's cloned spine is owned all the way down to the touched leaf. */
	function nodeChainToKey(tree: BTree<number, Entry>, key: number): ITreeNode[] {
		const chain: ITreeNode[] = [];
		let node: ITreeNode | undefined = tree.root;
		while (node) {
			chain.push(node);
			if (node instanceof BranchNode) {
				const b = node as BranchNode<number>;
				node = b.nodes[childIndex(b.partitions, key)];
			} else {
				break;
			}
		}
		return chain;
	}

	/** The leaf a key routes to, descending from a tree's effective root. */
	function leafForKey(tree: BTree<number, Entry>, key: number): LeafNode<Entry> {
		return nodeChainToKey(tree, key).at(-1) as LeafNode<Entry>;
	}

	/** All leaf nodes under `root`, left-to-right. */
	function enumerateLeaves(root: ITreeNode): LeafNode<Entry>[] {
		const out: LeafNode<Entry>[] = [];
		const visit = (node: ITreeNode): void => {
			if (node instanceof BranchNode) {
				for (const c of (node as BranchNode<number>).nodes) visit(c);
			} else {
				out.push(node as LeafNode<Entry>);
			}
		};
		visit(root);
		return out;
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

	// --- base builder ---

	/** A genuinely multi-level base of object entries with ids `stride, 2*stride, ..., count*stride`,
	 * leaving `stride - 1` integer gaps between consecutive base keys for fresh interior inserts. */
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
			entries.push({ ...e });	// unfrozen copy for value-level pristine comparisons
		}
		assertTreeInvariants(base);
		return { base, ids, entries };
	}

	// =============================================================================================
	// 1. Multi-child fork isolation
	// =============================================================================================
	describe('multi-child fork isolation', () => {
		// Two children A and B forked off ONE multi-level base, mutated with DIFFERENT, key-disjoint,
		// non-front-anchored op sets, interleaved. After every single step we re-verify BOTH children
		// against their own shadow, the base pristine, and ownership for both — the strongest form of
		// "A's rebalance never mutated a node B (or base) still shares".
		type Op = { kind: 'del' | 'ins' | 'up'; id: number };

		function applyOp(child: BTree<number, Entry>, shadow: Map<number, Entry>, who: string, op: Op): void {
			if (op.kind === 'del') {
				const p = child.find(op.id);
				expect(p.on, `${who}: key ${op.id} present before delete`).to.equal(true);
				expect(child.deleteAt(p), `${who}: deleteAt ${op.id}`).to.equal(true);
				shadow.delete(op.id);
			} else if (op.kind === 'ins') {
				expect(child.find(op.id).on, `${who}: key ${op.id} absent before insert`).to.equal(false);
				const e: Entry = { id: op.id, value: `${who}_ins_${op.id}`, tag: who };
				expect(child.insert(e).on, `${who}: insert ${op.id}`).to.equal(true);
				shadow.set(op.id, e);
			} else {	// up = upsert an EXISTING base key (value replace) — must not leak to the sibling child
				const e: Entry = { id: op.id, value: `${who}_up_${op.id}`, tag: who };
				const p = child.upsert(e);
				expect(p.on, `${who}: upsert of existing key ${op.id} reports on=true`).to.equal(true);
				shadow.set(op.id, e);
			}
		}

		it('two children mutated independently stay mutually isolated; base stays pristine', () => {
			const { base, ids, entries } = makeBase(400, 10);	// keys 10..4000, multi-level
			const a = new BTree<number, Entry>(keyOf, cmp, base);
			const b = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);	// one snapshot; neither child may ever mutate the base

			// Key-disjoint op sets (A's keys and B's keys never overlap), each non-front-anchored
			// (scattered interior deletes, interior-gap inserts, and one value-replace upsert).
			const aOps: Op[] = [
				{ kind: 'del', id: 520 }, { kind: 'ins', id: 515 }, { kind: 'del', id: 1230 },
				{ kind: 'up', id: 700 }, { kind: 'ins', id: 1235 }, { kind: 'del', id: 2780 },
				{ kind: 'ins', id: 2785 }, { kind: 'del', id: 3340 },
			];
			const bOps: Op[] = [
				{ kind: 'del', id: 330 }, { kind: 'ins', id: 335 }, { kind: 'del', id: 1660 },
				{ kind: 'up', id: 900 }, { kind: 'ins', id: 1665 }, { kind: 'del', id: 2110 },
				{ kind: 'ins', id: 2115 }, { kind: 'del', id: 3870 },
			];
			// Guard the premise: A's and B's touched keys are genuinely disjoint.
			const aKeys = new Set(aOps.map(o => o.id));
			const bKeys = new Set(bOps.map(o => o.id));
			for (const k of aKeys) expect(bKeys.has(k), `op key ${k} must be A-only`).to.equal(false);

			const shadowA = new Map<number, Entry>(entries.map(e => [e.id, { ...e }]));
			const shadowB = new Map<number, Entry>(entries.map(e => [e.id, { ...e }]));

			const verifyBoth = (ctx: string): void => {
				if (hasLocalRoot(a)) assertTreeInvariants(a);
				if (hasLocalRoot(b)) assertTreeInvariants(b);
				assertOwnershipInvariant(a, base, snap);
				assertOwnershipInvariant(b, base, snap);
				expect(liveSet(a), `A matches its shadow ${ctx}`).to.deep.equal(Array.from(shadowA.values()).sort(byId));
				expect(liveSet(b), `B matches its shadow ${ctx}`).to.deep.equal(Array.from(shadowB.values()).sort(byId));
				expect(liveSet(base), `base value-pristine ${ctx}`).to.deep.equal(entries);
			};

			verifyBoth('@start');	// both children reflect base exactly before any write
			for (let i = 0; i < Math.max(aOps.length, bOps.length); i++) {
				if (i < aOps.length) {
					applyOp(a, shadowA, 'A', aOps[i]);
					verifyBoth(`after A op ${i} (${aOps[i].kind} ${aOps[i].id})`);
				}
				if (i < bOps.length) {
					applyOp(b, shadowB, 'B', bOps[i]);
					verifyBoth(`after B op ${i} (${bOps[i].kind} ${bOps[i].id})`);
				}
			}

			// Explicit cross-isolation: each child's mutations are invisible to the other.
			// A deleted 520 -> still present in B, with its ORIGINAL base value.
			expect(b.get(520), "A's delete of 520 is invisible to B").to.deep.equal({ id: 520, value: 'base_520', tag: 'base' });
			// A inserted 515 -> absent from B (and from base).
			expect(b.get(515), "A's insert of 515 is invisible to B").to.equal(undefined);
			expect(base.get(515), "A's insert of 515 never reached base").to.equal(undefined);
			// A value-replaced 700 -> B still sees the base value (value isolation, not just key isolation).
			expect(b.get(700), "A's value-replace of 700 is invisible to B").to.deep.equal({ id: 700, value: 'base_700', tag: 'base' });
			// Symmetric: B's mutations are invisible to A.
			expect(a.get(330), "B's delete of 330 is invisible to A").to.deep.equal({ id: 330, value: 'base_330', tag: 'base' });
			expect(a.get(335), "B's insert of 335 is invisible to A").to.equal(undefined);
			expect(a.get(900), "B's value-replace of 900 is invisible to A").to.deep.equal({ id: 900, value: 'base_900', tag: 'base' });

			// Final sets are exactly base +/- each child's own ops, base untouched key-wise.
			expect(liveIds(base), 'base key set untouched by either child').to.deep.equal(ids);
		});
	});

	// =============================================================================================
	// 2. Concurrent children stress (3+ children over an interleaved seeded op stream)
	// =============================================================================================
	describe('concurrent children stress (interleaved seeded stream)', () => {
		// Four children forked off one base, advanced round-robin over a single seeded op stream, each with
		// its own shadow Map. A node aliased between any two children (or into the base) would surface as a
		// child diverging from its shadow, a base mutation, or an ownership-invariant violation.
		const NUM_CHILDREN = 4;
		const BASE_COUNT = 300;
		const BASE_STRIDE = 10;	// keys 10..3000
		const OPS = 640;
		const CHECK_INTERVAL = 20;
		const FLOOR = NodeCapacity * 2;	// keep each child comfortably multi-level

		for (const seed of [0xC0FFEE, 0x1234ABCD]) {
			it(`each of ${NUM_CHILDREN} children matches its own shadow over ${OPS} ops [seed 0x${seed.toString(16)}]`, function () {
				this.timeout(30000);
				const tag = `[seed 0x${seed.toString(16)}]`;
				const rng = lcg(seed);

				const { base, ids, entries } = makeBase(BASE_COUNT, BASE_STRIDE);
				const snap = snapshotBase(base);

				const children = Array.from({ length: NUM_CHILDREN }, () => new BTree<number, Entry>(keyOf, cmp, base));
				const shadows = children.map(() => new Map<number, Entry>(entries.map(e => [e.id, { ...e }])));

				let uid = 0;	// globally-unique suffix so a freshly-generated key is never already present anywhere
				const freshKey = (): number => lcgInt(rng, 1, BASE_COUNT * BASE_STRIDE) + (++uid) / 1_000_000;
				const pickPresent = (shadow: Map<number, Entry>): number => {
					const keys = Array.from(shadow.keys());
					return keys[lcgInt(rng, 0, keys.length)];
				};

				const verifyAll = (ctx: string): void => {
					for (let c = 0; c < NUM_CHILDREN; c++) {
						if (hasLocalRoot(children[c])) assertTreeInvariants(children[c]);
						assertOwnershipInvariant(children[c], base, snap);
						expect(liveSet(children[c]), `child ${c} matches shadow ${ctx}`)
							.to.deep.equal(Array.from(shadows[c].values()).sort(byId));
					}
					expect(liveSet(base), `base value-pristine ${ctx}`).to.deep.equal(entries);
				};

				verifyAll('@start');
				for (let i = 0; i < OPS; i++) {
					const c = i % NUM_CHILDREN;	// round-robin: every child interleaves on the same stream
					const child = children[c];
					const shadow = shadows[c];
					let roll = lcgInt(rng, 0, 100);
					if (shadow.size <= FLOOR) roll = 5;	// force an INSERT to keep the child multi-level

					if (roll < 30) {
						// INSERT a fresh interior key.
						const id = freshKey();
						const e: Entry = { id, value: `c${c}_ins_${id}_op${i}`, tag: `c${c}` };
						expect(child.find(id).on, `${tag} c${c} fresh ${id} absent @op${i}`).to.equal(false);
						expect(child.insert(e).on, `${tag} c${c} insert ${id} @op${i}`).to.equal(true);
						shadow.set(id, e);
					} else if (roll < 50 && shadow.size >= 2) {
						// DELETE a present key (the rebalance path).
						const id = pickPresent(shadow);
						const p = child.find(id);
						expect(p.on, `${tag} c${c} ${id} present before delete @op${i}`).to.equal(true);
						expect(child.deleteAt(p), `${tag} c${c} delete ${id} @op${i}`).to.equal(true);
						shadow.delete(id);
					} else if (roll < 70) {
						// UPSERT — existing (value replace) or fresh (insert).
						if (lcgInt(rng, 0, 2) === 0 && shadow.size > 0) {
							const id = pickPresent(shadow);
							const e: Entry = { id, value: `c${c}_ups_${id}_op${i}`, tag: `c${c}` };
							expect(child.upsert(e).on, `${tag} c${c} upsert-existing ${id} @op${i}`).to.equal(true);
							shadow.set(id, e);
						} else {
							const id = freshKey();
							const e: Entry = { id, value: `c${c}_upn_${id}_op${i}`, tag: `c${c}` };
							// upsert reports on=false for a newly-inserted key (inverse of insert's contract).
							expect(child.upsert(e).on, `${tag} c${c} upsert-new ${id} reports on=false @op${i}`).to.equal(false);
							shadow.set(id, e);
						}
					} else if (roll < 85 && shadow.size > 0) {
						// UPDATEAT same-key value replace.
						const id = pickPresent(shadow);
						const p = child.find(id);
						expect(p.on, `${tag} c${c} ${id} present before same-update @op${i}`).to.equal(true);
						const e: Entry = { id, value: `c${c}_uas_${id}_op${i}`, tag: `c${c}` };
						const [, wasUpdate] = child.updateAt(p, e);
						expect(wasUpdate, `${tag} c${c} same-key updateAt ${id} @op${i}`).to.equal(true);
						shadow.set(id, e);
					} else if (shadow.size > 0) {
						// UPDATEAT key-change: present old -> fresh new (heaviest single COW op).
						const oldId = pickPresent(shadow);
						const newId = freshKey();
						const p = child.find(oldId);
						expect(p.on, `${tag} c${c} ${oldId} present before key-change @op${i}`).to.equal(true);
						const e: Entry = { id: newId, value: `c${c}_uak_${oldId}->${newId}_op${i}`, tag: `c${c}` };
						const [rp, wasUpdate] = child.updateAt(p, e);
						expect(wasUpdate, `${tag} c${c} key-change ${oldId}->${newId} wasUpdate=false @op${i}`).to.equal(false);
						expect(rp.on, `${tag} c${c} key-change ${oldId}->${newId} landed @op${i}`).to.equal(true);
						shadow.delete(oldId);
						shadow.set(newId, e);
					}

					if (i % CHECK_INTERVAL === 0 || i === OPS - 1) verifyAll(`${tag} @op${i}`);
				}

				// Final full verification + the base's key set is byte-for-byte the original.
				verifyAll(`${tag} @final`);
				expect(liveIds(base), `${tag} base key-pristine at end`).to.deep.equal(ids);
			});
		}
	});

	// =============================================================================================
	// 3. Deep inheritance chains (base -> c1 -> c2 -> c3 -> c4)
	// =============================================================================================
	describe('deep inheritance chains (base -> c1 -> c2 -> c3 -> c4)', () => {
		const DEEP_COUNT = 3000;
		const DEEP_STRIDE = 10;	// keys 10..30000

		/** base ∪ extra, sorted — the expected id list for a level that adds `extra` to its parent's ids. */
		function withIds(parentIds: number[], extra: number[]): number[] {
			return [...parentIds, ...extra].sort(cmp);
		}

		it('interior mutations on the deepest child isolate every ancestor; spine connects through un-owned levels', () => {
			const { base, ids: baseIds, entries: baseEntries } = makeBase(DEEP_COUNT, DEEP_STRIDE);
			expect(depthOf(base.root), 'base is at least 3 node-levels deep (root -> branch -> leaf)').to.be.greaterThanOrEqual(2);
			const snapBase = snapshotBase(base);

			// c1, c2, c3 each insert a few fresh interior keys in DISTINCT, well-separated regions, so each
			// owns part of the spine while inheriting the rest. c4 then mutates a region NONE of them touched.
			const c1Ins = [6005, 6015, 6025];
			const c2Ins = [12005, 12015, 12025];
			const c3Ins = [18005, 18015, 18025];
			const c4Ins = [24005, 24015, 24025];	// untouched region -> whole rootward path is base-owned at clone time
			const c4Del = [3010, 3020, 3030, 3040, 3050, 3060, 3070, 3080, 3090, 3100];	// dense interior band -> forces rebalance

			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			for (const id of c1Ins) expect(c1.insert({ id, value: `c1_${id}`, tag: 'c1' }).on, `c1 insert ${id}`).to.equal(true);
			const c1Expected = withIds(baseIds, c1Ins);
			expect(liveIds(c1), 'c1 state').to.deep.equal(c1Expected);
			assertTreeInvariants(c1);
			assertOwnershipInvariant(c1, base, snapBase);
			const snapC1 = snapshotBase(c1);

			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
			for (const id of c2Ins) expect(c2.insert({ id, value: `c2_${id}`, tag: 'c2' }).on, `c2 insert ${id}`).to.equal(true);
			const c2Expected = withIds(c1Expected, c2Ins);
			expect(liveIds(c2), 'c2 state').to.deep.equal(c2Expected);
			assertTreeInvariants(c2);
			assertOwnershipInvariant(c2, c1, snapC1);
			const snapC2 = snapshotBase(c2);

			const c3 = new BTree<number, Entry>(keyOf, cmp, c2);
			for (const id of c3Ins) expect(c3.insert({ id, value: `c3_${id}`, tag: 'c3' }).on, `c3 insert ${id}`).to.equal(true);
			const c3Expected = withIds(c2Expected, c3Ins);
			expect(liveIds(c3), 'c3 state').to.deep.equal(c3Expected);
			assertTreeInvariants(c3);
			assertOwnershipInvariant(c3, c2, snapC2);
			const snapC3 = snapshotBase(c3);

			// The deepest child: interior inserts AND a dense interior delete band, both far from any
			// ancestor's writes — so the rootward clone must pass through several base-owned ancestor levels.
			const c4 = new BTree<number, Entry>(keyOf, cmp, c3);
			for (const id of c4Ins) expect(c4.insert({ id, value: `c4_${id}`, tag: 'c4' }).on, `c4 insert ${id}`).to.equal(true);
			for (const id of c4Del) {
				const p = c4.find(id);
				expect(p.on, `c4 key ${id} present before delete`).to.equal(true);
				expect(c4.deleteAt(p), `c4 delete ${id}`).to.equal(true);
			}
			const c4Expected = withIds(c3Expected, c4Ins).filter(k => !c4Del.includes(k));
			expect(liveIds(c4), 'c4 state').to.deep.equal(c4Expected);
			assertTreeInvariants(c4);

			// The deepest child's spine is connected through every un-owned ancestor level it cloned: the path
			// from c4.root down to a key it inserted in the untouched region is owned by c4 at EVERY node (a
			// fresh clone of what was a base-owned branch/leaf), and it is genuinely several levels long.
			const chain = nodeChainToKey(c4, c4Ins[0]);
			expect(chain.length, 'rootward spine spans several node levels').to.be.greaterThanOrEqual(depthOf(base.root) + 1);
			for (let level = 0; level < chain.length; level++) {
				expect(chain[level].tree, `spine node at level ${level} is owned by the deepest child`).to.equal(c4);
			}

			// Whole-chain ownership + every ancestor pristine (key set AND value set), validated against the
			// snapshot captured before each level mutated.
			assertOwnershipInvariant(c4, c3, snapC3);
			assertOwnershipInvariant(c3, c2, snapC2);
			assertOwnershipInvariant(c2, c1, snapC1);
			assertOwnershipInvariant(c1, base, snapBase);

			expect(liveIds(c3), 'c3 unaffected by deepest-child mutations').to.deep.equal(c3Expected);
			expect(liveIds(c2), 'c2 unaffected by deepest-child mutations').to.deep.equal(c2Expected);
			expect(liveIds(c1), 'c1 unaffected by deepest-child mutations').to.deep.equal(c1Expected);
			expect(liveSet(base), 'base value-pristine through the whole chain').to.deep.equal(baseEntries);
		});

		it('a delete on the deepest child borrows/merges against an ancestor-owned sibling (rootward clone through un-owned ancestors)', () => {
			const { base, ids: baseIds, entries: baseEntries } = makeBase(DEEP_COUNT, DEEP_STRIDE);
			expect(depthOf(base.root), 'base is at least 3 node-levels deep').to.be.greaterThanOrEqual(2);
			const snapBase = snapshotBase(base);

			// Ancestors write only in the HIGH region; the delete target sits in an untouched LOW interior
			// leaf, so the sibling it rebalances against is owned several COW-levels up (by the base).
			const c1Ins = [25005, 25015];
			const c2Ins = [26005, 26015];
			const c3Ins = [27005, 27015];

			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			for (const id of c1Ins) expect(c1.insert({ id, value: `c1_${id}`, tag: 'c1' }).on, `c1 insert ${id}`).to.equal(true);
			const c1Expected = [...baseIds, ...c1Ins].sort(cmp);
			assertOwnershipInvariant(c1, base, snapBase);
			const snapC1 = snapshotBase(c1);

			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
			for (const id of c2Ins) expect(c2.insert({ id, value: `c2_${id}`, tag: 'c2' }).on, `c2 insert ${id}`).to.equal(true);
			const c2Expected = [...c1Expected, ...c2Ins].sort(cmp);
			assertOwnershipInvariant(c2, c1, snapC1);
			const snapC2 = snapshotBase(c2);

			const c3 = new BTree<number, Entry>(keyOf, cmp, c2);
			for (const id of c3Ins) expect(c3.insert({ id, value: `c3_${id}`, tag: 'c3' }).on, `c3 insert ${id}`).to.equal(true);
			const c3Expected = [...c2Expected, ...c3Ins].sort(cmp);
			assertOwnershipInvariant(c3, c2, snapC2);
			const snapC3 = snapshotBase(c3);

			const c4 = new BTree<number, Entry>(keyOf, cmp, c3);

			// Pick an interior, min-fill (32-entry), base-owned LOW-region leaf. A single delete from a
			// min-fill leaf underflows it, forcing a borrow/merge against an adjacent base-owned sibling —
			// the rootward-clone-through-unowned-ancestors path. Probe for one rather than hardcoding a key
			// (robust to exact leaf boundaries); avoid the first/last leaf so it has siblings on both sides
			// (the leftmost leaf only ever rebalances rightward, which dodges the bug class).
			const baseLeaves = enumerateLeaves(base.root);
			const targetIdx = baseLeaves.findIndex(
				(l, i) => i > 1 && i < baseLeaves.length - 2 && l.entries.length === (NodeCapacity >>> 1) && keyOf(l.entries[0]) < 20000,
			);
			expect(targetIdx, 'a base-owned interior min-fill low-region leaf exists').to.be.greaterThan(-1);
			const targetLeaf = baseLeaves[targetIdx];
			const targetKey = keyOf(targetLeaf.entries[targetLeaf.entries.length >>> 1]);	// an interior key of that leaf

			// In c4 (before its first write) the target leaf is INHERITED — the very base-owned node, shared
			// up through the whole chain.
			expect(leafForKey(c4, targetKey), 'c4 inherits the base-owned target leaf').to.equal(targetLeaf);
			expect(targetLeaf.tree, 'target leaf is base-owned').to.equal(base);
			expect(targetLeaf.entries.length, 'target leaf is at minimum fill (a single delete underflows it)').to.equal(NodeCapacity >>> 1);

			const p = c4.find(targetKey);
			expect(p.on, 'target key present in c4').to.equal(true);
			expect(c4.deleteAt(p), `c4 delete ${targetKey}`).to.equal(true);

			// The delete cloned the touched leaf (and its rootward spine) into c4; the base's node is untouched.
			expect(c4.get(targetKey), 'deleted key gone from c4').to.equal(undefined);
			expect(leafForKey(c4, targetKey).tree, 'the rebalanced leaf is now child-owned in c4').to.equal(c4);
			expect(c4.root.tree, 'c4 owns its root after the rootward clone').to.equal(c4);
			expect(leafForKey(base, targetKey), 'base still routes to the very same node').to.equal(targetLeaf);
			expect(targetLeaf.tree, 'base target leaf still base-owned').to.equal(base);
			expect(targetLeaf.entries.length, 'base target leaf untouched at min fill').to.equal(NodeCapacity >>> 1);

			// Functional + structural + whole-chain ownership; every ancestor pristine against its snapshot.
			expect(liveIds(c4), 'c4 = base ∪ ancestor inserts − targetKey')
				.to.deep.equal(c3Expected.filter(k => k !== targetKey));
			assertTreeInvariants(c4);
			assertOwnershipInvariant(c4, c3, snapC3);
			assertOwnershipInvariant(c3, c2, snapC2);
			assertOwnershipInvariant(c2, c1, snapC1);
			assertOwnershipInvariant(c1, base, snapBase);

			expect(liveIds(c3), 'c3 unaffected by the deepest-child delete').to.deep.equal(c3Expected);
			expect(liveIds(c2), 'c2 unaffected by the deepest-child delete').to.deep.equal(c2Expected);
			expect(liveIds(c1), 'c1 unaffected by the deepest-child delete').to.deep.equal(c1Expected);
			expect(liveSet(base), 'base value-pristine after the deepest-child delete').to.deep.equal(baseEntries);
			expect(liveIds(base), 'base key-pristine after the deepest-child delete').to.deep.equal(baseIds);
		});
	});

	// =============================================================================================
	// 4. Depth-2 branch rebalance under copy-on-write (the rebalanceBranch borrow/merge path)
	// =============================================================================================
	describe('depth-2 branch rebalance under copy-on-write', () => {
		// When a COW delete merges a leaf, the parent BRANCH can drop below min fill, cascading into
		// `rebalanceBranch`, which borrows/merges that branch against a base-owned *sibling branch* — cloning
		// the sibling into the child and re-linking it rootward (`branchSibSegments` -> `mutableBranch` ->
		// `replaceRootward`, src/b-tree.ts). This path exists ONLY at tree depth >= 2 (there must be an
		// intermediate branch level to underflow); every other COW suite uses ~200 keys = depth 1 and never
		// reaches it. It is the branch-level twin of the leaf borrow/merge and shares the same hazard: the
		// cloned sibling must be linked into the parent at the SIBLING's slot (parent index shifted by the
		// borrow/merge delta), not the underflowing branch's slot. Getting that wrong silently orphans a whole
		// subtree in the child while leaving the base pristine — invisible to any depth-1 test.
		const D2_COUNT = 2500;	// > ~2048 -> a genuinely 3-node-level (depth-2) tree
		const D2_STRIDE = 10;

		it('regression: one interior delete cascades a leaf merge into a branch borrow/merge and stays correct', () => {
			const { base, ids, entries } = makeBase(D2_COUNT, D2_STRIDE);
			expect(depthOf(base.root), 'base is depth-2 (root -> branch -> leaf)').to.be.greaterThanOrEqual(2);
			const cow = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);

			// An interior, min-fill, base-owned leaf: deleting one key underflows it (leaf merge), which
			// underflows its parent branch (branch rebalance against a base-owned sibling branch).
			const baseLeaves = enumerateLeaves(base.root);
			const idx = baseLeaves.findIndex((l, i) => i > 1 && i < baseLeaves.length - 2 && l.entries.length === (NodeCapacity >>> 1));
			expect(idx, 'a base-owned interior min-fill leaf exists').to.be.greaterThan(-1);
			const targetLeaf = baseLeaves[idx];
			const targetKey = keyOf(targetLeaf.entries[targetLeaf.entries.length >>> 1]);

			expect(cow.deleteAt(cow.find(targetKey)), `delete ${targetKey}`).to.equal(true);

			// Before the fix this dropped an entire intermediate subtree from the child (and aliased the
			// sibling), so the live set lost ~32 keys and iteration looped on a corrupted spine.
			expect(liveIds(cow), 'child lost EXACTLY the one deleted key').to.deep.equal(ids.filter(k => k !== targetKey));
			expect(cow.root.tree, 'child owns its cloned root').to.equal(cow);
			assertTreeInvariants(cow);
			assertOwnershipInvariant(cow, base, snap);
			expect(liveSet(base), 'base value-pristine').to.deep.equal(entries);
			expect(liveIds(base), 'base key-pristine').to.deep.equal(ids);
		});

		it('drains a depth-2 child to empty in shuffled order; full ordered set verified periodically', function () {
			this.timeout(30000);
			const { base, ids, entries } = makeBase(D2_COUNT, D2_STRIDE);
			expect(depthOf(base.root)).to.be.greaterThanOrEqual(2);
			const cow = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);

			// Scattered deletion order so each delete strikes a different structural spot, sweeping every
			// branch borrow/merge/cascade configuration on the way down to empty. Each step does the cheap
			// point checks (key gone, count decremented); the full ordered-set deep-equal in BOTH directions
			// (which catches phantom-repeated / dropped keys from a corrupt spine) plus the structural &
			// ownership invariants run every 100 deletes — frequent enough to localise any corruption (the
			// bug corrupts on a single delete) without an O(n^2 log n) per-step re-sort.
			const order = shuffle(ids, lcg(0xBADF00D));
			const survivors = new Set(ids);
			for (let i = 0; i < order.length; i++) {
				const k = order[i];
				expect(cow.get(k), `key ${k} present before delete`).to.not.equal(undefined);
				expect(cow.deleteAt(cow.find(k)), `delete ${k}`).to.equal(true);
				survivors.delete(k);
				expect(cow.get(k), `key ${k} gone after delete`).to.equal(undefined);
				expect(cow.getCount(), `count after deleting ${k}`).to.equal(survivors.size);
				if (i % 100 === 0 || i === order.length - 1) {
					expect(liveIds(cow), `ordered set after deleting ${k}`).to.deep.equal([...survivors].sort(cmp));
					if (hasLocalRoot(cow)) assertTreeInvariants(cow);
					assertOwnershipInvariant(cow, base, snap);
					expect(liveIds(base), 'base key-pristine mid-drain').to.deep.equal(ids);
				}
			}
			expect(liveIds(cow), 'child fully drained').to.deep.equal([]);
			expect(liveSet(base), 'base value-pristine after full drain').to.deep.equal(entries);
		});

		it('delete-heavy randomized differential on a depth-2 child vs a shadow map', function () {
			this.timeout(30000);
			const { base, entries } = makeBase(D2_COUNT, D2_STRIDE);
			expect(depthOf(base.root)).to.be.greaterThanOrEqual(2);
			const cow = new BTree<number, Entry>(keyOf, cmp, base);
			const snap = snapshotBase(base);
			const shadow = new Map<number, Entry>(entries.map(e => [e.id, { ...e }]));

			const rng = lcg(0x5EEDD2);
			const OPS = 4000;
			const MAX = D2_COUNT * D2_STRIDE;
			const FLOOR = 2100;	// keep the tree comfortably depth-2 (above the ~2048 / 64-leaf threshold)
			let uid = 0;
			for (let op = 0; op < OPS; op++) {
				let roll = lcgInt(rng, 0, 100);
				if (shadow.size <= FLOOR) roll = 95;	// force an INSERT to stay depth-2
				if (roll < 65 && shadow.size > 0) {
					// DELETE a present key — the branch rebalance path under test.
					const keys = Array.from(shadow.keys());
					const k = keys[lcgInt(rng, 0, keys.length)];
					expect(cow.deleteAt(cow.find(k)), `delete ${k} @op${op}`).to.equal(true);
					shadow.delete(k);
				} else {
					// INSERT a fresh interior key (also grows leaves -> splits, mixing the structural churn).
					const k = lcgInt(rng, 1, MAX) + (++uid) / 1_000_000;
					const e: Entry = { id: k, value: `d_${k}`, tag: 'd' };
					expect(cow.insert(e).on, `insert ${k} @op${op}`).to.equal(true);
					shadow.set(k, e);
				}
				if (op % 100 === 0 || op === OPS - 1) {
					expect(liveSet(cow), `live set matches shadow @op${op}`).to.deep.equal(Array.from(shadow.values()).sort(byId));
					if (hasLocalRoot(cow)) assertTreeInvariants(cow);
					assertOwnershipInvariant(cow, base, snap);
					expect(liveSet(base), `base pristine @op${op}`).to.deep.equal(entries);
				}
			}
			expect(liveSet(cow), 'final live set matches shadow').to.deep.equal(Array.from(shadow.values()).sort(byId));
			expect(liveSet(base), 'base pristine at end').to.deep.equal(entries);
		});
	});
});
