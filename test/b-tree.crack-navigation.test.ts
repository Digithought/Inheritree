import { expect } from 'chai';
import { BTree, KeyBound, KeyRange, NodeCapacity } from '../src/index.js';
import { BranchNode, LeafNode } from '../src/nodes.js';
import { asImpl } from './helpers/path-impl.js';

// Regression matrix for the forward-only "navigation from an end-of-leaf crack never advances" bug.
//
// When find(key) misses at the END of a leaf, indexOfEntry returns [false, entries.length], so
// path.leafIndex === path.leafNode.entries.length. Before the fix, internalNext's crack-recovery block
// set path.on = false and then fell through the whole if/else-if/else chain doing nothing - the cursor
// was left stuck off-entry instead of advancing into the first entry of the next leaf. next() returned
// undefined and range() came back empty. internalPrior never had this asymmetry (it already pops to the
// prior leaf from a crack), so prior() and the descending-first-bound mirror always worked.
//
// The matrix below exercises next / prior / range from cracks in each position - tree start, mid-leaf,
// leaf boundary (the bug), and tree end - at 1-leaf, 2-level, and 3-level tree sizes. The range cases
// include the descending / missed-last-bound variant so findLast's use of internalNext is covered
// alongside findFirst's.

// range() yields the SAME cursor object each step (mutated in place), so the value must be read inside
// the loop - spreading into an array and mapping afterwards would read every element at the final position.
function rangeValues<TKey, TEntry>(tree: BTree<TKey, TEntry>, range: KeyRange<TKey>): (TEntry | undefined)[] {
	const out: (TEntry | undefined)[] = [];
	for (const path of tree.range(range)) {
		out.push(tree.at(path));
	}
	return out;
}

