import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { assertTreeInvariants, reachableNodesOf, sharedReachableNodes } from './helpers/invariants.js';

// Covers BTree.flatten() (src/b-tree.ts): the O(n) genuine-isolation alternative to clearBase(), built on
// top of the BTree.buildFrom bulk loader. The load-bearing property clearBase() cannot offer is that the
// result shares NO node, by identity, with the tree's former base - not just equal values.

interface Entry {
	id: number;
	value: string;
}

const keyOf = (e: Entry): number => e.id;
const cmp = (a: number, b: number): number => a - b;
const byId = (a: Entry, b: Entry): number => a.id - b.id;

describe('BTree.flatten (genuine-isolation copy)', () => {
	it('empty tree: flatten() returns a valid, independent empty tree', () => {
		const tree = new BTree<number, Entry>(keyOf, cmp);
		const flat = tree.flatten();

		expect(flat.size, 'flattened empty tree has size 0').to.equal(0);
		assertTreeInvariants(flat);
		expect([...flat.entries()], 'no entries').to.deep.equal([]);

		// Still usable afterward: insert works, and the two trees are independent.
		expect(flat.insert({ id: 1, value: 'a' }).on, 'insert into flattened tree works').to.equal(true);
		expect(tree.size, 'original tree untouched by writes to its flattened copy').to.equal(0);
	});

	it('tree with no base: flatten() still returns an independent copy (does not assume a base exists)', () => {
		const tree = new BTree<number, Entry>(keyOf, cmp);
		for (let i = 1; i <= 200; i++) tree.insert({ id: i, value: `v${i}` });
		assertTreeInvariants(tree);

		const flat = tree.flatten();
		assertTreeInvariants(flat);

		expect([...flat.entries()], 'value equality with the source').to.deep.equal([...tree.entries()]);
		const shared = sharedReachableNodes(flat, tree);
		expect(shared.length, 'flatten shares no node with the base-less source tree').to.equal(0);

		// And the two are independently mutable.
		flat.deleteAt(flat.find(1));
		expect(tree.get(1), 'writing to the flattened copy does not affect the source').to.deep.equal({ id: 1, value: 'v1' });
	});

	it('tree derived from a base: flatten() shares no node with the former base (node-identity disjointness, not just value equality)', () => {
		const base = new BTree<number, Entry>(keyOf, cmp);
		for (let i = 1; i <= 300; i++) base.insert({ id: i * 10, value: `base_${i * 10}` });
		assertTreeInvariants(base);

		const child = new BTree<number, Entry>(keyOf, cmp, { base });
		// Write only a narrow region so most of child's structure is still (shared) base structure.
		for (const id of [1000, 1010, 1020]) child.deleteAt(child.find(id));
		for (const id of [1001, 1011]) child.insert({ id, value: `c_${id}` });
		assertTreeInvariants(child);

		// Sanity: before flattening, child really does share nodes with base (the hazard flatten fixes).
		expect(sharedReachableNodes(child, base).length, 'child shares structure with its base before flatten').to.be.greaterThan(0);

		const flat = child.flatten();
		assertTreeInvariants(flat);

		const expected = [...child.entries()];
		expect([...flat.entries()], 'value equality with the source (child)').to.deep.equal(expected);

		expect(sharedReachableNodes(flat, base).length, 'flatten shares no node with the former base').to.equal(0);
		expect(sharedReachableNodes(flat, child).length, 'flatten shares no node with the source tree either').to.equal(0);

		// Genuine isolation: mutating the former base afterward must not leak into the flattened copy.
		base.deleteAt(base.find(10));
		base.insert({ id: 5, value: 'base_new' });
		expect([...flat.entries()], 'flattened copy unaffected by later base mutation').to.deep.equal(expected);
	});

	it('carries over the freeze and checkComparator options so the flattened tree behaves identically', () => {
		const base = new BTree<number, Entry>(keyOf, cmp, { freeze: false, checkComparator: true });
		for (let i = 1; i <= 10; i++) base.insert({ id: i, value: `v${i}` });

		const flat = base.flatten();

		expect((flat as any)['_freeze'], 'freeze option carried over').to.equal(false);
		expect((flat as any)['_checkComparator'], 'checkComparator option carried over').to.equal(true);

		// freeze: false means entries are not frozen by insert/flatten.
		const entry = flat.get(1)!;
		expect(Object.isFrozen(entry), 'entries not frozen when freeze is false').to.equal(false);
	});

	it('carries over the SAFE defaults (freeze: true, checkComparator: false) - a flatten that hardcoded freeze:false would silently break protection', () => {
		// A source built with defaults: freeze on, per-comparison check off. flatten() must reproduce both, or
		// the flattened tree quietly loses key-mutation protection while the freeze:false test above still passes.
		const tree = new BTree<number, Entry>(keyOf, cmp);
		for (let i = 1; i <= 10; i++) tree.insert({ id: i, value: `v${i}` });

		const flat = tree.flatten();

		expect((flat as any)['_freeze'], 'freeze default (true) carried over').to.equal(true);
		expect((flat as any)['_checkComparator'], 'checkComparator default (false) carried over').to.equal(false);

		// freeze: true means buildFrom froze the entries in the flattened tree.
		expect(Object.isFrozen(flat.get(1)!), 'entries frozen when freeze defaults to true').to.equal(true);
	});

	it('large multi-level tree: flatten() reproduces exact key/value set and passes structural invariants', () => {
		const tree = new BTree<number, Entry>(keyOf, cmp);
		for (let i = 1; i <= NodeCapacity * 20; i++) tree.insert({ id: i, value: `v${i}` });
		assertTreeInvariants(tree);

		const flat = tree.flatten();
		assertTreeInvariants(flat);
		expect(flat.size, 'size matches source').to.equal(tree.size);
		expect([...flat.entries()].sort(byId), 'entries match source').to.deep.equal([...tree.entries()].sort(byId));
		expect(reachableNodesOf(flat).size, 'flattened tree has its own reachable node set').to.be.greaterThan(0);
	});
});
