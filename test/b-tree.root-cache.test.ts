import { expect } from 'chai';
import { BTree, MutatedBaseError, NodeCapacity } from '../src/b-tree.js';
import { assertTreeInvariants } from './helpers/invariants.js';

/**
 * Root-getter caching (code review finding F11). A derived tree resolves its effective root by walking its
 * `base` chain; under the base-immutability contract (a base's effective root cannot legitimately change
 * once a child has derived from it) that resolved value is cached on first read, so a deep chain of derived
 * trees collapses to O(1) re-reads instead of re-walking the whole chain on every `root` access.
 *
 * The base-immutability guard ({@link MutatedBaseError}) must keep firing on the cached path too
 * (cache-THEN-check, not cache-instead-of-check): {@link BTree.root}'s `checkBase()` call runs unconditionally
 * before the cache is even consulted, so a mutation is still detected rather than served a stale cached root.
 */
describe('BTree root-getter cache (F11)', () => {
	interface Entry {
		id: number;
		value: string;
	}

	const keyOf = (e: Entry): number => e.id;
	const cmp = (a: number, b: number): number => a - b;

	/** Wraps a live tree's `root` getter with a call counter, without touching the class prototype (so other
	 * trees / concurrent tests are unaffected). Works whether the read reaches the getter from outside the
	 * instance (`tree.root`) or from a child's `this.base.root` - both are plain property reads on this exact
	 * object, so both route through the same instance-level override. */
	function countRootReads(tree: BTree<number, Entry>): () => number {
		const descriptor = Object.getOwnPropertyDescriptor(BTree.prototype, 'root')!;
		let count = 0;
		Object.defineProperty(tree, 'root', {
			configurable: true,
			get() {
				count++;
				return descriptor.get!.call(tree);
			},
		});
		return () => count;
	}

	function makeBase(count: number, stride: number): BTree<number, Entry> {
		expect(count, 'count must exceed NodeCapacity to force a multi-level tree').to.be.greaterThan(NodeCapacity);
		const base = new BTree<number, Entry>(keyOf, cmp);
		for (let i = 1; i <= count; i++) {
			const id = i * stride;
			expect(base.insert({ id, value: `base_${id}` }).on, `base insert ${id}`).to.equal(true);
		}
		assertTreeInvariants(base);
		return base;
	}

	const BASE_COUNT = 200;
	const BASE_STRIDE = 10;

	it('a deep chain collapses to O(1) root resolution after the first read: ancestor getters stop being re-invoked', () => {
		const base = makeBase(BASE_COUNT, BASE_STRIDE);
		const c1 = new BTree<number, Entry>(keyOf, cmp, base);
		const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
		const c3 = new BTree<number, Entry>(keyOf, cmp, c2);
		const c4 = new BTree<number, Entry>(keyOf, cmp, c3); // 5-level chain: base -> c1 -> c2 -> c3 -> c4

		const baseCount = countRootReads(base);
		const c1Count = countRootReads(c1);
		const c2Count = countRootReads(c2);
		const c3Count = countRootReads(c3);

		// Warm-up: the first read walks the whole chain, populating each level's cache.
		c4.find(BASE_STRIDE);
		expect(baseCount(), 'base.root read once to warm the chain').to.equal(1);
		expect(c1Count(), 'c1.root read once to warm the chain').to.equal(1);
		expect(c2Count(), 'c2.root read once to warm the chain').to.equal(1);
		expect(c3Count(), 'c3.root read once to warm the chain').to.equal(1);

		// Many further reads through c4 must NOT re-invoke any ancestor's root getter - each ancestor already
		// cached its own resolved root, so re-walking never happens again.
		for (let i = 0; i < 25; i++) {
			c4.find(BASE_STRIDE);
			c4.first();
			c4.last();
		}
		expect(baseCount(), 'base.root stays warmed at 1 despite many further c4 reads').to.equal(1);
		expect(c1Count(), 'c1.root stays warmed at 1 despite many further c4 reads').to.equal(1);
		expect(c2Count(), 'c2.root stays warmed at 1 despite many further c4 reads').to.equal(1);
		expect(c3Count(), 'c3.root stays warmed at 1 despite many further c4 reads').to.equal(1);
	});

	it('clearBase() invalidates the cache: a locally-written child ignores a stale cached base root and clearBase clears it', () => {
		const base = makeBase(BASE_COUNT, BASE_STRIDE);
		const child = new BTree<number, Entry>(keyOf, cmp, base);

		void child.root; // warm the base-root cache while still unwritten
		expect((child as any)['_baseRoot'], 'base-root cache is populated before any local write').to.not.equal(undefined);

		child.insert({ id: 2005, value: 'c_2005' }); // gives the child its own local root, shadowing (but not clearing) the cache

		child.clearBase();

		expect((child as any)['_baseRoot'], 'clearBase clears the base-root cache').to.equal(undefined);
		expect((child as any)['base'], 'clearBase drops the base pointer').to.equal(undefined);
		expect(child.get(2005), 'detached child still resolves its own (locally-rooted) entries correctly').to.deep.equal({ id: 2005, value: 'c_2005' });
		expect(child.get(BASE_STRIDE), 'detached child still resolves inherited entries correctly').to.deep.equal({ id: BASE_STRIDE, value: `base_${BASE_STRIDE}` });
		assertTreeInvariants(child);
	});

	it('an unwritten child: clearBase after warming the cache still pins the exact former base root', () => {
		const base = makeBase(BASE_COUNT, BASE_STRIDE);
		const child = new BTree<number, Entry>(keyOf, cmp, base); // never locally written

		void child.root; // warm the base-root cache
		expect((child as any)['_baseRoot'], 'base-root cache is populated').to.equal(base.root);

		child.clearBase();

		expect(child.root, 'child root is pinned to the former base root').to.equal(base.root);
		assertTreeInvariants(child);
	});

	it('a plain (no-base) tree never touches _baseRoot', () => {
		const tree = new BTree<number, Entry>(keyOf, cmp);
		tree.insert({ id: 1, value: 'a' });
		tree.find(1);
		tree.first();
		tree.last();
		expect((tree as any)['_baseRoot'], 'a base-less tree never populates _baseRoot').to.equal(undefined);
	});

	it('cache-then-check: a cached root does not mask base mutation - MutatedBaseError still fires on the cached path', () => {
		const base = makeBase(BASE_COUNT, BASE_STRIDE);
		const child = new BTree<number, Entry>(keyOf, cmp, base);
		child.insert({ id: 2005, value: 'c_2005' });

		// Warm the cache with several legitimate reads before the base is mutated.
		for (let i = 0; i < 5; i++) child.find(BASE_STRIDE);
		expect((child as any)['_baseRoot'], 'base-root cache is warmed').to.not.equal(undefined);

		base.deleteAt(base.find(BASE_STRIDE)); // violate the base-immutability contract while child is live

		expect(() => child.root, 'root getter still throws through the cache-then-check path').to.throw(MutatedBaseError);
		expect(() => child.find(BASE_STRIDE), 'find still throws through the cache-then-check path').to.throw(MutatedBaseError);
	});
});
