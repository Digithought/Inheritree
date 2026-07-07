import { Bench } from 'tinybench';
import { BTree, KeyRange, KeyBound } from '../src/index.js';
import { lcg, shuffle } from '../test/helpers/rng.js';

// `process` is a Node global but @types/node is not a dependency of this package (mirrors test/b-tree.oracle.test.ts).
declare const process: { env: Record<string, string | undefined> };

// Entry count per scenario. Override with `BENCH_N=100000 yarn bench` to push the size up; the default
// keeps the whole suite (five scenarios x number/string keys, plus the optional buildFrom/no-freeze variants)
// to a handful of seconds.
const N = process.env.BENCH_N === undefined ? 10_000 : Number(process.env.BENCH_N);
// Guard a garbled override loudly: `Number('10_000')` (JS separators don't parse from a string) and any
// non-digit are NaN, and NaN/0/negatives would otherwise make `Array.from({ length: N })` silently empty -
// a benchmark that prints an all-zero table and looks like it ran. Fail fast with a usable message instead.
if (!Number.isInteger(N) || N < 1) {
	throw new Error(`BENCH_N must be a positive integer (got ${JSON.stringify(process.env.BENCH_N)}); use plain digits, e.g. BENCH_N=100000.`);
}

type Key = number | string;
type Kind = 'number' | 'string';
const KINDS: Kind[] = ['number', 'string'];

// Zero-padded so lexical order matches numeric order (a stable, well-defined ascending sequence for strings).
// Sized off `count` (not N) so a pool spanning [N, 2N) still pads consistently with the base [0, N) pool.
function makeKeys(kind: Kind, count: number): Key[] {
	if (kind === 'number') return Array.from({ length: count }, (_, i) => i);
	const width = String(count - 1).length;
	return Array.from({ length: count }, (_, i) => String(i).padStart(width, '0'));
}

const bench = new Bench();

