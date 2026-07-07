import { expect } from 'chai';
import { BTree, KeyBound, KeyRange, InvalidPathError, Path } from '../src/index.js';
import { lcg, shuffle } from './helpers/rng.js';

// Coverage for the cursor/iteration ergonomics ticket:
//   * entries()/keys()/[Symbol.iterator] - the aliasing-free entry iterators (the fix for the "spread the raw
//     path iterator and get all-undefined" trap),
//   * no-argument ascending()/descending() (default to first()/last()),
//   * clear() (empty in place, invalidate outstanding paths, stay reusable),
//   * empty-tree behavior of all of the above,
//   * type-level insulation: the public Path interface exposes on/isEqual/clone but NOT the structural fields.

const SEED = 0xf00dbabe;

// A multi-leaf tree (NodeCapacity is 64) so iteration genuinely crosses leaf boundaries.
const buildSet = (n: number): BTree<number, number> => {
	const tree = new BTree<number, number>();
	const rng = lcg(SEED);
	for (const k of shuffle([...Array(n).keys()], rng)) tree.insert(k);
	return tree;
};

// Full in-order entry list read the SAFE way through the raw path iterator: read tree.at(p) INSIDE the loop,
// never spread. This is the reference the convenience iterators must match, and the thing they let you skip.
const manualAscending = <TKey, TEntry>(tree: BTree<TKey, TEntry>): TEntry[] => {
	const out: TEntry[] = [];
	for (const p of tree.ascending(tree.first())) out.push(tree.at(p)!);
	return out;
};

const manualDescending = <TKey, TEntry>(tree: BTree<TKey, TEntry>): TEntry[] => {
	const out: TEntry[] = [];
	for (const p of tree.descending(tree.last())) out.push(tree.at(p)!);
	return out;
};

// range() re-yields the same cursor each step; read inside the loop.
const rangeValues = <TKey, TEntry>(tree: BTree<TKey, TEntry>, range: KeyRange<TKey>): TEntry[] => {
	const out: TEntry[] = [];
	for (const p of tree.range(range)) out.push(tree.at(p)!);
	return out;
};

describe('Iteration ergonomics: entries / keys / for..of', () => {
	const N = 200;	// > NodeCapacity -> several leaves

	it('[...tree.entries()] yields N DISTINCT entries in ascending order (the aliasing-trap regression)', () => {
		const tree = buildSet(N);
		const result = [...tree.entries()];

		expect(result.length, 'one element per entry').to.equal(N);
		// The core regression: under the old raw-path spread this array was all-undefined (N aliases of one
		// cursor parked off the end). entries() reads inside the loop, so every element is a distinct value.
		expect(new Set(result).size, 'every yielded entry is distinct').to.equal(N);
		expect(result, 'ascending key order').to.deep.equal([...Array(N).keys()]);
		expect(result, 'matches a manual in-loop ascending walk').to.deep.equal(manualAscending(tree));
	});

	it('for (const e of tree) visits every entry once, ascending; [...tree] equals [...tree.entries()]', () => {
		const tree = buildSet(N);
		const seen: number[] = [];
		for (const e of tree) seen.push(e);
		expect(seen).to.deep.equal([...Array(N).keys()]);
		expect([...tree]).to.deep.equal([...tree.entries()]);
	});

	it('keys() yields the extracted keys in order (dictionary tree, key distinct from entry)', () => {
		interface Row { id: number; value: string }
		const dict = new BTree<number, Row>(e => e.id);
		const rng = lcg(SEED);
		for (const id of shuffle([...Array(N).keys()], rng)) dict.insert({ id, value: `v${id}` });

		expect([...dict.keys()], 'keys in ascending order').to.deep.equal([...Array(N).keys()]);
		// keys() is entries() passed through keyFromEntry - so it must line up element-for-element with entries().
		expect([...dict.keys()]).to.deep.equal([...dict.entries()].map(e => e.id));
	});

	it('entries(range) delegates to range() identically - ascending, mixed inclusive/exclusive bounds', () => {
		const tree = buildSet(N);
		// first inclusive (20), last exclusive (60) -> [20..59].
		const range = new KeyRange(new KeyBound(20, true), new KeyBound(60, false), true);
		expect([...tree.entries(range)]).to.deep.equal(rangeValues(tree, range));
		expect([...tree.entries(range)]).to.deep.equal([...Array(40).keys()].map(i => i + 20));
		// keys(range) tracks the same delegation.
		expect([...tree.keys(range)]).to.deep.equal(rangeValues(tree, range));
	});

	it('entries(range) delegates to range() identically - descending, mixed inclusive/exclusive bounds', () => {
		const tree = buildSet(N);
		// Descending: first (high) exclusive (100), last (low) inclusive (95) -> [99, 98, 97, 96, 95].
		const range = new KeyRange(new KeyBound(100, false), new KeyBound(95, true), false);
		expect([...tree.entries(range)]).to.deep.equal(rangeValues(tree, range));
		expect([...tree.entries(range)]).to.deep.equal([99, 98, 97, 96, 95]);
	});

	it('no-arg ascending()/descending() equal ascending(first())/descending(last()) element-for-element', () => {
		const tree = buildSet(N);
		const noArgAsc: number[] = [];
		for (const p of tree.ascending()) noArgAsc.push(tree.at(p)!);
		expect(noArgAsc, 'no-arg ascending == ascending(first())').to.deep.equal(manualAscending(tree));

		const noArgDesc: number[] = [];
		for (const p of tree.descending()) noArgDesc.push(tree.at(p)!);
		expect(noArgDesc, 'no-arg descending == descending(last())').to.deep.equal(manualDescending(tree));
	});
});

