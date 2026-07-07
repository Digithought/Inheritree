import { expect } from 'chai';
import { BTree, KeyBound, KeyRange, NodeCapacity, Path } from '../src/index.js';
import { BranchNode, ITreeNode, LeafNode } from '../src/nodes.js';

// Coverage for the perf-descent-and-range-end ticket (review §3.3 + §3.4). These are *pure* optimizations:
//   §3.3 - getPath/getFirst/getLast descend top-down with a push loop instead of bottom-up recursion + unshift,
//          and internalNext/internalPrior truncate path.branches with `length -=` instead of a throwaway splice.
//   §3.4 - range() stops on a fixed (leafNode, leafIndex) position match instead of a per-element key comparison.
// So the load-bearing assertions here are equivalence ones: the iterative descent must build byte-identical paths
// to the recursion it replaced, and range() must yield exactly the same entries in the same order as before while
// no longer invoking the user comparator per yielded element.

// range() re-yields the SAME cursor object each step (mutated in place); read the value inside the loop.
function rangeValues<TKey, TEntry>(tree: BTree<TKey, TEntry>, range: KeyRange<TKey>): (TEntry | undefined)[] {
	const out: (TEntry | undefined)[] = [];
	for (const path of tree.range(range)) {
		out.push(tree.at(path));
	}
	return out;
}

// ---- Reference recursion: a literal transcription of the *old* getPath/getFirst/getLast (bottom-up unshift). ----
// Used only to prove the new iterative descent produces identical (node, index) branch chains. Numeric identity
// keys, so the binary searches below mirror the tree's indexOfKey / indexOfEntry exactly.
interface RefPath { branches: { node: BranchNode<number>; index: number }[]; leaf: LeafNode<number>; index: number; on: boolean }

function refIndexOfEntry(entries: number[], key: number): [boolean, number] {
	let lo = 0, hi = entries.length - 1;
	while (lo <= hi) {
		const split = (lo + hi) >>> 1;
		const r = key < entries[split] ? -1 : key > entries[split] ? 1 : 0;
		if (r === 0) return [true, split];
		else if (r < 0) hi = split - 1;
		else lo = split + 1;
	}
	return [false, lo];
}

function refIndexOfKey(keys: number[], key: number): number {
	let lo = 0, hi = keys.length - 1;
	while (lo <= hi) {
		const split = (lo + hi) >>> 1;
		const r = key < keys[split] ? -1 : key > keys[split] ? 1 : 0;
		if (r === 0) return split + 1;	// +1: take the right partition
		else if (r < 0) hi = split - 1;
		else lo = split + 1;
	}
	return lo;
}

function refFind(node: ITreeNode, key: number): RefPath {
	if (node instanceof LeafNode) {
		const [on, index] = refIndexOfEntry(node.entries, key);
		return { branches: [], leaf: node, index, on };
	}
	const branch = node as BranchNode<number>;
	const index = refIndexOfKey(branch.partitions, key);
	const sub = refFind(branch.nodes[index], key);
	sub.branches.unshift({ node: branch, index });	// old shape: prepend on the way back up
	return sub;
}

function refEdge(node: ITreeNode, last: boolean): RefPath {
	if (node instanceof LeafNode) {
		const count = node.entries.length;
		return { branches: [], leaf: node, index: last ? (count > 0 ? count - 1 : 0) : 0, on: count > 0 };
	}
	const branch = node as BranchNode<number>;
	const index = last ? branch.nodes.length - 1 : 0;
	const sub = refEdge(branch.nodes[index], last);
	sub.branches.unshift({ node: branch, index });
	return sub;
}

function assertSamePath(actual: Path<number, number>, ref: RefPath, label: string) {
	expect(actual.branches.length, `${label}: branch depth`).to.equal(ref.branches.length);
	for (let i = 0; i < ref.branches.length; i++) {
		expect(actual.branches[i].node, `${label}: branch[${i}].node identity`).to.equal(ref.branches[i].node);
		expect(actual.branches[i].index, `${label}: branch[${i}].index`).to.equal(ref.branches[i].index);
	}
	expect(actual.leafNode, `${label}: leafNode identity`).to.equal(ref.leaf);
	expect(actual.leafIndex, `${label}: leafIndex`).to.equal(ref.index);
	expect(actual.on, `${label}: on`).to.equal(ref.on);
}

