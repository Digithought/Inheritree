import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/index.js';
import { lcg, lcgInt } from './helpers/rng.js';

// Covers the stored O(1) count (src/b-tree.ts): the no-arg getCount() and the size getter both read a single
// _count field maintained by +1 per real insertion / -1 per real deletion. The load-bearing property is that
// the stored count tracks a full leaf traversal after EVERY operation, including the no-op paths (rejected
// duplicate insert, in-place update/upsert, key-change net-zero, absent-key delete) that must leave it alone.

interface Entry { id: number; value: string }

// The ground-truth count: a full in-order traversal via the public entry iterator (never the stored count).
const walkCount = <T>(tree: BTree<any, T>): number => {
	let n = 0;
	for (const _ of tree.entries()) n++;
	return n;
};

describe('Stored O(1) count (size / no-arg getCount)', () => {

	it('size and no-arg getCount() agree and both equal a full traversal', () => {
		const tree = new BTree<number, number>();
		for (const k of [5, 1, 9, 3, 7]) tree.insert(k);
		expect(tree.size).to.equal(5);
		expect(tree.getCount()).to.equal(5);
		expect(tree.size).to.equal(tree.getCount());
		expect(tree.size).to.equal(walkCount(tree));
	});

	it('grows past a single leaf (multi-level) and still reports the exact count', () => {
		const tree = new BTree<number, number>();
		const N = NodeCapacity * 4 + 1;	// forces branches, not just one leaf
		for (let i = 0; i < N; i++) tree.insert(i);
		expect(tree.size).to.equal(N);
		expect(tree.getCount()).to.equal(N);
		expect(walkCount(tree)).to.equal(N);
	});

	describe('no-op mutations leave the count unchanged', () => {
		it('a rejected duplicate insert', () => {
			const tree = new BTree<number, number>();
			tree.insert(5);
			const before = tree.size;
			const path = tree.insert(5);	// duplicate -> rejected
			expect(path.on, 'duplicate insert is rejected').to.be.false;
			expect(tree.size, 'size unchanged after rejected duplicate').to.equal(before);
			expect(tree.getCount()).to.equal(before);
		});

		it('a same-key upsert (in-place replace)', () => {
			const dict = new BTree<number, Entry>(e => e.id);
			for (let i = 0; i < 100; i++) dict.insert({ id: i, value: `v${i}` });
			const before = dict.size;
			dict.upsert({ id: 42, value: 'REPLACED' });	// key present -> in-place, no count change
			expect(dict.get(42)!.value).to.equal('REPLACED');
			expect(dict.size, 'size unchanged after in-place upsert').to.equal(before);
			expect(dict.getCount()).to.equal(before);
		});

		it('an in-place (value-only) updateAt', () => {
			const dict = new BTree<number, Entry>(e => e.id);
			for (let i = 0; i < 100; i++) dict.insert({ id: i, value: `v${i}` });
			const before = dict.size;
			dict.updateAt(dict.find(42), { id: 42, value: 'DEEP' });	// same key -> in-place
			expect(dict.get(42)!.value).to.equal('DEEP');
			expect(dict.size, 'size unchanged after value-only updateAt').to.equal(before);
			expect(dict.getCount()).to.equal(before);
		});

		it('a key-changing updateAt (net +1 insert / -1 delete = 0)', () => {
			const tree = new BTree<number, number>();
			for (let i = 0; i < 100; i++) tree.insert(i);
			const before = tree.size;
			const [path, wasUpdate] = tree.updateAt(tree.find(42), 1000);	// 42 -> 1000 (absent): relocate
			expect(wasUpdate).to.be.false;
			expect(path.on).to.be.true;
			expect(tree.size, 'relocation is net-zero on the count').to.equal(before);
			expect(tree.getCount()).to.equal(before);
			expect(walkCount(tree)).to.equal(before);
		});

		it('a conflicting key-change updateAt (target already present)', () => {
			const tree = new BTree<number, number>();
			for (let i = 0; i < 100; i++) tree.insert(i);
			const before = tree.size;
			const [path, wasUpdate] = tree.updateAt(tree.find(42), 43);	// 43 already present -> fails
			expect(path.on, 'conflict leaves path off').to.be.false;
			expect(wasUpdate).to.be.false;
			expect(tree.size, 'failed key change leaves the count alone').to.equal(before);
			expect(tree.getCount()).to.equal(before);
		});

		it('a key-changing merge (net-zero) and a conflicting merge', () => {
			const tree = new BTree<number, number>();
			for (let i = 0; i < 100; i++) tree.insert(i);
			const before = tree.size;
			tree.merge(10, () => 2000);	// present -> relocate 10 to absent 2000: net zero
			expect(tree.size).to.equal(before);
			tree.merge(20, () => 21);	// present -> relocate 20 onto present 21: conflict, no change
			expect(tree.size).to.equal(before);
			expect(tree.getCount()).to.equal(before);
		});

		it('a delete of an absent key', () => {
			const tree = new BTree<number, number>();
			for (let i = 0; i < 100; i++) tree.insert(i);
			const before = tree.size;
			const ok = tree.deleteAt(tree.find(999));	// absent -> off-entry path -> no-op
			expect(ok).to.be.false;
			expect(tree.size, 'absent-key delete leaves the count alone').to.equal(before);
			expect(tree.getCount()).to.equal(before);
		});
	});

	it('clear() resets the count to 0', () => {
		const tree = new BTree<number, number>();
		for (let i = 0; i < 200; i++) tree.insert(i);
		expect(tree.size).to.be.greaterThan(0);
		tree.clear();
		expect(tree.size, 'size is 0 after clear').to.equal(0);
		expect(tree.getCount(), 'getCount() is 0 after clear').to.equal(0);
		expect(walkCount(tree)).to.equal(0);
		tree.insert(1);	// still usable after clear, and the count resumes from 0
		expect(tree.size).to.equal(1);
	});

	it('stays exact across a seeded stream of insert/delete/upsert/updateAt/merge', () => {
		// Oracle: mirror every op in a plain Set and, after EVERY op, assert the stored count (size and the
		// no-arg getCount) and a full leaf traversal all equal the shadow's size. A stored count that drifts
		// by even one on a single no-op path (rejected duplicate, in-place update, net-zero relocate, conflict,
		// absent delete) trips this immediately.
		const tree = new BTree<number, number>();
		const shadow = new Set<number>();
		const rng = lcg(0xc0117ed);
		const RANGE = 400;	// key space small enough that collisions exercise every no-op branch, large enough to go multi-level
		const OPS = 3000;

		const present = (): number => {	// a present key drawn from the seeded rng, or -1 when empty
			if (shadow.size === 0) return -1;
			const keys = [...shadow];
			return keys[lcgInt(rng, 0, keys.length)];
		};

		for (let i = 0; i < OPS; i++) {
			const op = lcgInt(rng, 0, 5);
			switch (op) {
				case 0: {	// insert (adds only if absent)
					const k = lcgInt(rng, 0, RANGE);
					tree.insert(k);
					shadow.add(k);
					break;
				}
				case 1: {	// delete (removes only if present)
					const k = lcgInt(rng, 0, RANGE);
					tree.deleteAt(tree.find(k));
					shadow.delete(k);
					break;
				}
				case 2: {	// upsert (adds if absent, in-place if present)
					const k = lcgInt(rng, 0, RANGE);
					tree.upsert(k);
					shadow.add(k);
					break;
				}
				case 3: {	// updateAt on a present key -> maybe same, maybe relocate, maybe conflict
					const oldK = present();
					if (oldK < 0) break;
					const newK = lcgInt(rng, 0, RANGE);
					tree.updateAt(tree.find(oldK), newK);
					if (newK === oldK) { /* in-place: no change */ }
					else if (!shadow.has(newK)) { shadow.delete(oldK); shadow.add(newK); }	// relocate
					else { /* conflict: no change */ }
					break;
				}
				case 4: {	// merge: insert branch when absent, updateAt branch (via getUpdated) when present
					const k = lcgInt(rng, 0, RANGE);
					const newK = lcgInt(rng, 0, RANGE);
					tree.merge(k, () => newK);
					if (!shadow.has(k)) { shadow.add(k); }	// insert branch
					else if (newK === k) { /* in-place */ }
					else if (!shadow.has(newK)) { shadow.delete(k); shadow.add(newK); }	// relocate
					else { /* conflict */ }
					break;
				}
			}

			expect(tree.size, `size after op ${i}`).to.equal(shadow.size);
			expect(tree.getCount(), `getCount() after op ${i}`).to.equal(shadow.size);
			expect(tree.size, `size === getCount() after op ${i}`).to.equal(tree.getCount());
			expect(walkCount(tree), `traversal count after op ${i}`).to.equal(shadow.size);
		}
	});
});