for (const kind of KINDS) {
	// [0, N) is the base ascending pool; [N, 2N) is a disjoint "extra" pool for absent-find queries and
	// churn inserts, padded to the same width as the base pool so string comparisons stay well-defined.
	const pool = makeKeys(kind, 2 * N);
	const sortedKeys = pool.slice(0, N);
	const extraKeys = pool.slice(N);

	const shuffledKeys = shuffle(sortedKeys, lcg(1));

	// Bulk ascending insert (the split-heavy path): fresh tree per rep, timed portion is just the N inserts.
	let bulkTree: BTree<Key, Key>;
	bench.add(`bulk ascending insert (${kind})`, () => {
		for (const key of sortedKeys) bulkTree.insert(key);
	}, { beforeEach: () => { bulkTree = new BTree<Key, Key>(); } });

	// Optional second data point: BTree.buildFrom on the same sorted input - the intended fast path for bulk load.
	bench.add(`bulk ascending insert via buildFrom (${kind})`, () => {
		BTree.buildFrom<Key, Key>(sortedKeys);
	});

	// Optional freeze:false variant of the insert scenarios, for comparison against the frozen headline numbers.
	let bulkTreeNoFreeze: BTree<Key, Key>;
	bench.add(`bulk ascending insert, freeze:false (${kind})`, () => {
		for (const key of sortedKeys) bulkTreeNoFreeze.insert(key);
	}, { beforeEach: () => { bulkTreeNoFreeze = new BTree<Key, Key>(undefined, undefined, { freeze: false }); } });

	// Random insert (shuffled order, seeded so runs are comparable): fresh tree per rep.
	let randomTree: BTree<Key, Key>;
	bench.add(`random insert (${kind})`, () => {
		for (const key of shuffledKeys) randomTree.insert(key);
	}, { beforeEach: () => { randomTree = new BTree<Key, Key>(); } });

	// Random find: pre-populate once (outside the timed function), then look up N keys - half present
	// (from the base pool), half absent (from the disjoint extra pool) - shuffled together.
	const findTree = BTree.buildFrom<Key, Key>(sortedKeys);
	const findQueries = shuffle(
		[...shuffle(sortedKeys, lcg(2)).slice(0, N / 2), ...shuffle(extraKeys, lcg(3)).slice(0, N / 2)],
		lcg(4),
	);
	let findSink: Key | undefined;
	bench.add(`random find (${kind})`, () => {
		for (const key of findQueries) findSink = findTree.get(key);
	});

	// Range scan: pre-populate once, then repeatedly range() over random windows, reading entries inside
	// the loop (never spread the yielded path - a reused cursor spread out gives all-undefined, see review §2.1).
	const rangeTree = BTree.buildFrom<Key, Key>(sortedKeys);
	const windowCount = 100;
	const windowSize = Math.max(1, Math.floor(N / windowCount));
	const rangeRng = lcg(5);
	const ranges: KeyRange<Key>[] = Array.from({ length: windowCount }, () => {
		const start = Math.floor(rangeRng() * (N - windowSize));
		return new KeyRange<Key>(new KeyBound(sortedKeys[start]), new KeyBound(sortedKeys[start + windowSize - 1]));
	});
	let rangeSink: Key | undefined;
	bench.add(`range scan (${kind})`, () => {
		for (const range of ranges) {
			for (const path of rangeTree.range(range)) {
				rangeSink = rangeTree.at(path);
			}
		}
	});

	// Mixed churn: fresh pre-populated tree per rep (rebuild cost lands in beforeEach, so it isn't timed),
	// then interleaved random insert/deleteAt, driving repeated splits and merges/borrows.
	// NOTE: `churnRng` is drawn per-iteration and advances across tinybench reps, so the realized
	// insert:delete split varies rep-to-rep and the number of reps depends on host speed - it is NOT an
	// exactly-half-and-half nor host-portable-deterministic sequence. Fine for a throughput average; if a
	// future reader needs an exact/reproducible split, pre-build an interleaved op-type array per rep instead.
	const churnOpCount = Math.floor(N / 2);
	const churnRng = lcg(6);
	const churnInsertKeys = shuffle(extraKeys, lcg(7)).slice(0, Math.ceil(churnOpCount / 2));
	const churnDeleteKeys = shuffle(sortedKeys, lcg(8)).slice(0, Math.ceil(churnOpCount / 2));
	let churnTree: BTree<Key, Key>;
	bench.add(`mixed churn (${kind})`, () => {
		let insertIndex = 0;
		let deleteIndex = 0;
		for (let i = 0; i < churnOpCount; i++) {
			if (churnRng() < 0.5 && insertIndex < churnInsertKeys.length) {
				churnTree.insert(churnInsertKeys[insertIndex++]);
			} else if (deleteIndex < churnDeleteKeys.length) {
				const path = churnTree.find(churnDeleteKeys[deleteIndex++]);
				if (path.on) churnTree.deleteAt(path);
			}
		}
	}, { beforeEach: () => { churnTree = BTree.buildFrom<Key, Key>(sortedKeys); } });

	// Delete-heavy: delete every key (shuffled order) from a freshly-built PLAIN (base-less) tree per rep.
	// Borrow/merge cascades exercise the sibling paths and repeated mutableBranch calls on an owned spine -
	// the workload targeted by the COW-lazy-mutable-node change (F3: the COW plumbing must not tax a plain tree).
	const deleteKeys = shuffle(sortedKeys, lcg(9));
	let deletePlainTree: BTree<Key, Key>;
	bench.add(`delete-heavy, plain (${kind})`, () => {
		for (const key of deleteKeys) {
			const path = deletePlainTree.find(key);
			if (path.on) deletePlainTree.deleteAt(path);
		}
	}, { beforeEach: () => { deletePlainTree = BTree.buildFrom<Key, Key>(sortedKeys); } });

	// Delete-heavy on a DERIVED (copy-on-write) child: base built once (immutable while children exist),
	// a fresh child derived per rep. The first delete clones the write path; every later delete then hits
	// the already-owned spine - the F4 target (mutableBranch ownership fast path).
	const deleteBase = BTree.buildFrom<Key, Key>(sortedKeys);
	let deleteDerivedTree: BTree<Key, Key>;
	bench.add(`delete-heavy, derived (${kind})`, () => {
		for (const key of deleteKeys) {
			const path = deleteDerivedTree.find(key);
			if (path.on) deleteDerivedTree.deleteAt(path);
		}
	}, { beforeEach: () => { deleteDerivedTree = new BTree<Key, Key>(undefined, undefined, deleteBase); } });
}

await bench.run();
console.table(bench.table());
