import { expect } from 'chai';
import { BTree } from '../src/b-tree.js';

// Covers tickets/fix/1-cow-shallow-clone.md: LeafNode/BranchNode.clone() must shallow-copy
// (slice) rather than structuredClone, so entries shared with the base tree keep their
// prototype, identity, and frozen-ness across a copy-on-write clone of the leaf holding them.
describe('BTree COW node clone: entries shared by reference (not deep-copied)', () => {
	class Widget {
		constructor(public id: number, public label: string) { }
		describe() { return `widget:${this.id}:${this.label}`; }
	}

	it('preserves class-instance prototype (methods/getters) after a COW leaf clone', () => {
		const base = new BTree<number, Widget>(w => w.id);
		base.insert(new Widget(1, 'base one'));
		base.insert(new Widget(2, 'base two'));

		const derived = new BTree<number, Widget>(w => w.id, undefined, { base });
		// Write a different key so the leaf holding id=1 gets cloned via copy-on-write.
		derived.insert(new Widget(3, 'derived three'));

		const entry = derived.get(1);
		expect(entry).to.be.instanceOf(Widget);
		expect(entry!.describe()).to.equal('widget:1:base one');
	});

	it('does not throw DataCloneError on a COW leaf clone for function-bearing entries', () => {
		const base = new BTree<number, { id: number; fn: () => number }>(e => e.id);
		base.insert({ id: 1, fn: () => 42 });

		const derived = new BTree<number, { id: number; fn: () => number }>(e => e.id, undefined, { base });
		expect(() => derived.insert({ id: 2, fn: () => 99 })).not.to.throw();

		expect(derived.get(1)!.fn()).to.equal(42);
	});

	it('keeps entry identity (===) across base and derived after a COW leaf clone', () => {
		const base = new BTree<number, { id: number }>(e => e.id);
		base.insert({ id: 1 });
		base.insert({ id: 2 });

		const derived = new BTree<number, { id: number }>(e => e.id, undefined, { base });
		derived.insert({ id: 3 }); // forces the shared leaf to clone

		expect(derived.get(1)).to.equal(base.get(1));
		expect(derived.get(2)).to.equal(base.get(2));
	});

	it('keeps entries frozen after a COW leaf clone under the default (freeze: true) config', () => {
		const base = new BTree<number, { id: number }>(e => e.id);
		base.insert({ id: 1 });

		const derived = new BTree<number, { id: number }>(e => e.id, undefined, { base });
		derived.insert({ id: 2 });

		expect(Object.isFrozen(base.get(1))).to.be.true;
		expect(Object.isFrozen(derived.get(1))).to.be.true;
	});

	it('shares entries by reference (not deep-copied) when freeze: false', () => {
		const base = new BTree<number, { id: number }>(e => e.id, undefined, { freeze: false });
		const original = { id: 1 };
		base.insert(original);

		const derived = new BTree<number, { id: number }>(e => e.id, undefined, { base, freeze: false });
		derived.insert({ id: 2 });

		expect(Object.isFrozen(base.get(1))).to.be.false;
		expect(derived.get(1)).to.equal(base.get(1));
		expect(derived.get(1)).to.equal(original);
	});

	it('branch-level clone (partitions) also shallow-copies, keeping child-node sharing intact', () => {
		const base = new BTree<number, { id: number }>(e => e.id);
		// Push well past NodeCapacity (64) so base becomes multi-level (branch + leaves).
		for (let i = 0; i < 400; i++) base.insert({ id: i });

		const derived = new BTree<number, { id: number }>(e => e.id, undefined, { base });
		// Write one key so only that leaf (and its ancestor branches) clone; most leaves stay base-owned.
		derived.insert({ id: 1000 });

		// Untouched entries, in leaves that never cloned, must remain identity-shared with base.
		expect(derived.get(0)).to.equal(base.get(0));
		expect(derived.get(399)).to.equal(base.get(399));
		expect(derived.get(1000)).to.deep.equal({ id: 1000 });
		expect(base.get(1000)).to.be.undefined;
	});
});
