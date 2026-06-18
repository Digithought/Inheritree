import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/index.js';
import { BranchNode, LeafNode } from '../src/nodes.js';
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt, shuffle } from './helpers/rng.js';

const MinFill = NodeCapacity >>> 1;	// 32

/** A leaf holding `n` sequential integer keys starting at `start`. */
function makeLeaf(start: number, n: number): LeafNode<number> {
	return new LeafNode([...Array(n).keys()].map(k => k + start));
}

/** A valid branch over `numLeaves` leaves, each holding `leafSize` sequential keys, first key `base`. */
function makeBranchOfLeaves(numLeaves: number, leafSize: number, base: number): BranchNode<number> {
	const leaves: LeafNode<number>[] = [];
	for (let i = 0; i < numLeaves; i++) {
		leaves.push(makeLeaf(base + i * leafSize, leafSize));
	}
	const partitions: number[] = [];
	for (let i = 1; i < numLeaves; i++) {
		partitions.push(base + i * leafSize);	// minimum key of leaves[i]
	}
	return new BranchNode<number>(partitions, leaves);
}

function setRoot(tree: BTree<number, number>, root: object): void {
	(tree as any)['_root'] = root;
}

describe('assertTreeInvariants (validator self-test)', () => {
	let tree: BTree<number, number>;

	beforeEach(() => {
		tree = new BTree<number, number>();
	});

	describe('accepts valid trees', () => {
		it('an empty tree', () => {
			expect(() => assertTreeInvariants(tree)).to.not.throw();
		});

		it('a small single-leaf tree', () => {
			for (const v of [5, 1, 9, 3, 7]) {
				tree.insert(v);
			}
			expect(() => assertTreeInvariants(tree)).to.not.throw();
		});

		it('a naturally grown multi-level tree', () => {
			for (let i = 0; i < NodeCapacity * 4; i++) {
				tree.insert(i);
			}
			expect(() => assertTreeInvariants(tree)).to.not.throw();
		});

		it('a hand-built balanced branch', () => {
			setRoot(tree, makeBranchOfLeaves(MinFill, MinFill, 0));
			expect(() => assertTreeInvariants(tree)).to.not.throw();
		});
	});

	describe('rejects broken trees', () => {
		it('rule 4: partition key not equal to min of right subtree', () => {
			// This is the shape produced by the (benign) stale-partition path in bug #1: a partition that
			// is a valid separator (31 < 50 <= 100) but is not the minimum key of the right subtree.
			const root = new BranchNode<number>([100], [makeLeaf(0, MinFill), makeLeaf(100, MinFill)]);
			setRoot(tree, root);
			expect(() => assertTreeInvariants(tree)).to.not.throw();	// sanity: valid before corruption
			root.partitions[0] = 50;
			expect(() => assertTreeInvariants(tree)).to.throw(/Partition violation \(rule 4\)/);
		});

		it('rule 4: a key in the left subtree is not < its partition', () => {
			const root = new BranchNode<number>([20], [makeLeaf(0, MinFill), makeLeaf(100, MinFill)]);
			setRoot(tree, root);
			expect(() => assertTreeInvariants(tree)).to.throw(/Partition violation \(rule 4\)/);
		});

		it('rule 2: an underfilled non-root leaf', () => {
			const root = new BranchNode<number>([100], [makeLeaf(0, MinFill - 1), makeLeaf(100, MinFill)]);
			setRoot(tree, root);
			expect(() => assertTreeInvariants(tree)).to.throw(/Fill violation \(rule 2\)/);
		});

		it('rule 2: an overfull leaf', () => {
			setRoot(tree, makeLeaf(0, NodeCapacity + 1));
			expect(() => assertTreeInvariants(tree)).to.throw(/Fill violation \(rule 2\)/);
		});

		it('rule 2: a root branch with fewer than two children', () => {
			setRoot(tree, new BranchNode<number>([], [makeLeaf(0, MinFill)]));
			expect(() => assertTreeInvariants(tree)).to.throw(/rule 2/);
		});

		it('rule 3: partitions length not equal to nodes length - 1', () => {
			const root = new BranchNode<number>([100, 200], [makeLeaf(0, MinFill), makeLeaf(100, MinFill)]);
			setRoot(tree, root);
			expect(() => assertTreeInvariants(tree)).to.throw(/Shape violation \(rule 3\)/);
		});

		it('rule 5: out-of-order keys within a leaf', () => {
			setRoot(tree, new LeafNode<number>([0, 1, 2, 5, 4, 6]));
			expect(() => assertTreeInvariants(tree)).to.throw(/Order violation \(rule 5\)/);
		});

		it('rule 1: leaves at differing depths', () => {
			const shallow = makeLeaf(0, MinFill);							// depth 1
			const deep = makeBranchOfLeaves(MinFill, MinFill, 100);		// its leaves are depth 2
			const root = new BranchNode<number>([100], [shallow, deep]);
			setRoot(tree, root);
			expect(() => assertTreeInvariants(tree)).to.throw(/Depth violation \(rule 1\)/);
		});
	});

	describe('allowUnderfilledRoot option', () => {
		it('accepts an underfilled root branch by default, rejects it when disabled', () => {
			setRoot(tree, new BranchNode<number>([100], [makeLeaf(0, MinFill), makeLeaf(100, MinFill)]));
			expect(() => assertTreeInvariants(tree)).to.not.throw();
			expect(() => assertTreeInvariants(tree, { allowUnderfilledRoot: false })).to.throw(/rule 2/);
		});
	});
});