describe('Crack navigation (end-of-leaf and boundary cracks advance correctly)', () => {

	describe('1-leaf tree (no branches)', () => {
		let tree: BTree<number, number>;

		beforeEach(() => {
			tree = new BTree<number, number>();
			tree.insert(1);
			tree.insert(2);
			tree.insert(3);
			// Single leaf, no branches.
			expect((tree as any)['_root'] instanceof LeafNode).to.be.true;
		});

		it('crack before the first entry: next advances, prior stays off', () => {
			const crack = tree.find(0.5);
			expect(crack.on).to.be.false;
			expect(tree.at(tree.next(crack))).to.equal(1);
			expect(tree.next(crack).on).to.be.true;
			expect(tree.prior(crack).on).to.be.false;	// nothing before the tree start
		});

		it('crack mid-leaf: next and prior land on the neighbours', () => {
			const crack = tree.find(1.5);
			expect(crack.on).to.be.false;
			expect(tree.at(tree.next(crack))).to.equal(2);
			expect(tree.at(tree.prior(crack))).to.equal(1);
		});

		it('crack after the last entry (== end of the only leaf): next stays off, prior advances back', () => {
			const crack = asImpl(tree.find(3.5));
			expect(crack.on).to.be.false;
			expect(crack.leafIndex).to.equal(crack.leafNode.entries.length);	// end-of-leaf crack
			expect(tree.next(crack).on).to.be.false;	// nothing after the tree end
			expect(tree.at(tree.prior(crack))).to.equal(3);
		});

		it('ranges starting/ending on cracks work ascending and descending', () => {
			// Ascending: first bound misses mid-leaf (findFirst -> internalNext), last bound misses (findLast -> internalPrior)
			expect(rangeValues(tree, new KeyRange(new KeyBound(0.5), new KeyBound(3.5)))).to.deep.equal([1, 2, 3]);
			// Ascending range fully interior to cracks
			expect(rangeValues(tree, new KeyRange(new KeyBound(1.5), new KeyBound(2.5)))).to.deep.equal([2]);
			// Descending: first (high) bound misses at end crack (findFirst -> internalPrior),
			// last (low) bound misses at start crack (findLast -> internalNext)
			expect(rangeValues(tree, new KeyRange(new KeyBound(3.5), new KeyBound(0.5), false))).to.deep.equal([3, 2, 1]);
		});
	});

	describe('2-level tree (root branch over two leaves) - the repro', () => {
		let tree: BTree<number, number>;

		beforeEach(() => {
			tree = new BTree<number, number>();
			for (let i = 0; i <= 64; i++) {
				tree.insert(i * 10);
			}
			// One split -> two leaves under a single root branch: leaf0 = 0..310, leaf1 = 320..640.
			const root = (tree as any)['_root'];
			expect(root instanceof BranchNode).to.be.true;
			expect(root.nodes.length).to.equal(2);
		});

		it('bug 1.1: next from the leaf-boundary crack advances into the next leaf', () => {
			expect(tree.at(tree.next(tree.find(315)))).to.equal(320);
		});

		it('bug 1.2: ascending range from a boundary-missed first bound is not empty', () => {
			expect(rangeValues(tree, new KeyRange(new KeyBound(315), new KeyBound(345)))).to.deep.equal([320, 330, 340]);
		});

		it('prior mirror from the leaf-boundary crack still lands on the prior leaf', () => {
			expect(tree.at(tree.prior(tree.find(315)))).to.equal(310);
		});

		it('mid-leaf crack regression guard: next advances within the leaf', () => {
			expect(tree.at(tree.next(tree.find(15)))).to.equal(20);
			expect(tree.at(tree.prior(tree.find(15)))).to.equal(10);
		});

		it('crack before the first entry: next advances, prior stays off', () => {
			const crack = tree.find(-5);
			expect(crack.on).to.be.false;
			expect(tree.at(tree.next(crack))).to.equal(0);
			expect(tree.prior(crack).on).to.be.false;
		});

		it('crack past the tree end stays off, prior advances back', () => {
			const crack = asImpl(tree.find(645));
			expect(crack.on).to.be.false;
			expect(crack.leafIndex).to.equal(crack.leafNode.entries.length);	// end-of-leaf crack on the last leaf
			expect(tree.next(crack).on).to.be.false;
			expect(tree.at(tree.prior(crack))).to.equal(640);
		});

		it('descending range whose last (low) bound misses at the leaf boundary (findLast -> internalNext)', () => {
			// first (high) = 345 -> internalPrior -> 340; last (low) = 315 -> internalNext -> 320 (crosses the boundary)
			expect(rangeValues(tree, new KeyRange(new KeyBound(345), new KeyBound(315), false))).to.deep.equal([340, 330, 320]);
		});

		it('descending range whose first (high) bound misses at the leaf boundary (findFirst -> internalPrior)', () => {
			// first (high) = 315 -> internalPrior -> 310; last (low) = 285 -> internalNext -> 290
			expect(rangeValues(tree, new KeyRange(new KeyBound(315), new KeyBound(285), false))).to.deep.equal([310, 300, 290]);
		});

		it('ascending range whose last bound misses at the leaf boundary (findLast -> internalPrior)', () => {
			// first = 285 -> internalNext -> 290; last = 315 -> internalPrior -> 310
			expect(rangeValues(tree, new KeyRange(new KeyBound(285), new KeyBound(315)))).to.deep.equal([290, 300, 310]);
		});

		it('exclusive bound on a leaf-tail entry steps across the boundary via internalNext (on-entry pop)', () => {
			// 310 is the last entry of leaf0. An exclusive bound there lands find() ON the entry, so the step is
			// internalNext from on == true at the leaf's last index - the path my refactor kept behind (path.on ? 1 : 0).
			// Ascending: exclusive first bound -> findFirst pops forward into leaf1.
			expect(rangeValues(tree, new KeyRange(new KeyBound(310, false), new KeyBound(345)))).to.deep.equal([320, 330, 340]);
			// Descending: exclusive last (low) bound -> findLast pops forward into leaf1.
			expect(rangeValues(tree, new KeyRange(new KeyBound(345), new KeyBound(310, false), false))).to.deep.equal([340, 330, 320]);
		});
	});

	describe('3-level tree (branch over branches)', () => {
		let tree: BTree<number, number>;
		const count = NodeCapacity * NodeCapacity + 1;	// 4097 sequential inserts -> 3 levels

		beforeEach(() => {
			tree = new BTree<number, number>();
			for (let i = 0; i < count; i++) {
				tree.insert(i);
			}
			const root = (tree as any)['_root'];
			expect(root instanceof BranchNode, 'root should be a branch').to.be.true;
			expect(root.nodes[0] instanceof BranchNode, 'root children should be branches (3 levels)').to.be.true;
		});

		it('every leaf-boundary crack: next -> k+1 and prior -> k, including cross-branch boundaries', () => {
			let boundaryCracks = 0;
			let crossBranchCracks = 0;	// leaf is the last child of its immediate parent branch -> pop walks up
			let firstCrossBranchKey = -1;

			for (let k = 0; k < count - 1; k++) {
				const crack = asImpl(tree.find(k + 0.5));
				expect(crack.on).to.be.false;
				if (crack.leafIndex !== crack.leafNode.entries.length) {
					continue;	// mid-leaf crack; not a boundary
				}
				++boundaryCracks;
				const deepest = crack.branches.at(-1)!;
				if (deepest.index === deepest.node.partitions.length) {	// last child of its parent branch
					++crossBranchCracks;
					if (firstCrossBranchKey < 0) {
						firstCrossBranchKey = k;
					}
				}
				expect(tree.at(tree.next(crack)), `next past end-of-leaf crack after ${k}`).to.equal(k + 1);
				expect(tree.at(tree.prior(crack)), `prior from end-of-leaf crack after ${k}`).to.equal(k);
			}

			expect(boundaryCracks, 'should have exercised leaf-boundary cracks').to.be.greaterThan(0);
			expect(crossBranchCracks, 'should have exercised a boundary whose pop walks up a branch level').to.be.greaterThan(0);

			// Ascending range straddling a cross-branch boundary (findFirst -> internalNext across a mid-branch)
			const kb = firstCrossBranchKey;
			expect(rangeValues(tree, new KeyRange(new KeyBound(kb + 0.5), new KeyBound(kb + 3.5))))
				.to.deep.equal([kb + 1, kb + 2, kb + 3]);
			// Descending range whose last (low) bound misses at the same cross-branch boundary (findLast -> internalNext)
			expect(rangeValues(tree, new KeyRange(new KeyBound(kb + 3.5), new KeyBound(kb + 0.5), false)))
				.to.deep.equal([kb + 3, kb + 2, kb + 1]);
		});

		it('crack before the first entry: next advances, prior stays off', () => {
			const crack = tree.find(-0.5);
			expect(crack.on).to.be.false;
			expect(tree.at(tree.next(crack))).to.equal(0);
			expect(tree.prior(crack).on).to.be.false;
		});

		it('crack past the tree end stays off, prior advances back', () => {
			const crack = asImpl(tree.find(count - 0.5));	// after the last entry (count - 1)
			expect(crack.on).to.be.false;
			expect(crack.leafIndex).to.equal(crack.leafNode.entries.length);
			expect(tree.next(crack).on).to.be.false;
			expect(tree.at(tree.prior(crack))).to.equal(count - 1);
		});
	});
});
