import { expect } from 'chai';
import { BTree, MutatedBaseError, NodeCapacity } from '../src/b-tree.js';
import { assertTreeInvariants } from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

/**
 * The base-immutability guard (`MutatedBaseError`). A derived tree snapshots its base chain's version at
 * construction; if the base is mutated while the child is still live (a base-immutability violation), the
 * child's NEXT operation throws instead of silently returning a corrupted view. This is *detect-on-next-use*:
 * the base mutation itself succeeds silently (a base has no back-reference to its children), and the error
 * surfaces on the child's following op — through the root getter (find/get/insert/...), through validatePath
 * (path ops), through the O(1) count reads (`size`, no-arg `getCount()`), or at `clearBase()`.
 *
 * A DETACHED child (post-`clearBase`, `base === undefined`) has no base version left to compare, so the guard
 * is a permanent no-op from that point on — those hazards stay pinned in test/b-tree.cow-clearbase.test.ts.
 *
 * Scale note: bases here are built well above NodeCapacity (64) so a child genuinely shares nodes with a
 * multi-level base — the exact structure the guard protects. Helpers mirror test/b-tree.cow-clearbase.test.ts.
 */
describe('BTree base-immutability guard (MutatedBaseError)', () => {
	interface Entry {
		id: number;
		value: string;
		tag: string;
	}

	const keyOf = (e: Entry): number => e.id;
	const cmp = (a: number, b: number): number => a - b;

	/** A genuinely multi-level base with ids `stride, 2*stride, ..., count*stride`, leaving interior gaps
	 * between consecutive base keys for fresh inserts (mirrors cow-clearbase's makeBase). */
	function makeBase(count: number, stride: number): BTree<number, Entry> {
		expect(count, 'count must exceed NodeCapacity to force a multi-level tree').to.be.greaterThan(NodeCapacity);
		const base = new BTree<number, Entry>(keyOf, cmp);
		for (let i = 1; i <= count; i++) {
			const id = i * stride;
			expect(base.insert({ id, value: `base_${id}`, tag: 'base' }).on, `base insert ${id}`).to.equal(true);
		}
		assertTreeInvariants(base);
		return base;
	}

	/** Delete-biased op stream against a child + shadow Map (mirrors cow-clearbase's driveOps). Used only to
	 * prove the guard produces NO false positive while the child mutates itself and the base stays untouched. */
	function driveOps(
		child: BTree<number, Entry>,
		shadow: Map<number, Entry>,
		rng: () => number,
		count: number,
		floor: number,
		maxKey: number,
		tagPrefix: string,
	): void {
		let uid = 0;
		for (let i = 0; i < count; i++) {
			let roll = lcgInt(rng, 0, 100);
			if (shadow.size <= floor) roll = 99; // force INSERT to stay multi-level

			if (roll < 55 && shadow.size >= 2) {
				const sortedKeys = Array.from(shadow.keys()).sort(cmp);
				const id = sortedKeys[lcgInt(rng, 1, sortedKeys.length)]; // index >= 1 => non-front-anchored
				expect(child.deleteAt(child.find(id)), `${tagPrefix} delete ${id} @op${i}`).to.equal(true);
				shadow.delete(id);
			} else if (roll < 70 && shadow.size > 0) {
				const keys = Array.from(shadow.keys());
				const id = keys[lcgInt(rng, 0, keys.length)];
				const e: Entry = { id, value: `${tagPrefix}_upd_${id}_op${i}`, tag: tagPrefix };
				child.updateAt(child.find(id), e);
				shadow.set(id, e);
			} else {
				const id = lcgInt(rng, 1, maxKey) + (++uid) / 1_000_000; // fresh interior key
				const e: Entry = { id, value: `${tagPrefix}_ins_${id}_op${i}`, tag: tagPrefix };
				expect(child.insert(e).on, `${tagPrefix} insert ${id} @op${i}`).to.equal(true);
				shadow.set(id, e);
			}
		}
	}

	const BASE_COUNT = 400;
	const BASE_STRIDE = 10;
	const MAX_KEY = BASE_COUNT * BASE_STRIDE; // 4000
	const FLOOR = NodeCapacity * 3;
	const UNTOUCHED = 50; // a base key in a leaf the child never rewrites (i=5, stride 10)

	// =================================================================================================
	// Deferred detection: the base op succeeds silently; the child throws on its NEXT op.
	// =================================================================================================
	describe('deferred detection (detect-on-next-use)', () => {
		it('the base mutation returns normally; the very next child op throws', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			child.insert({ id: 2005, value: 'c_2005', tag: 'c' }); // local write: child shares-but-owns a spine

			// Half 1 — the defining "silent" half: mutating the base must NOT throw at the mutation site.
			expect(() => base.deleteAt(base.find(UNTOUCHED)), 'base op succeeds silently').to.not.throw();

			// Half 2 — the child's next op notices the base moved and throws.
			expect(() => child.get(UNTOUCHED), "child's next op throws").to.throw(MutatedBaseError);
		});

		it('every root-getter / count-read / clearBase entry point throws after a base mutation', () => {
			// Each sub-case rebuilds a fresh live child, then violates the contract, then hits one entry point.
			const points: Array<[string, (c: BTree<number, Entry>) => unknown]> = [
				['find', c => c.find(UNTOUCHED)],
				['get', c => c.get(UNTOUCHED)],
				['first', c => c.first()],
				['last', c => c.last()],
				['insert', c => c.insert({ id: 7777, value: 'x', tag: 'c' })],
				['upsert', c => c.upsert({ id: 7777, value: 'x', tag: 'c' })],
				['merge', c => c.merge({ id: 7777, value: 'x', tag: 'c' }, e => e)],
				['size', c => c.size],
				['getCount()', c => c.getCount()],
				['entries', c => [...c.entries()]],
				['clearBase', c => c.clearBase()],
			];
			for (const [name, op] of points) {
				const base = makeBase(BASE_COUNT, BASE_STRIDE);
				const child = new BTree<number, Entry>(keyOf, cmp, base);
				child.insert({ id: 2005, value: 'c_2005', tag: 'c' });
				base.deleteAt(base.find(UNTOUCHED)); // violate
				expect(() => op(child), `${name} must throw MutatedBaseError after a base mutation`).to.throw(MutatedBaseError);
			}
		});

		it('path-based ops (validatePath) throw after a base mutation', () => {
			// A path taken BEFORE the violation is still version-valid, but validatePath calls checkBase first,
			// so the base mutation surfaces as MutatedBaseError (not InvalidPathError).
			const mk = () => {
				const base = makeBase(BASE_COUNT, BASE_STRIDE);
				const child = new BTree<number, Entry>(keyOf, cmp, base);
				child.insert({ id: 2005, value: 'c_2005', tag: 'c' });
				const path = child.find(60); // valid path, taken before the violation
				expect(path.on, 'precondition: path is on key 60').to.equal(true);
				base.deleteAt(base.find(UNTOUCHED)); // violate
				return { child, path };
			};
			{ const { child, path } = mk(); expect(() => child.at(path), 'at').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => child.moveNext(path), 'moveNext').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => child.movePrior(path), 'movePrior').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => child.updateAt(path, { id: 60, value: 'u', tag: 'c' }), 'updateAt').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => child.deleteAt(path), 'deleteAt').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => child.getCount({ path }), 'getCount(from)').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => [...child.ascending(path)], 'ascending').to.throw(MutatedBaseError); }
			{ const { child, path } = mk(); expect(() => [...child.descending(path)], 'descending').to.throw(MutatedBaseError); }
		});
	});

	// =================================================================================================
	// Multi-level chains: a mutation ANYWHERE up the base chain trips the deepest descendant.
	// =================================================================================================
	describe('multi-level chain detection', () => {
		it('a mutation to the ROOT base (base -> c1 -> c2) trips c2', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			c1.insert({ id: 2005, value: 'c1_2005', tag: 'c1' });
			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
			c2.insert({ id: 3005, value: 'c2_3005', tag: 'c2' });

			// Mutate two levels up (base) while c2 is live.
			base.deleteAt(base.find(UNTOUCHED));

			expect(() => c2.get(UNTOUCHED), 'a base mutation two levels up trips c2').to.throw(MutatedBaseError);
		});

		it('a mutation to the INTERMEDIATE base c1 (base -> c1 -> c2) trips c2', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);
			c2.insert({ id: 3005, value: 'c2_3005', tag: 'c2' });

			// Mutate c1 (c2's immediate base) while c2 is live. c1's own op succeeds (its base is untouched).
			expect(() => c1.insert({ id: 2005, value: 'c1_2005', tag: 'c1' }), 'c1 self-mutation is fine').to.not.throw();

			expect(() => c2.get(3005), "a mutation to c2's immediate base trips c2").to.throw(MutatedBaseError);
		});

		it('mutating c1 does not trip c1 itself, only its descendants', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const c1 = new BTree<number, Entry>(keyOf, cmp, base);
			const c2 = new BTree<number, Entry>(keyOf, cmp, c1);

			c1.insert({ id: 2005, value: 'c1_2005', tag: 'c1' });

			expect(() => c1.get(2005), 'c1 reading its own write is fine (its base untouched)').to.not.throw();
			expect(() => c2.get(UNTOUCHED), 'but c2 (derived from c1) trips').to.throw(MutatedBaseError);
		});
	});

	// =================================================================================================
	// Seeded-_count skew: the O(1) count reads bypass root/validatePath, so they need their OWN guard.
	// This group is the regression anchor for that easy-to-miss pair — without the count-read guards
	// these would PASS by silently returning a stale (wrong) count instead of throwing.
	// =================================================================================================
	describe('seeded _count skew via the O(1) count reads', () => {
		it('child.size throws after the base was mutated (size reads _count directly)', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			expect(child.size, 'child seeds its count from the base').to.equal(BASE_COUNT);

			base.deleteAt(base.find(UNTOUCHED)); // base shrinks; the child's seeded _count is now stale

			expect(() => child.size, 'size trips the guard instead of returning the stale count').to.throw(MutatedBaseError);
		});

		it('no-arg child.getCount() throws after the base was mutated', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			expect(child.getCount(), 'child seeds its count from the base').to.equal(BASE_COUNT);

			base.insert({ id: 55, value: 'base_new', tag: 'base' }); // base grows; seeded _count stale the other way

			expect(() => child.getCount(), 'no-arg getCount trips the guard').to.throw(MutatedBaseError);
		});
	});

	// =================================================================================================
	// clearBase laundering: refuse to detach off an already-mutated base.
	// =================================================================================================
	describe('clearBase laundering', () => {
		it('clearBase throws if the base was already mutated (refuses to launder corruption into a standalone tree)', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			child.insert({ id: 2005, value: 'c_2005', tag: 'c' });

			base.deleteAt(base.find(UNTOUCHED)); // violate before detaching

			expect(() => child.clearBase(), 'clearBase refuses to detach off a mutated base').to.throw(MutatedBaseError);
			expect((child as any)['base'], 'base pointer is left intact when clearBase throws').to.not.equal(undefined);
		});

		it('clearBase succeeds on an untouched base, and the detached child no longer guards', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			child.insert({ id: 2005, value: 'c_2005', tag: 'c' });

			expect(() => child.clearBase(), 'clearBase on an untouched base is fine').to.not.throw();

			// Detached: base === undefined, so the guard is a permanent no-op even if the former base moves.
			base.deleteAt(base.find(UNTOUCHED));
			expect(() => child.get(2005), 'a detached child does not guard against former-base mutation').to.not.throw();
			expect(() => child.size, 'nor do its count reads').to.not.throw();
		});
	});

	// =================================================================================================
	// No false positives: self-mutation and an untouched base must never trip the guard.
	// =================================================================================================
	describe('no false positives', () => {
		it('a child driven through a heavy op stream never throws while its base stays untouched', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);
			const shadow = new Map<number, Entry>();
			const seed = base.first(); while (seed.on) { const e = base.at(seed)!; shadow.set(e.id, { ...e }); base.moveNext(seed); }

			expect(() => driveOps(child, shadow, lcg(0xC0FFEE), 500, FLOOR, MAX_KEY, 'c'),
				'child self-mutation never trips its own base guard').to.not.throw();
			assertTreeInvariants(child);
			expect(child.size, 'size stays readable and correct through the op stream').to.equal(shadow.size);
			expect(child.getCount(), 'no-arg getCount agrees').to.equal(shadow.size);
		});

		it('a child mutating ITSELF never trips its own guard (self-version bumps are excluded from the check)', () => {
			const base = makeBase(BASE_COUNT, BASE_STRIDE);
			const child = new BTree<number, Entry>(keyOf, cmp, base);

			for (let i = 0; i < 50; i++) {
				expect(child.insert({ id: 2000 + i + 0.5, value: `c_${i}`, tag: 'c' }).on, `self insert ${i}`).to.equal(true);
			}

			expect(() => child.getCount(), 'child self-writes do not trip the base guard').to.not.throw();
			expect(() => child.size).to.not.throw();
			expect(() => child.get(2000), 'reads on a self-mutated child are fine').to.not.throw();
		});

		it('a standalone (base-less) tree never trips the guard', () => {
			const tree = makeBase(BASE_COUNT, BASE_STRIDE); // no base
			expect(() => tree.deleteAt(tree.find(UNTOUCHED)), 'standalone mutation is fine').to.not.throw();
			expect(() => tree.size, 'standalone size is fine').to.not.throw();
			expect(() => tree.getCount(), 'standalone getCount is fine').to.not.throw();
			expect(() => tree.clearBase(), 'clearBase on a base-less tree is a harmless no-op').to.not.throw();
		});
	});
});