describe('assertOwnershipInvariant (COW ownership validator)', () => {
	const idFn = (e: number): number => e;
	const cmp = (a: number, b: number): number => a - b;

	/** A multi-level base (200 > NodeCapacity forces branches) plus a fresh COW child inheriting it. */
	function makeBase(n = 200): BTree<number, number> {
		const base = new BTree<number, number>(idFn, cmp);
		for (let i = 1; i <= n; i++) base.insert(i);
		return base;
	}

	describe('accepts valid copy-on-write trees', () => {
		it('a child with no local writes (root deferred to base)', () => {
			const base = makeBase();
			const child = new BTree<number, number>(idFn, cmp, base);
			expect(() => assertOwnershipInvariant(child, base)).to.not.throw();
		});

		it('a child after a non-front-anchored interior-band delete (the rebalance path)', () => {
			const base = makeBase();
			const snap = snapshotBase(base);
			const child = new BTree<number, number>(idFn, cmp, base);
			for (let k = 51; k <= 150; k++) {
				expect(child.deleteAt(child.find(k)), `delete ${k}`).to.equal(true);
			}
			// Child is internally consistent, its COW spine is connected/base-disjoint, and base is pristine.
			expect(() => assertTreeInvariants(child)).to.not.throw();
			expect(() => assertOwnershipInvariant(child, base, snap)).to.not.throw();
		});

		it('two independent children forked off one base each satisfy the invariant', () => {
			const base = makeBase();
			const snap = snapshotBase(base);
			const a = new BTree<number, number>(idFn, cmp, base);
			const b = new BTree<number, number>(idFn, cmp, base);
			for (let k = 60; k <= 90; k++) a.deleteAt(a.find(k));
			for (let k = 120; k <= 160; k++) b.deleteAt(b.find(k));
			expect(() => assertOwnershipInvariant(a, base, snap)).to.not.throw();
			expect(() => assertOwnershipInvariant(b, base, snap)).to.not.throw();
		});

		it('a snapshot of an UNWRITTEN intermediate base (multi-level chain base -> c1 -> c2)', () => {
			// Regression: snapshotting an intermediate COW child that owns no local root (it defers to its
			// own base) must not make base-immutability throw "no local root". This is the layering ticket 5
			// is documented to use. Immutability is still enforced via effective-root keys + node identities.
			const base = makeBase();
			const c1 = new BTree<number, number>(idFn, cmp, base);	// never written -> no local root
			const snapC1 = snapshotBase(c1);
			const c2 = new BTree<number, number>(idFn, cmp, c1);
			for (let k = 60; k <= 90; k++) c2.deleteAt(c2.find(k));
			expect(() => assertOwnershipInvariant(c2, c1, snapC1)).to.not.throw();
			// And it still catches a mutation of that intermediate base after the snapshot.
			c1.insert(77777);
			expect(() => assertOwnershipInvariant(c2, c1, snapC1)).to.throw(/Base mutation/);
		});
	});

	describe('rejects broken copy-on-write linkages', () => {
		it('connectivity: a child-owned node grafted beneath a base-owned ancestor', () => {
			// Simulates the documented bug manifestation — "a base node aliased into the child's mutable
			// spine" — by hanging a freshly child-owned leaf below a base-owned branch in the child's tree.
			const base = new BTree<number, number>(idFn, cmp);
			const child = new BTree<number, number>(idFn, cmp, base);

			const orphanClone = new LeafNode<number>([200, 201], child);				// child-owned
			const baseBranch = new BranchNode<number>([], [orphanClone], base);			// base-owned, but holds a child clone
			const childRoot = new BranchNode<number>(
				[100],
				[new LeafNode<number>([0, 1], child), baseBranch],						// child-owned root
				child,
			);
			(child as any)['_root'] = childRoot;
			expect(() => assertOwnershipInvariant(child, base)).to.throw(/connectivity/);
		});

		it('shared mutable node: a child-owned node also reachable from the base', () => {
			// Passes connectivity (the shared node sits in child-owned territory) but a child write to it
			// would corrupt the base, because the same object is wired into both trees.
			const base = new BTree<number, number>(idFn, cmp);
			const child = new BTree<number, number>(idFn, cmp, base);

			const shared = new LeafNode<number>([5, 6], child);							// child-owned (mutable)
			(child as any)['_root'] = new BranchNode<number>(
				[100],
				[shared, new LeafNode<number>([100, 101], base)],
				child,
			);
			(base as any)['_root'] = new BranchNode<number>(
				[100],
				[shared, new LeafNode<number>([100, 101], base)],						// same `shared` object
				base,
			);
			expect(() => assertOwnershipInvariant(child, base)).to.throw(/shared mutable node/);
		});

		it('base immutability: a base mutated after the snapshot is detected', () => {
			const base = makeBase();
			const snap = snapshotBase(base);
			const child = new BTree<number, number>(idFn, cmp, base);
			child.deleteAt(child.find(120));											// a legitimate COW op

			expect(() => assertOwnershipInvariant(child, base, snap), 'pristine base passes').to.not.throw();

			base.insert(99999);															// corrupt the base directly
			expect(() => assertOwnershipInvariant(child, base, snap)).to.throw(/Base mutation/);
		});

		it('base immutability is only checked when a snapshot is supplied', () => {
			// The 2-arg form has no "before" reference, so it cannot (and does not) flag a changed base;
			// that is by design — callers pair it with their own base-pristine assertion or pass a snapshot.
			const base = makeBase();
			const snap = snapshotBase(base);
			const child = new BTree<number, number>(idFn, cmp, base);
			base.insert(88888);
			expect(() => assertOwnershipInvariant(child, base)).to.not.throw();			// no snapshot: not flagged
			expect(() => assertOwnershipInvariant(child, base, snap)).to.throw(/Base mutation/);	// snapshot: flagged
		});
	});
});

