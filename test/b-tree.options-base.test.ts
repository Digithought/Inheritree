import { expect } from 'chai';
import { BTree } from '../src/index.js';
import { assertTreeInvariants } from './helpers/invariants.js';

// Coverage for the copy-on-write base moving into the options object (the 1.0 change):
//   new BTree(keyFromEntry, compare, { base })  — replaces the pre-1.0 positional third argument.
// Exercises: base-via-options round-trips COW inheritance; base coexists with the freeze / checkComparator
// tunings in one options object; generic inference flows from options.base; buildFrom ignores a stray base;
// and the deprecated positional form is still forwarded at runtime (for untyped JS callers) with a warning.

interface Entry { id: number; value: string }
const keyOf = (e: Entry) => e.id;
const cmp = (a: number, b: number) => a - b;

describe('BTreeOptions.base (copy-on-write via options)', () => {

	describe('base via options.base', () => {
		it('derives a copy-on-write child that shares the base and leaves it untouched', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			base.insert({ id: 10, value: 'a' });
			base.insert({ id: 20, value: 'b' });

			const child = new BTree<number, Entry>(keyOf, cmp, { base });
			expect(child.getCount(), 'child seeds its O(1) count from the base').to.equal(2);
			expect(child.get(10)!.value, 'child reads an unmodified entry through to the base').to.equal('a');

			child.insert({ id: 15, value: 'c' });
			child.deleteAt(child.find(10));

			expect([...child.keys()], "child reflects its own writes").to.deep.equal([15, 20]);
			expect([...base.keys()], 'base is untouched by the child writes').to.deep.equal([10, 20]);
			assertTreeInvariants(child);
			assertTreeInvariants(base);
		});

		it('a chain of children derived via { base } resolves through every level', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			base.insert({ id: 1, value: 'base' });
			const c1 = new BTree<number, Entry>(keyOf, cmp, { base });
			c1.insert({ id: 2, value: 'c1' });
			const c2 = new BTree<number, Entry>(keyOf, cmp, { base: c1 });
			c2.insert({ id: 3, value: 'c2' });

			expect([...c2.keys()], 'c2 sees base + c1 + its own entries').to.deep.equal([1, 2, 3]);
			expect([...base.keys()], 'base still standalone').to.deep.equal([1]);
			assertTreeInvariants(c2);
		});
	});

	describe('base + tuning options together (round-trip every field)', () => {
		it('applies base AND freeze:false AND checkComparator from one options object', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			base.insert({ id: 1, value: 'x' });

			const child = new BTree<number, Entry>(keyOf, cmp, { base, freeze: false, checkComparator: true });
			expect(child.get(1)!.value, 'base applied').to.equal('x');

			child.insert({ id: 2, value: 'y' });
			expect(Object.isFrozen(child.get(2)), 'freeze:false honored -> stored entry not frozen').to.be.false;
			// checkComparator:true is exercised implicitly: a consistent comparator never throws.
			assertTreeInvariants(child);
		});

		it('defaults freeze to true (and no base) when only tuning-free base is supplied', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			const child = new BTree<number, Entry>(keyOf, cmp, { base });
			child.insert({ id: 3, value: 'z' });
			expect(Object.isFrozen(child.get(3)), 'freeze defaults to true').to.be.true;
		});

		it('base absent, options present still works (the plain tuning-only form)', () => {
			const tree = new BTree<number, Entry>(keyOf, cmp, { freeze: false });
			tree.insert({ id: 1, value: 'a' });
			expect(Object.isFrozen(tree.get(1)), 'no base; freeze:false honored').to.be.false;
		});

		it('nothing supplied builds a standalone empty tree with safe defaults', () => {
			const tree = new BTree<number, Entry>(keyOf, cmp);
			tree.insert({ id: 1, value: 'a' });
			expect(Object.isFrozen(tree.get(1)), 'freeze defaults to true').to.be.true;
			expect(tree.getCount()).to.equal(1);
		});
	});

	describe('generic inference from options.base', () => {
		it('infers TKey/TEntry from keyFromEntry + options.base with no explicit type arguments', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			base.insert({ id: 5, value: 'v' });

			// No explicit <number, Entry>: the generics must infer from keyFromEntry and options.base.
			const child = new BTree(keyOf, cmp, { base });
			const got = child.get(5);				// inferred Entry | undefined
			expect(got!.value).to.equal('v');
			child.insert({ id: 6, value: 'w' });	// { id, value } must type-check against the inferred Entry
			expect([...child.keys()]).to.deep.equal([5, 6]);
		});
	});

	describe('buildFrom ignores options.base (always standalone)', () => {
		it('a base passed to buildFrom does not derive; the result is standalone and unguarded', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			base.insert({ id: 100, value: 'base' });

			const built = BTree.buildFrom<number, Entry>(
				[{ id: 1, value: 'a' }, { id: 2, value: 'b' }],
				keyOf, cmp,
				{ base, freeze: false },
			);
			expect([...built.keys()], 'built tree ignores the base, holding only its sorted input').to.deep.equal([1, 2]);

			built.insert({ id: 3, value: 'c' });
			expect(Object.isFrozen(built.get(3)), 'buildFrom still honors freeze:false').to.be.false;

			// A standalone tree has no base guard, so mutating the passed-in tree must not trip it.
			base.insert({ id: 200, value: 'more' });
			expect(() => built.get(1), 'built tree has no base guard').to.not.throw();
			assertTreeInvariants(built);
		});
	});

	describe('deprecated positional base (untyped-JS runtime fallback)', () => {
		it('still forwards a positionally-passed base at runtime, and warns exactly once', () => {
			const base = new BTree<number, Entry>(keyOf, cmp);
			base.insert({ id: 42, value: 'q' });

			const warnings: string[] = [];
			const originalWarn = console.warn;
			console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
			try {
				// `as any` reproduces the pre-1.0 positional call as it arrives from untyped JavaScript
				// (in TypeScript the positional base is now a compile error).
				const child1 = new BTree<number, Entry>(keyOf, cmp, base as any);
				const child2 = new BTree<number, Entry>(keyOf, cmp, base as any);
				expect(child1.get(42)!.value, 'positional base forwarded (child1 derives from base)').to.equal('q');
				expect(child2.get(42)!.value, 'positional base forwarded (child2 derives from base)').to.equal('q');
				expect(child1.getCount(), 'child1 seeds its count from the base').to.equal(1);
			} finally {
				console.warn = originalWarn;
			}

			// This is the ONLY positional-base construction in the whole suite, so the module-level warn-once
			// flag is still unset when this test runs -> exactly one warning is observed for the two calls.
			// If this ever reads 0, another test introduced a positional-base call ahead of it (migrate that
			// call to `{ base }`); if it reads 2, the warn-once guard regressed.
			expect(warnings.length, 'the deprecation warning fires exactly once per process').to.equal(1);
			expect(warnings[0], 'the warning flags the deprecation').to.match(/deprecated/i);
			expect(warnings[0], 'the warning names the base and the { base } fix').to.match(/base/);
		});
	});
});