describe('Iteration ergonomics: clear()', () => {
	it('empties the tree, invalidates outstanding paths, and leaves it reusable', () => {
		const tree = buildSet(200);
		const captured = tree.find(100);
		expect(tree.at(captured), 'captured path is live before clear').to.equal(100);

		tree.clear();

		// Emptied immediately.
		expect(tree.getCount(), 'count is 0 right after clear').to.equal(0);
		expect(tree.first().on, 'first() sits off any entry').to.be.false;
		expect([...tree.entries()], 'no entries').to.deep.equal([]);

		// The pre-clear path is now invalid (clear bumped the version, like any mutation).
		expect(() => tree.at(captured), 'pre-clear path throws').to.throw(InvalidPathError);

		// And the tree still works: insert then read back.
		expect(tree.insert(7).on, 'insert works after clear').to.be.true;
		expect(tree.insert(3).on).to.be.true;
		expect(tree.get(7)).to.equal(7);
		expect([...tree.entries()]).to.deep.equal([3, 7]);
		expect(tree.getCount()).to.equal(2);
	});

	it('clear() mid-iteration invalidates a live entries() walk on its next step', () => {
		const tree = buildSet(200);
		const walk = tree.entries();
		expect(walk.next().value, 'first entry read before clear').to.equal(0);
		tree.clear();	// bumps the version like any mutation
		// entries() reads tree.at(path) inside the loop, so the very next step validates and throws.
		expect(() => walk.next(), 'next step after clear throws').to.throw(InvalidPathError);
	});

	it('clear() on an empty tree is a no-op count-wise but still invalidates prior paths', () => {
		const tree = new BTree<number, number>();
		const before = tree.first();		// off path, version 0
		tree.clear();
		expect(tree.getCount()).to.equal(0);
		expect(() => tree.at(before), 'even an off path from before is invalidated').to.throw(InvalidPathError);
	});
});

describe('Iteration ergonomics: empty tree yields nothing', () => {
	it('entries / keys / [...tree] / no-arg ascending / no-arg descending all yield nothing (no throw)', () => {
		const tree = new BTree<number, number>();
		expect([...tree.entries()], 'entries()').to.deep.equal([]);
		expect([...tree.keys()], 'keys()').to.deep.equal([]);
		expect([...tree], 'for..of').to.deep.equal([]);

		let ascCount = 0;
		for (const _ of tree.ascending()) ascCount++;
		expect(ascCount, 'no-arg ascending()').to.equal(0);

		let descCount = 0;
		for (const _ of tree.descending()) descCount++;
		expect(descCount, 'no-arg descending()').to.equal(0);

		// A range on an empty tree is also empty.
		expect([...tree.entries(new KeyRange(new KeyBound(0), new KeyBound(9)))]).to.deep.equal([]);
	});
});

describe('Iteration ergonomics: Path is insulated at the type level', () => {
	// This test is compiled by tsc (it runs under ts-node). It documents that the public Path interface exposes
	// only on / isEqual / clone, and that the structural fields are gone from the exported type. The
	// expect-error assertions below fail the build if any internal field ever leaks back onto the public surface.
	it('public Path exposes on/isEqual/clone but not the internal structural fields', () => {
		const tree = buildSet(10);
		const p: Path<number, number> = tree.first();

		// These are the public surface and must keep compiling:
		expect(p.on).to.be.true;
		expect(p.isEqual(tree.first())).to.be.true;
		expect(p.clone().isEqual(p)).to.be.true;

		// These must NOT compile through the public Path interface - the internals are hidden.
		// @ts-expect-error - leafIndex is a PathImpl internal, absent from the public Path interface
		void p.leafIndex;
		// @ts-expect-error - version is a PathImpl internal, absent from the public Path interface
		void p.version;
		// @ts-expect-error - branches is a PathImpl internal, absent from the public Path interface
		void p.branches;
		// @ts-expect-error - leafNode is a PathImpl internal, absent from the public Path interface
		void p.leafNode;
	});
});
