import { expect } from 'chai';
import { BTree, KeyBound, KeyRange, NodeCapacity, UnsortedInputError } from '../src/index.js';
import { assertTreeInvariants } from './helpers/invariants.js';

// Covers the static BTree.buildFrom bulk-load factory (src/b-tree.ts): a single bottom-up O(n) pass over
// already-sorted, duplicate-free input that packs nodes near capacity.  The load-bearing property is that the
// result is INDISTINGUISHABLE from a tree built by repeated insert - same structural invariants (assertTreeInvariants),
// same count, same query answers - while validating (and freezing) in one linear pass.

const C = NodeCapacity;	// 64

// Contiguous run [0, n).
const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

// The sizes the ticket calls out: empty, single, just-under / at / just-over a leaf, multi-level, deep.
const SIZES = [0, 1, C - 1, C, C + 1, 1000, 100_000];

// A full ascending traversal, read as an array of entries (aliasing-free entry iterator).
const ascendingEntries = <TKey, TEntry>(tree: BTree<TKey, TEntry>): TEntry[] => [...tree.entries()];

describe('BTree.buildFrom (bulk load from sorted input)', () => {

	describe('builds a valid tree at every size', () => {
		for (const n of SIZES) {
			it(`n=${n}: invariants hold, count is exact, traversal reproduces input order`, () => {
				const input = seq(n);
				const tree = BTree.buildFrom<number, number>(input);

				assertTreeInvariants(tree);
				expect(tree.size, 'size getter').to.equal(n);
				expect(tree.getCount(), 'no-arg getCount()').to.equal(n);
				// A full ascending traversal count also equals n and reproduces the exact input order.
				const walked = ascendingEntries(tree);
				expect(walked.length, 'traversal count').to.equal(n);
				expect(walked).to.deep.equal(input);
			});
		}
	});

	describe('redistribution keeps non-root nodes at/above half capacity', () => {
		it('n=65 splits 64,1 into a redistributed 32,33 (no underfull leaf)', () => {
			const tree = BTree.buildFrom<number, number>(seq(C + 1));
			// allowUnderfilledRoot defaults true; the point here is that assertTreeInvariants (rule 2) rejects any
			// NON-root node below HalfCapacity, so a passing check proves the 64,1 pair was rebalanced to 32,33.
			assertTreeInvariants(tree);
			expect(tree.size).to.equal(C + 1);
		});

		it('large n produces 2-3 levels with every non-root node in [32,64]', () => {
			// Validate against the strict fill floor at the root too (allowUnderfilledRoot false would reject a
			// thin root, but a root branch here has many children); the non-root floor is what rule 2 enforces.
			const tree = BTree.buildFrom<number, number>(seq(100_000));
			assertTreeInvariants(tree);
			expect(tree.size).to.equal(100_000);
		});
	});

	describe('result is indistinguishable from an inserted tree', () => {
		it('buildFrom and insert answer find / get / range identically', () => {
			const n = 5000;
			const input = seq(n);

			const built = BTree.buildFrom<number, number>(input);
			const inserted = new BTree<number, number>();
			for (const k of input) inserted.insert(k);

			// find + get on present, absent, and boundary keys.
			for (const k of [-1, 0, 1, 42, 2500, n - 1, n, n + 1]) {
				expect(built.find(k).on, `find(${k}).on`).to.equal(inserted.find(k).on);
				expect(built.get(k), `get(${k})`).to.equal(inserted.get(k));
			}

			// range: ascending inclusive window, descending window, and an exclusive-bound window.
			const ranges: KeyRange<number>[] = [
				new KeyRange(new KeyBound(100), new KeyBound(200)),
				new KeyRange(new KeyBound(4000), new KeyBound(3000), false),
				new KeyRange(new KeyBound(100, false), new KeyBound(200, false)),
				new KeyRange(undefined, new KeyBound(50)),
				new KeyRange(new KeyBound(n - 10), undefined),
			];
			for (const r of ranges) {
				expect([...built.keys(r)], `range keys ${JSON.stringify(r)}`).to.deep.equal([...inserted.keys(r)]);
			}
		});
	});

	describe('validation rejects bad input', () => {
		it('throws UnsortedInputError on an out-of-order pair (compare > 0)', () => {
			expect(() => BTree.buildFrom<number, number>([1, 2, 5, 4, 6])).to.throw(UnsortedInputError);
		});

		it('throws UnsortedInputError on a duplicate (compare === 0)', () => {
			expect(() => BTree.buildFrom<number, number>([1, 2, 2, 3])).to.throw(UnsortedInputError);
		});

		it('the error names which failure (out-of-order vs duplicate)', () => {
			expect(() => BTree.buildFrom<number, number>([1, 3, 2])).to.throw(UnsortedInputError, /out-of-order/);
			expect(() => BTree.buildFrom<number, number>([1, 2, 2])).to.throw(UnsortedInputError, /duplicate/);
		});

		it('rejects disorder that only appears deep in a large, otherwise-sorted input', () => {
			const input = seq(1000);
			[input[500], input[501]] = [input[501], input[500]];	// swap one adjacent pair mid-stream
			expect(() => BTree.buildFrom<number, number>(input)).to.throw(UnsortedInputError);
		});
	});

	describe('freeze option is honored', () => {
		interface Entry { id: number; value: string }
		const rows = (n: number): Entry[] => Array.from({ length: n }, (_, i) => ({ id: i, value: `v${i}` }));

		it('default load freezes stored entries', () => {
			const tree = BTree.buildFrom<number, Entry>(rows(100), e => e.id);
			expect(Object.isFrozen(tree.get(42)), 'default freezes').to.be.true;
		});

		it('{ freeze: false } leaves stored entries mutable', () => {
			const tree = BTree.buildFrom<number, Entry>(rows(100), e => e.id, undefined, { freeze: false });
			const entry = tree.get(42)!;
			expect(Object.isFrozen(entry), 'freeze:false leaves entries unfrozen').to.be.false;
			entry.value = 'MUTATED';	// non-key mutation is allowed and sticks when unfrozen
			expect(tree.get(42)!.value).to.equal('MUTATED');
		});
	});

	describe('accepts any iterable, not just arrays', () => {
		it('builds from a generator', () => {
			function* gen(n: number): Generator<number> {
				for (let i = 0; i < n; i++) yield i;
			}
			const tree = BTree.buildFrom<number, number>(gen(C + 1));
			assertTreeInvariants(tree);
			expect([...tree.entries()]).to.deep.equal(seq(C + 1));
		});

		it('builds from a Set (insertion-ordered, sorted here)', () => {
			const tree = BTree.buildFrom<number, number>(new Set(seq(200)));
			assertTreeInvariants(tree);
			expect(tree.size).to.equal(200);
		});
	});

	describe('custom comparator and key extractor', () => {
		it('builds with a string comparator over input sorted by that comparator', () => {
			const words = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape'];
			const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
			const tree = BTree.buildFrom<string, string>(words, undefined, compare);
			assertTreeInvariants(tree);
			expect([...tree.keys()]).to.deep.equal(words);
			expect(tree.get('date')).to.equal('date');
			expect(tree.get('missing')).to.be.undefined;
		});

		it('builds with a compound-key extractor, input sorted by that key', () => {
			interface Row { major: number; minor: number; label: string }
			// Key = major * 1000 + minor; input generated already ascending by that key.
			const key = (r: Row) => r.major * 1000 + r.minor;
			const input: Row[] = [];
			for (let major = 0; major < 5; major++) {
				for (let minor = 0; minor < 50; minor++) {
					input.push({ major, minor, label: `${major}.${minor}` });
				}
			}
			const tree = BTree.buildFrom<number, Row>(input, key);
			assertTreeInvariants(tree);
			expect(tree.size).to.equal(input.length);
			expect(tree.get(3 * 1000 + 7)!.label).to.equal('3.7');
			expect([...tree.entries()]).to.deep.equal(input);
		});
	});

	describe('freshness', () => {
		it('the returned tree is at version 0: paths from it stay valid until the first mutation', () => {
			const tree = BTree.buildFrom<number, number>(seq(500));
			const path = tree.find(250);
			expect(path.on).to.be.true;
			expect(tree.at(path)).to.equal(250);	// still valid - no mutation yet
			tree.insert(1000);	// first mutation bumps the version
			expect(() => tree.at(path)).to.throw();	// path now stale
		});

		it('an empty bulk load yields a usable empty tree', () => {
			const tree = BTree.buildFrom<number, number>([]);
			assertTreeInvariants(tree);
			expect(tree.size).to.equal(0);
			expect(tree.get(1)).to.be.undefined;
			tree.insert(1);	// still usable
			expect(tree.size).to.equal(1);
			expect(tree.get(1)).to.equal(1);
		});
	});
});