describe('seeded RNG helpers', () => {
	it('lcg is deterministic for a given seed and differs across seeds', () => {
		const a = lcg(12345);
		const b = lcg(12345);
		const c = lcg(54321);
		const seqA = Array.from({ length: 10 }, () => a());
		const seqB = Array.from({ length: 10 }, () => b());
		const seqC = Array.from({ length: 10 }, () => c());
		expect(seqA).to.deep.equal(seqB);
		expect(seqA).to.not.deep.equal(seqC);
	});

	it('lcg yields floats in [0, 1)', () => {
		const rng = lcg(7);
		for (let i = 0; i < 1000; i++) {
			const v = rng();
			expect(v).to.be.at.least(0);
			expect(v).to.be.lessThan(1);
		}
	});

	it('lcgInt yields integers in [lo, hi)', () => {
		const rng = lcg(99);
		for (let i = 0; i < 1000; i++) {
			const v = lcgInt(rng, 5, 10);
			expect(Number.isInteger(v)).to.equal(true);
			expect(v).to.be.at.least(5);
			expect(v).to.be.lessThan(10);
		}
	});

	it('shuffle returns a deterministic permutation without mutating the input', () => {
		const source = [...Array(50).keys()];
		const shuffled = shuffle(source, lcg(2024));
		expect(source).to.deep.equal([...Array(50).keys()]);	// input untouched
		expect([...shuffled].sort((x, y) => x - y)).to.deep.equal(source);	// same elements
		expect(shuffled).to.not.deep.equal(source);	// (almost surely) reordered
		expect(shuffle([...Array(50).keys()], lcg(2024))).to.deep.equal(shuffled);	// reproducible
	});
});