// Independent structural invariant (no reference needed): the branch chain must be a real root->leaf walk in
// root-first order, i.e. each chosen child leads to the next node and the last leads to the leaf.
function assertDescentChainConsistent(tree: BTree<number, number>, path: Path<number, number>, label: string) {
	const root = (tree as any)['_root'] as ITreeNode;
	if (path.branches.length > 0) {
		expect(path.branches[0].node, `${label}: branch[0] is the root`).to.equal(root);
	} else {
		expect(root instanceof LeafNode, `${label}: no branches -> root is a leaf`).to.be.true;
	}
	for (let i = 0; i < path.branches.length; i++) {
		const b = path.branches[i];
		const next: ITreeNode = i + 1 < path.branches.length ? path.branches[i + 1].node : path.leafNode;
		expect(b.node.nodes[b.index], `${label}: branch[${i}] child leads to next node`).to.equal(next);
	}
}

const buildSeq = (n: number): BTree<number, number> => {
	const tree = new BTree<number, number>();
	for (let i = 0; i < n; i++) tree.insert(i);
	return tree;
};

describe('Perf descent + range end-by-position (§3.3 / §3.4)', () => {

	describe('range() end bound: inclusive/exclusive × ascending/descending', () => {
		// One leaf's worth of keys 0..19, then the four bound combinations in each direction, asserting the exact
		// yielded set. §3.4 moves the stop test to a position match; inclusivity stays encoded in findFirst/findLast,
		// so these must still land exactly as the comparison-based loop did.
		let tree: BTree<number, number>;
		beforeEach(() => { tree = buildSeq(20); });

		it('ascending: inclusive/exclusive on both bounds', () => {
			expect(rangeValues(tree, new KeyRange(new KeyBound(5), new KeyBound(8))), 'incl/incl').to.deep.equal([5, 6, 7, 8]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(5, false), new KeyBound(8))), 'excl/incl').to.deep.equal([6, 7, 8]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(5), new KeyBound(8, false))), 'incl/excl').to.deep.equal([5, 6, 7]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(5, false), new KeyBound(8, false))), 'excl/excl').to.deep.equal([6, 7]);
		});

		it('descending: inclusive/exclusive on both bounds', () => {
			expect(rangeValues(tree, new KeyRange(new KeyBound(8), new KeyBound(5), false)), 'incl/incl').to.deep.equal([8, 7, 6, 5]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(8, false), new KeyBound(5), false)), 'excl/incl').to.deep.equal([7, 6, 5]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(8), new KeyBound(5, false), false)), 'incl/excl').to.deep.equal([8, 7, 6]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(8, false), new KeyBound(5, false), false)), 'excl/excl').to.deep.equal([7, 6]);
		});

		it('single-element range (start == end) yields exactly one, both directions', () => {
			expect(rangeValues(tree, new KeyRange(new KeyBound(7), new KeyBound(7)))).to.deep.equal([7]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(7), new KeyBound(7), false))).to.deep.equal([7]);
		});

		it('unbounded and half-bounded ranges still cover the whole span', () => {
			const asc = [...Array(20).keys()];
			expect(rangeValues(tree, new KeyRange()), 'full ascending').to.deep.equal(asc);
			expect(rangeValues(tree, new KeyRange(undefined, undefined, false)), 'full descending').to.deep.equal([...asc].reverse());
			expect(rangeValues(tree, new KeyRange(new KeyBound(15), undefined)), 'from 15 up').to.deep.equal([15, 16, 17, 18, 19]);
			expect(rangeValues(tree, new KeyRange(undefined, new KeyBound(4))), 'up to 4').to.deep.equal([0, 1, 2, 3, 4]);
		});
	});

	describe('range() empty results — the start-past-end guard', () => {
		// The bare position-match loop (yield, then stop at the end position) would spuriously yield when the start
		// is already past the end, because that end position is never reached going forward. These exercise the
		// up-front guard that replaces the old loop's first-element comparison.
		it('ill-formed range (ascending first > last) yields nothing', () => {
			const tree = buildSeq(20);
			expect(rangeValues(tree, new KeyRange(new KeyBound(12), new KeyBound(4)))).to.deep.equal([]);
			// Descending mirror: first (low) below last (high) is also empty.
			expect(rangeValues(tree, new KeyRange(new KeyBound(4), new KeyBound(12), false))).to.deep.equal([]);
		});

		it('range over an empty region (both bounds step to opposite sides of the gap) yields nothing', () => {
			const tree = new BTree<number, number>();
			for (const k of [0, 1, 2, 3, 50, 51, 52]) tree.insert(k);
			// [10, 40] has no keys: findFirst steps forward onto 50, findLast steps back onto 3 -> start past end.
			expect(rangeValues(tree, new KeyRange(new KeyBound(10), new KeyBound(40)))).to.deep.equal([]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(40), new KeyBound(10), false))).to.deep.equal([]);
			// And a normal range straddling the gap still works (regression guard for the guard itself).
			expect(rangeValues(tree, new KeyRange(new KeyBound(2), new KeyBound(51)))).to.deep.equal([2, 3, 50, 51]);
		});

		it('empty tree yields nothing with no comparator call', () => {
			let compares = 0;
			const tree = new BTree<number, number>(k => k, (a, b) => { compares++; return a < b ? -1 : a > b ? 1 : 0; });
			expect(rangeValues(tree, new KeyRange(new KeyBound(0), new KeyBound(9)))).to.deep.equal([]);
			expect(rangeValues(tree, new KeyRange())).to.deep.equal([]);
			expect(rangeValues(tree, new KeyRange(undefined, undefined, false))).to.deep.equal([]);
			expect(compares, 'off endPath short-circuits before any key comparison').to.equal(0);
		});
	});

	describe('range() end-by-position across a leaf boundary (2-level tree)', () => {
		// 65 keys (0,10,..,640) split once -> leaf0 = 0..310, leaf1 = 320..640. The end position lives in a
		// different leaf from the start, so the (leafNode, leafIndex) match must fire in the correct leaf.
		let tree: BTree<number, number>;
		beforeEach(() => {
			tree = new BTree<number, number>();
			for (let i = 0; i <= 64; i++) tree.insert(i * 10);
			expect((tree as any)['_root'] instanceof BranchNode, 'two-leaf tree').to.be.true;
		});

		it('end bound landing in the second leaf terminates there (ascending)', () => {
			// start 300 (leaf0), end 340 (leaf1) inclusive -> crosses the boundary and stops at 340.
			expect(rangeValues(tree, new KeyRange(new KeyBound(300), new KeyBound(340)))).to.deep.equal([300, 310, 320, 330, 340]);
		});

		it('start bound on the leaf boundary crack resolves into the next leaf', () => {
			// 315 misses at the end-of-leaf0 crack; findFirst steps forward onto 320 (leaf1).
			expect(rangeValues(tree, new KeyRange(new KeyBound(315), new KeyBound(350)))).to.deep.equal([320, 330, 340, 350]);
		});

		it('end bound on the leaf boundary crack resolves onto the prior leaf tail (descending)', () => {
			// Descending [345 -> 305]: findFirst 345 -> 340 (leaf1), findLast's low bound 305 misses and steps up onto
			// 310 - the tail entry of leaf0. So the scan crosses the boundary downward and the position match fires on
			// leaf0's last index (300 < 305 is correctly excluded).
			expect(rangeValues(tree, new KeyRange(new KeyBound(345), new KeyBound(305), false))).to.deep.equal([340, 330, 320, 310]);
		});
	});

	describe('range() stop test invokes no per-element comparator (§3.4)', () => {
		// The old loop called compareKeys (which calls compare twice) per yielded element. The new stop test is a
		// pure position match, so a full unbounded scan should touch the comparator only for the O(1) start-past-end
		// guard - a fixed count independent of how many elements are yielded.
		// The exact count is 1: under the default (checkComparator off), compareKeys calls compare ONCE past the
		// 32-comparison sample window, which the n-key build exhausts before reset(). (See the BTreeOptions ticket;
		// with { checkComparator: true } the guard would cost 2, but that constant is beside the point here - what
		// this proves is that the count does not grow with element count.)
		const countingTree = (n: number): { tree: BTree<number, number>; comparisons: () => number; reset: () => void } => {
			let compares = 0;
			const tree = new BTree<number, number>(k => k, (a, b) => { compares++; return a < b ? -1 : a > b ? 1 : 0; });
			for (let i = 0; i < n; i++) tree.insert(i);
			return { tree, comparisons: () => compares, reset: () => { compares = 0; } };
		};

		it('a full ascending scan uses a fixed 1 comparison regardless of element count', () => {
			for (const n of [50, 500]) {
				const { tree, comparisons, reset } = countingTree(n);
				reset();
				const out = rangeValues(tree, new KeyRange());
				expect(out.length, `scanned all ${n}`).to.equal(n);
				// first()/last() descend by edge (no compare); the loop's stop test is a position match (no compare);
				// only the single up-front compareKeys guard runs, one compare each past the sample window.
				expect(comparisons(), `n=${n}: comparator calls independent of element count`).to.equal(1);
			}
		});

		it('a full descending scan is likewise a fixed 1 comparison', () => {
			const { tree, comparisons, reset } = countingTree(300);
			reset();
			expect(rangeValues(tree, new KeyRange(undefined, undefined, false)).length).to.equal(300);
			expect(comparisons()).to.equal(1);
		});

		it('a bounded scan cost is search + the guard, not per-element (does not grow with span)', () => {
			// Same start key, different end keys chosen so the two end-finds descend to the same depth (both live in
			// the same-shaped subtree region). The delta between the two scans' comparator counts must be ~0, proving
			// the per-element stop test is free - a comparison-per-element loop would differ by the span difference.
			const mk = () => countingTree(500);
			const a = mk();
			a.reset();
			const short = rangeValues(a.tree, new KeyRange(new KeyBound(100), new KeyBound(150)));
			const shortCost = a.comparisons();

			const b = mk();
			b.reset();
			const long = rangeValues(b.tree, new KeyRange(new KeyBound(100), new KeyBound(400)));
			const longCost = b.comparisons();

			expect(short.length).to.equal(51);
			expect(long.length).to.equal(301);
			// The 250-element span difference must NOT show up as comparator calls. Allow a tiny slack for the two
			// end-finds descending through slightly different partitions, but nothing near the 250-element gap.
			expect(Math.abs(longCost - shortCost), `span grew by 250 but comparator cost delta stayed tiny (short=${shortCost}, long=${longCost})`).to.be.lessThan(10);
		});
	});

	describe('iterative descent builds paths identical to the old recursion (§3.3)', () => {
		// Prove find()/first()/last() produce the exact same (node, index) branch chain, leaf, index, and on flag the
		// bottom-up recursion produced, at 1-leaf, 2-level, and 3-level sizes. Also assert the chain is a consistent
		// root->leaf walk (independent of the reference).

		it('single-leaf tree: leaf-only paths, empty branches', () => {
			const tree = buildSeq(10);
			expect((tree as any)['_root'] instanceof LeafNode, 'single leaf').to.be.true;
			for (const key of [-1, 0, 4.5, 9, 10]) {
				const p = tree.find(key);
				expect(p.branches.length, `find(${key}) has no branches`).to.equal(0);
				assertSamePath(p, refFind((tree as any)['_root'], key), `find(${key})`);
			}
			assertSamePath(tree.first(), refEdge((tree as any)['_root'], false), 'first()');
			assertSamePath(tree.last(), refEdge((tree as any)['_root'], true), 'last()');
		});

		it('empty tree: first/last/find are well-formed off paths with empty branches', () => {
			const tree = new BTree<number, number>();
			for (const p of [tree.first(), tree.last(), tree.find(5)]) {
				expect(p.branches.length).to.equal(0);
				expect(p.on).to.be.false;
				expect(p.leafNode instanceof LeafNode).to.be.true;
			}
		});

		it('2-level tree: find/first/last match the recursion at every probed key', () => {
			const tree = new BTree<number, number>();
			for (let i = 0; i <= 64; i++) tree.insert(i * 10);
			const root = (tree as any)['_root'];
			expect(root instanceof BranchNode, 'two leaves under a branch').to.be.true;
			for (const key of [-5, 0, 155, 310, 315, 320, 640, 645]) {
				const p = tree.find(key);
				assertSamePath(p, refFind(root, key), `find(${key})`);
				assertDescentChainConsistent(tree, p, `find(${key})`);
			}
			assertSamePath(tree.first(), refEdge(root, false), 'first()');
			assertSamePath(tree.last(), refEdge(root, true), 'last()');
			assertDescentChainConsistent(tree, tree.first(), 'first()');
			assertDescentChainConsistent(tree, tree.last(), 'last()');
		});

		it('3-level tree: find/first/last match the recursion (>= 2 branch levels)', () => {
			const count = NodeCapacity * NodeCapacity + 1;	// 4097 -> 3 levels
			const tree = buildSeq(count);
			const root = (tree as any)['_root'];
			expect(root instanceof BranchNode && root.nodes[0] instanceof BranchNode, 'genuinely 3-level').to.be.true;
			expect(tree.find(2048).branches.length, 'target sits deep').to.be.greaterThanOrEqual(2);
			for (const key of [-1, 0, 1, 63, 64, 65, 2048, 2048.5, count - 1, count]) {
				const p = tree.find(key);
				assertSamePath(p, refFind(root, key), `find(${key})`);
				assertDescentChainConsistent(tree, p, `find(${key})`);
			}
			assertSamePath(tree.first(), refEdge(root, false), 'first()');
			assertSamePath(tree.last(), refEdge(root, true), 'last()');
			assertDescentChainConsistent(tree, tree.first(), 'first()');
			assertDescentChainConsistent(tree, tree.last(), 'last()');
		}).timeout(15000);
	});

	describe('cross-leaf branch truncation (length -=) after descent (§3.3)', () => {
		// internalNext/internalPrior now truncate path.branches with `length -=` instead of splice. Stepping across
		// leaf (and cross-branch) boundaries must still land on the right entry with a correctly-truncated,
		// still-consistent branch chain. Walk the whole 3-level tree forward and back, one step at a time.
		it('full forward + backward walk of a 3-level tree stays correct and consistent', () => {
			const count = NodeCapacity * NodeCapacity + 1;	// 4097 -> 3 levels
			const tree = buildSeq(count);
			const root = (tree as any)['_root'];
			expect(root instanceof BranchNode && root.nodes[0] instanceof BranchNode).to.be.true;

			// Forward from first(): expect 0..count-1, each path a consistent root->leaf chain.
			let expected = 0;
			const fwd = tree.first();
			for (const path of tree.ascending(fwd)) {
				expect(tree.at(path), `forward @ ${expected}`).to.equal(expected);
				if (expected % 257 === 0) assertDescentChainConsistent(tree, path, `forward @ ${expected}`);
				expected++;
			}
			expect(expected, 'forward walk visited every entry').to.equal(count);

			// Backward from last(): expect count-1..0.
			expected = count - 1;
			for (const path of tree.descending(tree.last())) {
				expect(tree.at(path), `backward @ ${expected}`).to.equal(expected);
				if (expected % 257 === 0) assertDescentChainConsistent(tree, path, `backward @ ${expected}`);
				expected--;
			}
			expect(expected, 'backward walk visited every entry').to.equal(-1);
		}).timeout(20000);

		it('cross-branch boundary step lands on the right entry (single-leaf truncation no-op safe)', () => {
			// Single-leaf tree: branches is empty, so a boundary step must not touch a non-existent branch (popCount 0,
			// length -= 0 is a no-op). next off the last entry goes off; prior back on.
			const solo = buildSeq(5);
			expect((solo as any)['_root'] instanceof LeafNode).to.be.true;
			const end = solo.find(4);
			expect(solo.next(end).on, 'next off the last entry of a single leaf is off').to.be.false;
			expect(solo.at(solo.prior(end)), 'prior back onto 3').to.equal(3);
		});
	});

	describe('range() end-by-position in a 3-level tree (§3.4)', () => {
		// The 2-level suite proves the (leafNode, leafIndex) match fires in a sibling leaf; the comparator-count
		// suite runs only at 2-level (n<=500). Nothing above exercised a *bounded* range() whose forward/backward
		// scan crosses a level-2 (cross-branch) boundary before the position match terminates it - the handoff
		// flagged this as only implicitly covered. Pin it explicitly in both directions on a genuine 3-level tree.
		const count = NodeCapacity * NodeCapacity + 1;	// 4097 -> 3 levels
		let tree: BTree<number, number>;
		beforeEach(() => {
			tree = buildSeq(count);
			const root = (tree as any)['_root'];
			expect(root instanceof BranchNode && root.nodes[0] instanceof BranchNode, 'genuinely 3-level').to.be.true;
		});

		it('ascending bounded range spanning many leaves stops exactly at the end position', () => {
			// A wide span (guaranteed to cross leaf and at least one cross-branch boundary) must terminate at 2100,
			// not overshoot to the end of the tree - the whole point of the fixed end-position match.
			const out = rangeValues(tree, new KeyRange(new KeyBound(2000), new KeyBound(2100)));
			expect(out).to.deep.equal([...Array(101).keys()].map(i => i + 2000));
		});

		it('descending bounded range spanning many leaves stops exactly at the end position', () => {
			const out = rangeValues(tree, new KeyRange(new KeyBound(2100), new KeyBound(2000), false));
			expect(out).to.deep.equal([...Array(101).keys()].map(i => 2100 - i));
		});

		it('exclusive bounds inside a 3-level tree still land one in from each end', () => {
			expect(rangeValues(tree, new KeyRange(new KeyBound(500, false), new KeyBound(505, false))))
				.to.deep.equal([501, 502, 503, 504]);
			expect(rangeValues(tree, new KeyRange(new KeyBound(505, false), new KeyBound(500, false), false)))
				.to.deep.equal([504, 503, 502, 501]);
		});
	});

	describe('start-past-end guard honors a custom comparator (§3.4)', () => {
		// The empty-region tests above all use the default numeric comparator. The up-front guard calls the *user*
		// comparator (via compareKeys), so an inverted range under a reverse-order comparator must be caught the same
		// way - and a well-formed range under it must still yield in that comparator's order.
		const reverse = () => new BTree<number, number>(k => k, (a, b) => a > b ? -1 : a < b ? 1 : 0);
		let tree: BTree<number, number>;
		beforeEach(() => {
			tree = reverse();
			for (let i = 0; i < 40; i++) tree.insert(i);	// stored in reverse order: 39, 38, ... 0
		});

		it('a well-formed ascending range under a reverse comparator yields in comparator order', () => {
			// "Ascending" = comparator order = descending numerically. Bounds are first=high-in-comparator (10) to
			// last=low-in-comparator (5): under reverse order 10 precedes 5, so this is well-formed and yields 10..5.
			expect(rangeValues(tree, new KeyRange(new KeyBound(10), new KeyBound(5)))).to.deep.equal([10, 9, 8, 7, 6, 5]);
		});

		it('an inverted range under a reverse comparator is caught by the guard (empty)', () => {
			// first=5, last=10: under reverse order 5 comes *after* 10, so start is already past end -> the guard
			// must return empty (a per-element numeric compare would be wrong here; only the user comparator decides).
			expect(rangeValues(tree, new KeyRange(new KeyBound(5), new KeyBound(10)))).to.deep.equal([]);
		});
	});
});
