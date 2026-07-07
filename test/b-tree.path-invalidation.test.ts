import { expect } from 'chai';
import { BTree } from '../src/index.js';
import { assertTreeInvariants } from './helpers/invariants.js';
import { asImpl } from './helpers/path-impl.js';

describe('BTree Path Validation', () => {
	let tree: BTree<number, number>; // Example using number for both TKey and TEntry for simplicity

	beforeEach(() => {
		tree = new BTree<number, number>();
		// Populate the tree with initial data if necessary
	});

	// Helper function to populate the tree
	function populateTree(entries: number[]) {
		entries.forEach(entry => tree.insert(entry));
	}

	it('path remains valid after non-mutating operations', () => {
		populateTree([1, 2, 3]);
		const path = tree.find(2);
		const isValidBefore = tree.isValid(path);
		// Perform non-mutating operation
		tree.at(path);
		const isValidAfter = tree.isValid(path);
		expect(isValidBefore).to.be.true;
		expect(isValidAfter).to.be.true;
	});

	it('path is invalidated after insert', () => {
		populateTree([1, 2, 3]);
		const path = tree.find(2);
		tree.insert(4); // Mutating operation
		const isValid = tree.isValid(path);
		expect(isValid).to.be.false;
	});

	// The path handed to a mutation method is the one exception to "any mutation invalidates a path" (see the
	// Path class doc): deleteAt stamps the bumped version onto its own path so the caller can keep navigating.
	it('path passed to delete stays valid and lands at the deleted entry\'s crack', () => {
		populateTree([1, 2, 3]);
		const path = tree.find(2);
		const deleted = tree.deleteAt(path); // Mutating operation - stamps the new version onto this path
		expect(deleted).to.be.true;
		expect(path.on, 'the deleted position is now a crack').to.be.false;
		expect(tree.isValid(path), 'the passed path remains usable - no re-find needed to keep going').to.be.true;
	});

	it('delete-while-iterating: after deleteAt(p), moveNext(p) advances onto the successor with no intervening find', () => {
		populateTree([1, 2, 3]);
		const path = tree.find(2);
		expect(tree.deleteAt(path)).to.be.true;
		tree.moveNext(path); // reuses the same path object - would throw InvalidPathError without the version stamp
		expect(path.on).to.be.true;
		expect(tree.at(path), 'recovers onto the entry that followed the deleted one (2 -> 3)').to.equal(3);
	});

	// The single-leaf tests above establish the post-delete navigation contract; these extend it past a leaf
	// boundary and through a rebalance/merge, which the single 3-entry root leaf can never exercise. (Flagged
	// as untested in the 2-operation-result-contract review; promoted here so the contract is locked broadly.)
	describe('post-delete navigation across leaves and rebalances', () => {
		// 200 sequential entries (NodeCapacity 64) => a multi-level tree with several leaves.
		function buildMulti(n = 200) {
			const t = new BTree<number, number>();
			for (let i = 0; i < n; i++) t.insert(i);
			return t;
		}
		// The key whose successor is the first entry of the *next* leaf (i.e. it is the last entry of its leaf).
		function firstLeafBoundary(t: BTree<number, number>, n: number) {
			for (let k = 0; k < n - 1; k++) {
				if (asImpl(t.find(k)).leafNode !== asImpl(t.find(k + 1)).leafNode) return k;
			}
			return -1;
		}

		it('delete the last entry of a non-final leaf; moveNext crosses onto the next leaf off the same path', () => {
			const t = buildMulti();
			const boundary = firstLeafBoundary(t, 200);
			expect(boundary, 'a leaf boundary exists').to.be.greaterThan(-1);
			const p = t.find(boundary);
			expect(t.deleteAt(p)).to.be.true;
			t.moveNext(p); // no intervening find - relies on the version stamp + positional coherence
			expect(p.on).to.be.true;
			expect(t.at(p), 'recovers onto the deleted entry\'s successor across the leaf seam').to.equal(boundary + 1);
		});

		it('delete then movePrior lands on the predecessor (single-leaf and multi-leaf)', () => {
			const single = new BTree<number, number>();
			[0, 1, 2].forEach(k => single.insert(k));
			const sp = single.find(1);
			expect(single.deleteAt(sp)).to.be.true;
			single.movePrior(sp);
			expect(sp.on).to.be.true;
			expect(single.at(sp)).to.equal(0);

			const t = buildMulti();
			const boundary = firstLeafBoundary(t, 200);
			const target = boundary + 1; // first entry of a non-first leaf
			const p = t.find(target);
			expect(t.deleteAt(p)).to.be.true;
			t.movePrior(p);
			expect(p.on).to.be.true;
			expect(t.at(p), 'movePrior recovers onto the predecessor across the leaf seam').to.equal(target - 1);
		});

		it('delete-while-iterating through a rebalance: one path, no re-find, tree stays valid and consistent', () => {
			const t = buildMulti();
			// Delete a large contiguous run (forces underflow/merge) navigating off the same path each step.
			let p = t.find(40);
			let expectedSuccessor = 41;
			for (let i = 0; i < 100; i++) {
				const key = t.at(p)!;
				expect(t.deleteAt(p), `delete ${key}`).to.be.true;
				t.moveNext(p);
				if (expectedSuccessor <= 139) {
					expect(p.on, `moveNext recovers after deleting ${key}`).to.be.true;
					expect(t.at(p), `successor after deleting ${key}`).to.equal(expectedSuccessor);
				}
				expectedSuccessor++;
			}
			assertTreeInvariants(t);
			// 0..39 and 140..199 survive; 40..139 gone.
			expect(t.get(39)).to.equal(39);
			expect(t.get(70)).to.be.undefined;
			expect(t.get(140)).to.equal(140);
		});
	});

	it('path is invalidated after update', () => {
		populateTree([1, 2, 3]);
		const path = tree.find(2);
		tree.updateAt(path, 5); // Mutating operation
		const isValid = tree.isValid(path);
		expect(isValid).to.be.false;
	});

	it('path is invalidated during iteration after mutation', () => {
		populateTree([1, 2, 3, 4, 5]);
		const range = { first: { key: 1, inclusive: true }, last: { key: 5, inclusive: true }, isAscending: true };
		const iterator = tree.range(range);
		const firstPath = iterator.next().value;
		tree.insert(6); // Mutating operation during iteration
		const isValid = tree.isValid(firstPath!);
		expect(isValid).to.be.false;
		expect(() => iterator.next()).to.throw();
	});

	it('merge operation does not proceed when getUpdated mutates the tree', () => {
		populateTree([1, 2, 3]);

		// Attempt to perform a mutation within getUpdated
		const attemptMutationInGetUpdated = () => {
			tree.merge(
				3,	// Already present
				(existing) => {
					// Mutating operation within getUpdated
					tree.insert(5);
					return 4;
				}
			);
		};

		// Expect an exception to be thrown, preventing the merge
		expect(attemptMutationInGetUpdated).to.throw();
	});

});
