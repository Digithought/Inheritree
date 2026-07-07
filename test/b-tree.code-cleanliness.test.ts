import { expect } from 'chai';
import {
	BTree,
	HalfCapacity,
	InconsistentComparatorError,
	InvalidPathError,
	NodeCapacity,
} from '../src/index.js';

// Locks in the public surface introduced by the code-cleanliness ticket: the named HalfCapacity
// constant, the two dedicated Error subclasses (replacing bare `new Error(...)`), and the getCount
// stale-path validation (now validated in the public wrapper for BOTH directions, where the
// ascending branch previously walked a stale path silently).

describe('code-cleanliness: named half-capacity constant', () => {
	it('HalfCapacity is the underflow threshold NodeCapacity >>> 1', () => {
		expect(HalfCapacity).to.equal(NodeCapacity >>> 1);
		expect(HalfCapacity).to.equal(32);	// NodeCapacity is fixed at 64
	});
});

describe('code-cleanliness: typed errors', () => {
	it('a stale path throws InvalidPathError (still an Error for back-compat)', () => {
		const tree = new BTree<number, number>();
		[1, 2, 3].forEach(k => tree.insert(k));
		const path = tree.find(2);
		tree.insert(4);	// mutate -> bumps version -> path is stale
		let caught: unknown;
		try {
			tree.at(path);
		} catch (e) {
			caught = e;
		}
		expect(caught).to.be.instanceOf(InvalidPathError);
		expect(caught).to.be.instanceOf(Error);
		expect((caught as Error).name).to.equal('InvalidPathError');
	});

	it('an inconsistent comparator throws InconsistentComparatorError (still an Error)', () => {
		const POISON = -1;
		const compare = (a: number, b: number): number => {
			if (a === POISON || b === POISON) return -1;	// compare(x,POISON) === compare(POISON,x): inconsistent
			return a < b ? -1 : a > b ? 1 : 0;
		};
		const tree = new BTree<number, number>(k => k, compare);
		[5, 10, 15].forEach(k => tree.insert(k));	// POISON never inserted
		let caught: unknown;
		try {
			tree.find(POISON);
		} catch (e) {
			caught = e;
		}
		expect(caught).to.be.instanceOf(InconsistentComparatorError);
		expect(caught).to.be.instanceOf(Error);
		expect((caught as Error).name).to.equal('InconsistentComparatorError');
	});
});

describe('code-cleanliness: getCount validates a stale start path in both directions', () => {
	function staleTree(): { tree: BTree<number, number>; stale: ReturnType<BTree<number, number>['find']> } {
		const tree = new BTree<number, number>();
		for (let i = 0; i < 200; i++) tree.insert(i);	// multi-leaf
		const stale = tree.find(100);
		tree.insert(1000);	// mutate -> path now stale
		return { tree, stale };
	}

	it('descending getCount throws InvalidPathError on a stale path', () => {
		const { tree, stale } = staleTree();
		expect(() => tree.getCount({ path: stale, ascending: false })).to.throw(InvalidPathError);
	});

	it('ascending getCount also throws InvalidPathError on a stale path (previously walked it silently)', () => {
		const { tree, stale } = staleTree();
		expect(() => tree.getCount({ path: stale, ascending: true })).to.throw(InvalidPathError);
	});

	it('getCount on a fresh path still counts correctly (guard does not block valid paths)', () => {
		const tree = new BTree<number, number>();
		for (let i = 0; i < 200; i++) tree.insert(i);
		expect(tree.getCount({ path: tree.find(100), ascending: true })).to.equal(100);	// 100..199
		expect(tree.getCount({ path: tree.find(100), ascending: false })).to.equal(101);	// 0..100
	});
});
