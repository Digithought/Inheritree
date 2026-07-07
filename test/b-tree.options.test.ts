import { expect } from 'chai';
import { BTree, InconsistentComparatorError, NodeCapacity } from '../src/index.js';
import { assertTreeInvariants } from './helpers/invariants.js';

// Contiguous run [start, start + count).
const seq = (start: number, count: number): number[] => Array.from({ length: count }, (_, i) => start + i);

// Coverage for the optional per-tree safety-cost flags added by the BTreeOptions ticket:
//   * freeze          — Object.freeze on stored entries (default true).
//   * checkComparator — full per-comparison antisymmetry probe (default false: bounded sample instead).
// Both stay safe-by-default; these tests lock the defaults, the opt-outs, and the perf goal (no
// per-comparison doubling once the default sample window is spent).

interface Entry { id: number; value: string }

const C = NodeCapacity;	// 64

describe('BTreeOptions', () => {

	describe('freeze (default true)', () => {
		it('a default tree freezes entries stored by insert / updateAt / upsert / merge', () => {
			const dict = new BTree<number, Entry>(e => e.id);

			dict.insert({ id: 1, value: 'a' });
			expect(Object.isFrozen(dict.get(1)), 'insert freezes the stored entry').to.be.true;

			dict.updateAt(dict.find(1), { id: 1, value: 'A' });
			expect(Object.isFrozen(dict.get(1)), 'updateAt freezes the stored entry').to.be.true;

			dict.upsert({ id: 2, value: 'b' });
			expect(Object.isFrozen(dict.get(2)), 'upsert freezes the stored entry').to.be.true;

			dict.merge({ id: 3, value: 'c' }, e => e);	// insert branch (key absent)
			expect(Object.isFrozen(dict.get(3)), 'merge insert-branch freezes the stored entry').to.be.true;

			dict.merge({ id: 3, value: 'IGNORED' }, e => ({ id: e.id, value: 'C' }));	// update branch
			expect(Object.isFrozen(dict.get(3)), 'merge update-branch (via updateAt) freezes the stored entry').to.be.true;
			expect(dict.get(3)!.value).to.equal('C');
		});
	});

	describe('freeze: false', () => {
		it('leaves entries stored by insert / updateAt / upsert / merge unfrozen', () => {
			const dict = new BTree<number, Entry>(e => e.id, undefined, { freeze: false });

			dict.insert({ id: 1, value: 'a' });
			expect(Object.isFrozen(dict.get(1)), 'insert does not freeze').to.be.false;

			dict.updateAt(dict.find(1), { id: 1, value: 'A' });
			expect(Object.isFrozen(dict.get(1)), 'updateAt does not freeze').to.be.false;

			dict.upsert({ id: 2, value: 'b' });
			expect(Object.isFrozen(dict.get(2)), 'upsert does not freeze').to.be.false;

			dict.merge({ id: 3, value: 'c' }, e => e);
			expect(Object.isFrozen(dict.get(3)), 'merge insert-branch does not freeze').to.be.false;

			dict.merge({ id: 3, value: 'IGNORED' }, e => ({ id: e.id, value: 'C' }));
			expect(Object.isFrozen(dict.get(3)), 'merge update-branch does not freeze').to.be.false;
		});

		it('a multi-level bulk insert of unfrozen entries yields a correct, invariant-holding tree', () => {
			const dict = new BTree<number, Entry>(e => e.id, undefined, { freeze: false });
			const N = C * C + 1;	// > NodeCapacity -> genuinely multi-level (>= 3 levels)
			for (const id of seq(0, N)) dict.insert({ id, value: `v${id}` });

			expect(dict.find(N >> 1).branches.length, 'genuinely multi-level').to.be.greaterThanOrEqual(2);
			assertTreeInvariants(dict);
			expect(dict.getCount()).to.equal(N);
			// Spot-check that stored entries really are mutable (not frozen).
			for (const id of [0, N >> 1, N - 1]) {
				expect(Object.isFrozen(dict.get(id)), `stored entry ${id} is unfrozen`).to.be.false;
			}
			// In-place re-store paths (upsert/merge on an existing key) still produce an ordered, valid tree.
			dict.upsert({ id: N >> 1, value: 'UP' });
			dict.merge({ id: 0, value: 'IGNORED' }, e => ({ id: e.id, value: 'MG' }));
			expect(dict.get(N >> 1)!.value).to.equal('UP');
			expect(dict.get(0)!.value).to.equal('MG');
			assertTreeInvariants(dict);
		});
	});

	describe('checkComparator: true (parity with the historical exhaustive check)', () => {
		it('throws InconsistentComparatorError mid-operation on an inconsistent comparator', () => {
			// () => 1 is antisymmetry-broken: compare(a,b) === compare(b,a) === 1 for a != b.
			const tree = new BTree<number, number>(undefined, () => 1, { checkComparator: true });
			tree.insert(1);	// empty leaf: no comparison yet
			expect(() => tree.insert(2), 'the first real comparison detects the inconsistency').to.throw(InconsistentComparatorError);
		});

		it('still detects an inconsistency deep in a large tree (beyond the sample window)', () => {
			// A comparator that behaves for small keys but breaks for large ones would slip past the default
			// sample; with checkComparator on, every comparison is checked, so it is caught deep in the tree.
			let broken = false;
			const cmp = (a: number, b: number) => {
				if (broken && a >= 1000 && b >= 1000) return 1;	// antisymmetry-broken only for large keys
				return a < b ? -1 : a > b ? 1 : 0;
			};
			const tree = new BTree<number, number>(undefined, cmp, { checkComparator: true });
			for (const k of seq(0, 500)) tree.insert(k);	// well past the 32-comparison sample window
			broken = true;
			expect(() => {
				for (const k of seq(1000, 500)) tree.insert(k);	// large keys now compare against each other
			}, 'checkComparator: true catches the inconsistency deep in the tree').to.throw(InconsistentComparatorError);
		});
	});

	describe('checkComparator default (bounded sample)', () => {
		it('the sample window catches an obviously broken comparator within the first few inserts', () => {
			const tree = new BTree<number, number>(undefined, () => 1);	// default: sample check on
			tree.insert(1);	// empty leaf: no comparison
			expect(() => {
				for (const k of seq(2, 40)) tree.insert(k);	// second insert already compares -> throws
			}).to.throw(InconsistentComparatorError);
		});

		it('does NOT false-positive on valid comparators with unusual magnitudes or many equal probes', () => {
			// Magnitude comparator (a - b): consistent, but returns values other than +/-1. compare(a,b) and
			// compare(b,a) are negatives of each other, so they are never the identical non-zero value.
			const magnitude = new BTree<number, number>(undefined, (a, b) => a - b);
			for (const k of seq(0, C * C + 1)) magnitude.insert(k);	// large, multi-level: exhausts and passes the window
			assertTreeInvariants(magnitude);

			// A comparator with large opposite magnitudes, plus repeated equal-key probes (rejected duplicates
			// re-run the comparison and hit result === 0, which skips the check entirely).
			const wide = new BTree<number, number>(undefined, (a, b) => a < b ? -5 : a > b ? 5 : 0);
			for (const k of seq(0, 200)) wide.insert(k);
			for (const k of seq(0, 200)) expect(wide.insert(k).on, 'duplicate rejected, no throw').to.be.false;
			assertTreeInvariants(wide);
		});
	});

	describe('comparator invocation count (perf goal)', () => {
		// Build two structurally identical ~1000-entry trees whose comparators count invocations. Past the
		// default sample window, a find on the default tree issues ~one compare per logical comparison, while
		// the same find under checkComparator issues ~2x (the antisymmetry re-compare on every non-equal step).
		const N = 1000;
		const target = 500;	// present in both trees

		const build = (opts?: { checkComparator?: boolean }) => {
			let count = 0;
			const cmp = (a: number, b: number) => { ++count; return a < b ? -1 : a > b ? 1 : 0; };
			const tree = new BTree<number, number>(undefined, cmp, opts);
			for (const k of seq(0, N)) tree.insert(k);
			return { tree, reset: () => { count = 0; }, get: () => count };
		};

		it('a default find issues no doubled compares once past the sample window; checkComparator issues ~2x', () => {
			const dflt = build();				// sample window (32) fully spent during the 1000-key build
			const checked = build({ checkComparator: true });

			dflt.reset();
			dflt.tree.find(target);
			const defaultCompares = dflt.get();

			checked.reset();
			checked.tree.find(target);
			const checkedCompares = checked.get();

			expect(defaultCompares, 'the find did some work').to.be.greaterThan(0);
			expect(checkedCompares, 'checkComparator does strictly more work').to.be.greaterThan(defaultCompares);
			// Never more than double (every logical comparison costs at most one extra compare).
			expect(checkedCompares, 'at most 2x the default').to.be.at.most(2 * defaultCompares);
			// Noticeably more (~2x): proves the default is NOT itself paying the double cost.
			expect(checkedCompares, 'noticeably more (~2x)').to.be.at.least(Math.floor(1.5 * defaultCompares));
		});
	});

	describe('backward-compatible construction', () => {
		it('the existing positional forms still compile and behave as before', () => {
			const set = new BTree<number, number>();
			set.insert(2); set.insert(1); set.insert(3);
			const out: number[] = [];
			for (const p of set.ascending(set.first())) out.push(set.at(p)!);
			expect(out).to.deep.equal([1, 2, 3]);

			const withKey = new BTree<number, Entry>(e => e.id);
			withKey.insert({ id: 5, value: 'x' });
			expect(withKey.get(5)!.value).to.equal('x');

			const withCmp = new BTree<number, number>(undefined, (a, b) => a - b);
			withCmp.insert(1); withCmp.insert(2);
			expect(withCmp.get(2)).to.equal(2);
		});
	});
});
