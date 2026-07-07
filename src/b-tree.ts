import { KeyRange } from "./key-range.js";
import { BranchNode, TreeNode, LeafNode } from "./nodes.js";
import { Path, PathImpl, PathBranch } from "./path.js";

/** Node capacity.  Not configurable - not worth the runtime memory, when almost nobody will touch this */
export const NodeCapacity = 64;

/** Half-full / underflow threshold.  A non-root node underflows (triggers rebalance) below this fill. */
export const HalfCapacity = NodeCapacity >>> 1;

/** Thrown when a path is used after the tree was mutated, invalidating it.  Recoverable: re-`find` the key. */
export class InvalidPathError extends Error {
	constructor(message = "Path is invalid due to mutation of the tree") { super(message); this.name = "InvalidPathError"; }
}

/** Thrown when an operation requiring a path positioned on an entry is given a path in a crack (on === false). */
export class PathNotOnEntryError extends Error {
	constructor(message = "Path is not positioned on an entry") { super(message); this.name = "PathNotOnEntryError"; }
}

/** Thrown when the user comparator gives non-antisymmetric results for two keys (a bug in the comparator/input). */
export class InconsistentComparatorError extends Error {
	constructor(message = "Inconsistent comparison function for given values") { super(message); this.name = "InconsistentComparatorError"; }
}

/** Thrown by {@link BTree.buildFrom} when its input is not strictly ascending by the comparator - either an
 * out-of-order pair (compare > 0) or a duplicate (compare === 0).  The message names the offending pair. */
export class UnsortedInputError extends Error {
	constructor(message = "Input is not strictly ascending by the comparator") { super(message); this.name = "UnsortedInputError"; }
}

/** Optional, per-tree tuning of the two always-on safety costs.  Both default to the safe behavior. */
export interface BTreeOptions {
	/** Freeze entries on insert/update/upsert/merge to deter key mutation.  Default true (safe).
	 *  Set false only for trusted bulk loads of never-mutated entries — the tree then offers no protection. */
	freeze?: boolean;
	/** Run the full per-comparison antisymmetry check on EVERY key comparison (the historical behavior).
	 *  Default false.  When false, a cheap bounded sample of the first comparisons is checked instead, then the
	 *  check drops off the hot path entirely. */
	checkComparator?: boolean;
}

/**
 * Represents a lightweight B+(ish)Tree (data at leaves, but no linked list of leaves).
 * Provides copy-on-write capabilities
 * @template TEntry The type of entries stored in the B-tree.
 * @template TKey The type of keys used for indexing the entries.  This might be an element of TEntry, or TEntry itself.
 */
export class BTree<TKey, TEntry> {
	/** Local root, if this tree owns one.  A copy-on-write child with no local writes leaves this unset and
	 * resolves through {@link root} to its base's root; a standalone tree creates its root lazily on first use. */
	private _root?: TreeNode<TKey, TEntry>;
	/** Optional base tree this tree derives from (copy-on-write inheritance).  See the constructor docs. */
	private base?: BTree<TKey, TEntry>;
	/** Coarse, tree-wide mutation counter.  Every mutation ({@link insert}, {@link updateAt}, {@link upsert},
	 * {@link merge}, {@link deleteAt}, {@link clear}) bumps this, and a path is valid only while its stamped
	 * version still matches (see {@link isValid}).  Consequences of the coarseness, documented honestly:
	 *  - Paths and iterators do NOT survive ANY mutation - even an in-place {@link updateAt}/{@link upsert} that
	 *    moves nothing still bumps the version and invalidates every outstanding path.
	 *  - The one supported "mutate while iterating" pattern is delete-then-{@link moveNext}: {@link deleteAt}
	 *    re-stamps the path it is given so a following moveNext advances onto the deleted entry's successor
	 *    with no re-`find`.  See the README "Paths" section for the example.
	 * NOTE: _version is unbounded; as a JS number it loses integer precision past ~9e15 (2^53) mutations - not a
	 * practical in-memory concern, so it is left as a plain counter rather than wrapped. */
	private _version = 0;

	/** Stored entry count, maintained by exactly one +1 per real insertion ({@link internalInsertAt}) and one
	 * -1 per real deletion ({@link internalDelete}'s success branch), so the no-arg {@link getCount} and
	 * {@link size} are O(1) rather than a full leaf walk.  No-ops (rejected duplicate insert, in-place
	 * update/upsert of an unchanged key, off-entry delete) never reach either site and so leave this untouched.
	 * A copy-on-write child starts at its base's count (an O(1) read) and tracks its own delta from there —
	 * valid because the base is immutable for the lifetime of its derived children (see the constructor docs).
	 * Like {@link _version} it is a plain integer: in-memory entry counts never approach the 2^53 safe-integer
	 * limit, so no overflow handling is needed.
	 * NOTE: white-box code that fabricates a tree by assigning `_root` past the public insert path must also set
	 * `_count` to the true entry count, else the no-arg count and `assertTreeInvariants` rule 7 go stale. */
	private _count = 0;

	/** Number of leading comparisons antisymmetry-checked when checkComparator is false. */
	private static readonly SampleCheckCount = 32;
	private readonly _freeze: boolean;
	private readonly _checkComparator: boolean;
	/** Comparisons still to sample-check when checkComparator is false.  Decremented in compareKeys, then the check is skipped. */
	private _sampleChecksRemaining: number;

	/**
	 * @param [keyFromEntry=(entry: TEntry) => entry as unknown as TKey] a function to extract the key from an entry.  The default assumes the key is the entry itself.
	 * @param [compare=(a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0] a comparison function for keys.  The default uses < and > operators.
	 * @param [baseOrOptions] either a base tree to derive from (copy-on-write inheritance), or a
	 *   {@link BTreeOptions} object.  When a base tree is given, the derived tree initially shares all of the
	 *   base's nodes and clones them lazily as it is mutated, and options may be passed as the fourth argument.
	 * @param [options] optional per-tree tuning of the freeze / comparator-check safety costs.  See
	 *   {@link BTreeOptions}.  Used when the third argument is a base tree; ignored otherwise (pass the options
	 *   as the third argument when there is no base).
	 *
	 *   BASE-IMMUTABILITY CONTRACT: a base must be treated as **immutable for the lifetime of its derived
	 *   children**. The child reads any un-modified node directly from the base (see {@link root}), so
	 *   mutating the base (insert/update/delete) while a derived child is still in use can corrupt that
	 *   child's view of every node it still shares with the base. The fix is structural, not incidental:
	 *   derive your children first and then leave the base frozen, or, if you need to keep mutating the
	 *   original, mutate a *derived child* instead and treat the original base as the frozen snapshot.
	 *   This is currently a documented contract, not a runtime guard. See also {@link clearBase}, whose
	 *   "frozen" obligation outlives the base pointer.
	 */
	constructor(
		private readonly keyFromEntry = (entry: TEntry) => entry as unknown as TKey,
		private readonly compare = (a: TKey, b: TKey) => a < b ? -1 : a > b ? 1 : 0 as number,
		baseOrOptions?: BTree<TKey, TEntry> | BTreeOptions,
		options?: BTreeOptions,
	) {
		if (baseOrOptions instanceof BTree) {
			this.base = baseOrOptions;
			this._count = baseOrOptions.getCount();	// O(1): base's stored count; the child tracks its delta from here
		} else {
			options = baseOrOptions ?? options;
		}
		this._freeze = options?.freeze ?? true;
		this._checkComparator = options?.checkComparator ?? false;
		this._sampleChecksRemaining = this._checkComparator ? 0 : BTree.SampleCheckCount;
	}

	get root(): TreeNode<TKey, TEntry> {
		if (this._root) {
			return this._root;
		} else if (this.base) {
			return this.base.root;
		}

		this._root = new LeafNode<TEntry>([], this);
		return this._root;
	}

	/**
	 * Detaches this tree from its base, flattening it into a standalone tree. After this call the tree no
	 * longer depends on the base object: a child that has already written keeps its cloned `_root`; an
	 * unwritten child pins the base's current root as its own.
	 *
	 * IMPORTANT — this is a cheap pointer drop, NOT a deep copy. Copy-on-write only clones the nodes a
	 * child actually mutated, so a flattened child can still SHARE every untouched subtree with its former
	 * base by identity (an unwritten child shares the *entire* tree). Once the base pointer is gone neither
	 * tree copies-on-write anymore, so a structural write to a shared node mutates it in place for BOTH.
	 * The base-immutability contract therefore outlives this call: after `clearBase()`, treat the former
	 * base as frozen — in practice, discard it. If you genuinely need two independently-mutable trees,
	 * build a fresh tree and re-insert, rather than relying on `clearBase` to isolate shared structure.
	 */
	clearBase() {
		this._root = this._root ?? this.base?.root;
		this.base = undefined;
	}

	/**
	 * Produces a genuinely independent copy of this tree in one O(n) pass - the safe alternative to
	 * {@link clearBase} when true isolation from a former base is required. Where `clearBase` merely drops
	 * the base pointer (so untouched nodes can still be shared by identity with the former base - see its
	 * docs), `flatten` walks this tree's entries once and rebuilds them into a fresh, standalone tree via
	 * {@link BTree.buildFrom}, sharing no node with this tree or its base. The `freeze` and `checkComparator`
	 * options are carried over so the result behaves identically to this tree. Works the same whether or
	 * not this tree has a base, and on an empty tree (returns a valid, independent empty tree).
	 */
	flatten(): BTree<TKey, TEntry> {
		return BTree.buildFrom(this.entries(), this.keyFromEntry, this.compare, {
			freeze: this._freeze,
			checkComparator: this._checkComparator,
		});
	}

	/** Freezes an entry to deter key mutation, unless freezing was disabled at construction. */
	private freezeEntry(entry: TEntry): TEntry {
		if (this._freeze) Object.freeze(entry);
		return entry;
	}

	/**
	 * Builds a tree in a single bottom-up pass from already-sorted, duplicate-free input.  O(n) - versus the
	 * O(n log n) of repeated {@link insert} - and packs nodes near capacity rather than the roughly half-full
	 * nodes that natural splits leave behind.  The result is indistinguishable from a tree built by inserting the
	 * same entries (same structural invariants, same query answers) and is returned fresh at version 0.
	 *
	 * The input must be strictly ascending **by `compare`**.  It is validated - and, unless disabled, frozen - in
	 * one linear pass; the first out-of-order or duplicate pair throws {@link UnsortedInputError} and nothing is
	 * returned (the partially-built work is discarded).  Note the shared pass means that on the throw path the
	 * entries *before* the offending pair have already been frozen in place; the discarded tree is unreachable but
	 * those caller-owned objects stay frozen.  Pass `{ freeze: false }` if that side-effect matters.
	 *
	 * Parameter order and defaults mirror the {@link constructor} (keyFromEntry, then compare, then options), so a
	 * trusted load can pass `{ freeze: false }` to skip freezing.  A bulk-loaded tree is always standalone (no
	 * base); derive children from it afterward if copy-on-write inheritance is wanted.
	 * @param sorted any iterable of entries, strictly ascending by `compare` (array, generator, Set, ...).
	 */
	static buildFrom<TKey, TEntry>(
		sorted: Iterable<TEntry>,
		keyFromEntry?: (entry: TEntry) => TKey,
		compare?: (a: TKey, b: TKey) => number,
		options?: BTreeOptions,
	): BTree<TKey, TEntry> {
		const tree = new BTree<TKey, TEntry>(keyFromEntry, compare, options);
		const entries = [...sorted];
		const n = entries.length;
		const keyOf = tree.keyFromEntry;

		// One linear pass: validate strict-ascending order (compareKeys >= 0 catches both > 0 out-of-order and
		// = 0 duplicate) and freeze each entry (respecting the freeze option).  Routing through compareKeys also
		// runs the comparator's antisymmetry sample-check during load, for free.
		let prevKey!: TKey;
		for (let i = 0; i < n; i++) {
			const entry = entries[i];
			const key = keyOf(entry);
			if (i > 0) {
				const cmp = tree.compareKeys(prevKey, key);
				if (cmp >= 0) {
					throw new UnsortedInputError(cmp === 0
						? `buildFrom: duplicate key - entries[${i - 1}] and entries[${i}] compare equal (input must be strictly ascending).`
						: `buildFrom: out-of-order key - entries[${i - 1}] > entries[${i}] (input must be ascending by the comparator).`);
				}
			}
			tree.freezeEntry(entry);
			prevKey = key;
		}

		tree._count = n;
		if (n === 0) {
			return tree;	// the lazy root getter will produce an empty-leaf root on first use - a valid empty tree
		}

		// Pack leaves near capacity, carrying each node with its subtree-minimum key.  A subtree's minimum is its
		// leftmost leaf's first key, so a freshly packed leaf's min is simply its first entry's key.
		// NOTE: bulk-loaded leaves are packed to (near) NodeCapacity, so the FIRST insert into any full leaf
		// splits immediately - the deliberate cost of dense packing.  If a bulk load is routinely followed by heavy
		// insertion, an insert-built (roughly half-full) tree would churn less; bulk load optimizes for the load-then-read case.
		let level: { node: TreeNode<TKey, TEntry>, min: TKey }[] = [];
		let offset = 0;
		for (const size of BTree.chunkSizes(n)) {
			const chunk = entries.slice(offset, offset + size);
			offset += size;
			level.push({ node: new LeafNode<TEntry>(chunk, tree), min: keyOf(chunk[0]) });
		}

		// Build branch levels up, grouping the current level's nodes (same chunking + redistribution) until one
		// node remains - the root.  For a group of children [c0..ck]: partitions = [c1.min, ..., ck.min] and the
		// branch's own min = c0.min (a branch subtree's min is its leftmost child's min).
		while (level.length > 1) {
			const parent: { node: TreeNode<TKey, TEntry>, min: TKey }[] = [];
			let start = 0;
			for (const size of BTree.chunkSizes(level.length)) {
				const group = level.slice(start, start + size);
				start += size;
				const nodes = group.map(child => child.node);
				const partitions = group.slice(1).map(child => child.min);
				parent.push({ node: new BranchNode<TKey, TEntry>(partitions, nodes, tree), min: group[0].min });
			}
			level = parent;
		}
		tree._root = level[0].node;
		return tree;
	}

	/** Splits `total` items into node-sized chunk lengths so that no chunk except possibly the final (root) one
	 * is underfull.  Full {@link NodeCapacity} caps first, then any remainder; if that remainder is below
	 * {@link HalfCapacity} it is combined with the preceding full cap and the two split evenly, landing both in
	 * [HalfCapacity, NodeCapacity].  Deciding sizes before slicing keeps partition/child indexing from drifting.
	 * Applied identically to leaf entries and to branch children - the half-full threshold is the same for both. */
	private static chunkSizes(total: number): number[] {
		if (total <= NodeCapacity) return [total];
		const sizes: number[] = [];
		let remaining = total;
		while (remaining > NodeCapacity) {
			sizes.push(NodeCapacity);
			remaining -= NodeCapacity;
		}
		sizes.push(remaining);	// remaining in [1, NodeCapacity]
		const last = sizes.length - 1;
		if (sizes[last] < HalfCapacity && sizes.length >= 2) {
			const combined = sizes[last - 1] + sizes[last];	// NodeCapacity + remaining, in [65, 95]
			sizes[last - 1] = combined >>> 1;	// in [32, 47]
			sizes[last] = combined - sizes[last - 1];	// in [33, 48]
		}
		return sizes;
	}

	/** @returns a path to the first entry (on = false if no entries) */
	first(): Path<TKey, TEntry> {
		const root = this.root;	// COW: resolve through base
		const path = new PathImpl<TKey, TEntry>([], root as LeafNode<TEntry>, 0, false, this._version);
		this.moveToFirst(root, path);
		return path;
	}

	/** @returns a path to the last entry (on = false if no entries) */
	last(): Path<TKey, TEntry> {
		const root = this.root;	// COW: resolve through base
		const path = new PathImpl<TKey, TEntry>([], root as LeafNode<TEntry>, 0, false, this._version);
		this.moveToLast(root, path);
		return path;
	}

	/** Attempts to find the given key
	 * @returns Path to the key or the "crack" before it.  If `on` is true on the resulting path, the key was found.
	 * 	If `on` is false, next() and prior() can attempt to move to the nearest match. */
	find(key: TKey): Path<TKey, TEntry> {
		return this.getPath(this.root, key);
	}

	/** Retrieves the entry for the given key.
	 * Use find instead for a path to the key, the nearest match, or as a basis for navigation.
	 * @returns the entry for the given key if found; undefined otherwise. */
	get(key: TKey): TEntry | undefined {
		return this.at(this.find(key));
	}

	/** @returns the entry for the given path if on an entry; undefined otherwise. */
	at(path: Path<TKey, TEntry>): TEntry | undefined {
		const p = path as PathImpl<TKey, TEntry>;
		this.validatePath(p);
		return p.on ? p.leafNode.entries[p.leafIndex] : undefined;
	}

	/** Iterates based on the given range
	 * WARNING: mutation during iteration will result in an exception
	*/
	*range(range: KeyRange<TKey>): IterableIterator<Path<TKey, TEntry>> {
		const startPath = (range.first
			? this.findFirst(range)
			: (range.isAscending ? this.first() : this.last())) as PathImpl<TKey, TEntry>;
		const endPath = (range.last
			? this.findLast(range)
			: (range.isAscending ? this.last() : this.first())) as PathImpl<TKey, TEntry>;
		if (!startPath.on || !endPath.on) {
			return;	// no reachable start or end entry -> empty range
		}
		const ascendingFactor = range.isAscending ? 1 : -1;
		// The end position (endPath) is fixed before iteration, and the scan is strictly sequential, so the
		// per-element stop test is a (leafNode, leafIndex) match - no user comparator per element. The one case
		// position alone can't catch is start already past end (an ill-formed range like ascending first > last,
		// or an all-crack empty region where both bounds step to opposite sides): rule it out with a single
		// up-front comparison - the same test the old loop applied to its first element, just hoisted out.
		const startKey = this.keyFromEntry(startPath.leafNode.entries[startPath.leafIndex]);
		const endKey = this.keyFromEntry(endPath.leafNode.entries[endPath.leafIndex]);
		if (this.compareKeys(startKey, endKey) * ascendingFactor > 0) {
			return;	// start already past end -> empty range
		}
		const endLeaf = endPath.leafNode;
		const endIndex = endPath.leafIndex;
		const iterable = range.isAscending
			? this.internalAscending(startPath)
			: this.internalDescending(startPath);
		for (const path of iterable) {
			if (!path.on) {
				break;
			}
			yield path;
			if (path.leafNode === endLeaf && path.leafIndex === endIndex) {
				break;	// reached the fixed end position (inclusive); bound inclusivity is baked into endPath
			}
		}
	}

	/** @returns true if the given path remains valid; false if the tree has been mutated, invalidating the path. */
	isValid(path: Path<TKey, TEntry>) {
		return (path as PathImpl<TKey, TEntry>).version === this._version;
	}

	/**
	 * Adds a value to the tree.  Be sure to check the result, as the tree does not allow duplicate keys.
	 * Added entries are frozen to ensure immutability
	 * @returns path to the new (on = true) or conflicting (on = false) row. */
	insert(entry: TEntry): Path<TKey, TEntry> {
		const path = this.internalInsert(entry);
		if (path.on) {
			this.freezeEntry(entry);	// Ensure immutability (only once the entry is actually in the tree - a rejected duplicate is left untouched)
			path.version = ++this._version;
		}
		return path;
	}

	/** Updates the entry at the given path to the given value.  Deletes and inserts if the key changes.
	 * @throws PathNotOnEntryError if the given path is not positioned on an entry (on === false).
	 * @returns path to resulting entry and whether it was an update (as opposed to an insert).
	 * 	* on = true if update/insert succeeded.
	 * 		* wasUpdate = true if updated; false if inserted.
	 * 		* Returned path is on entry
	 * 	* on = false if the insert failed: newEntry's new key already present; returned path is "near" the existing entry (wasUpdate = false) */
	updateAt(path: Path<TKey, TEntry>, newEntry: TEntry): [path: Path<TKey, TEntry>, wasUpdate: boolean] {
		const p = path as PathImpl<TKey, TEntry>;
		this.validatePath(p);
		if (!p.on) {
			throw new PathNotOnEntryError();
		}
		this.freezeEntry(newEntry);
		const result = this.internalUpdate(p, newEntry);
		if (result[0].on) {
			result[0].version = ++this._version;
		}
		return result;
	}

	/** Inserts the entry if it doesn't exist, or updates it if it does.
	 * The entry is frozen to ensure immutability.
	 * @returns path to the new entry.  on = true if existing; on = false if new. */
	upsert(entry: TEntry): Path<TKey, TEntry> {
		const path = this.find(this.keyFromEntry(entry)) as PathImpl<TKey, TEntry>;
		this.freezeEntry(entry);
		if (path.on) {
			const mutable = this.mutableLeaf(path);
			mutable.entries[path.leafIndex] = entry;
		} else {
			this.internalInsertAt(path, entry);
		}
		path.version = ++this._version;
		return path;
	}

	/** Inserts or updates depending on the existence of the given key, using callbacks to generate the new value.
	 * @param newEntry the new entry to insert if the key doesn't exist.
	 * @param getUpdated a callback to generate an updated entry if the key does exist.  WARNING: mutation in this callback will cause merge to error.
	 * @returns path to new entry and whether an update or insert attempted.
	 * If getUpdated callback returns a row that is already present, the resulting path will not be on. */
	merge(newEntry: TEntry, getUpdated: (existing: TEntry) => TEntry): [path: Path<TKey, TEntry>, wasUpdate: boolean] {
		const newKey = this.keyFromEntry(newEntry);
		const path = this.find(newKey) as PathImpl<TKey, TEntry>;
		if (path.on) {
			const result = this.updateAt(path, getUpdated(path.leafNode.entries[path.leafIndex]));	// Don't use internalUpdate - need to freeze and check for mutation
			// Note: updateAt already increments version, so don't double-increment here
			return result;
		} else {
			this.internalInsertAt(path, this.freezeEntry(newEntry));
			path.on = true;
			path.version = ++this._version;
			return [path, false];
		}
	}

	/** Deletes the entry at the given path.
	 * The on property of the path will be cleared.
	 * @returns true if the delete succeeded (the key was found); false otherwise.
	*/
	deleteAt(path: Path<TKey, TEntry>): boolean {
		const p = path as PathImpl<TKey, TEntry>;
		this.validatePath(p);
		const result = this.internalDelete(p);
		if (result) {
			// Stamp the bumped version onto the path (mirror insert/updateAt/upsert): internalDelete keeps this path
			// positionally coherent at a crack whose leafIndex now points at the deleted entry's successor, so a
			// subsequent moveNext advances straight onto it - enabling delete-while-iterating with no re-find.
			p.version = ++this._version;
		}
		return result;
	}

	/** Iterates forward over live cursors, starting from the given path (inclusive) to the end.  With no
	 * argument, starts from {@link first} (the whole tree, ascending).
	 *
	 * WARNING: this yields the SAME cursor object every step, mutated in place - so it is a cursor-level tool,
	 * not a collection.  Spreading it (`[...tree.ascending()]`) or `.map`ping it gives N references to one path
	 * parked off the end, and reading them afterwards is all-`undefined`; read `tree.at(path)` INSIDE the loop,
	 * and `path.clone()` any cursor you need to retain.  For the common "give me the entries" case prefer
	 * {@link entries}/{@link keys}, which yield distinct values and sidestep this entirely.
	 * WARNING: mutation during iteration invalidates the cursor and the next step will throw.
	*/
	ascending(path?: Path<TKey, TEntry>): IterableIterator<Path<TKey, TEntry>> {
		const start = (path ?? this.first()) as PathImpl<TKey, TEntry>;
		this.validatePath(start);
		return this.internalAscending(start.clone());
	}

	/** Iterates backward over live cursors, starting from the given path (inclusive) to the start.  With no
	 * argument, starts from {@link last} (the whole tree, descending).
	 *
	 * WARNING: same aliasing caveat as {@link ascending} - one reused, mutated cursor per step.  Read inside the
	 * loop, `clone()` to retain, and prefer {@link entries}/{@link keys} when you just want the values.
	 * WARNING: mutation during iteration invalidates the cursor and the next step will throw.
	*/
	descending(path?: Path<TKey, TEntry>): IterableIterator<Path<TKey, TEntry>> {
		const start = (path ?? this.last()) as PathImpl<TKey, TEntry>;
		this.validatePath(start);
		return this.internalDescending(start.clone());
	}

	/** Yields each entry in the tree (or in `range` if given) directly - the safe, aliasing-free default for
	 * reading.  No argument iterates the whole tree ascending; a {@link KeyRange} delegates to {@link range}
	 * (honoring direction and inclusive/exclusive bounds identically).  Each yielded value is a distinct entry,
	 * so `[...tree.entries()]` and `.map` work as expected.
	 * WARNING: mutation during iteration invalidates the underlying cursor and the next step will throw. */
	*entries(range?: KeyRange<TKey>): IterableIterator<TEntry> {
		const paths = range === undefined ? this.ascending() : this.range(range);
		for (const path of paths) {
			yield this.at(path)!;
		}
	}

	/** Yields each key in the tree (or in `range` if given) - {@link entries} passed through `keyFromEntry`.
	 * Same delegation and aliasing-free guarantees as {@link entries}. */
	*keys(range?: KeyRange<TKey>): IterableIterator<TKey> {
		for (const entry of this.entries(range)) {
			yield this.keyFromEntry(entry);
		}
	}

	/** Enables `for (const entry of tree)` and `[...tree]` - each element is a distinct entry in ascending key
	 * order (an alias for {@link entries} with no range). */
	[Symbol.iterator](): IterableIterator<TEntry> {
		return this.entries();
	}

	/** Empties the tree, invalidating every outstanding path (a subsequent use throws {@link InvalidPathError}).
	 * The tree stays usable afterward: {@link getCount} is 0 and {@link insert} works again.  This is the intended
	 * way to empty a tree in place, rather than deleting every entry or discarding the instance.
	 * On a copy-on-write child this also detaches the base: an empty tree shares nothing, so there is nothing
	 * left to inherit (the base itself is untouched, as always). */
	clear(): void {
		this._root = new LeafNode<TEntry>([], this);
		this.base = undefined;	// COW: an empty tree inherits nothing; dropping the pointer frees the base chain
		this._count = 0;
		++this._version;
	}

	/** The total number of entries in the tree (an alias for the no-arg {@link getCount}).  O(1) - reads the
	 * stored count, maintained per mutation. */
	get size(): number {
		return this._count;
	}

	/** Number of entries in the tree.  With no argument, O(1): returns the stored count.
	 * @param from if provided, the count is a partial count that walks from the given path (inclusive) - O(n/af)
	 * 	where af is average fill.  If ascending is false, the count starts from the end of the tree.  Ascending is
	 * 	true by default.  This overload cannot be answered from the stored count and always walks.
	 */
	getCount(from?: { path: Path<TKey, TEntry>, ascending?: boolean }): number {
		if (!from) {
			return this._count;	// O(1): stored count, maintained by internalInsertAt / internalDelete
		}
		this.validatePath(from.path as PathImpl<TKey, TEntry>);	// Validate here (public entry point): internalNext/internalPrior no longer self-validate.
		let result = 0;
		const path = from.path.clone() as PathImpl<TKey, TEntry>;
		if (from.ascending ?? true) {
			while (path.on) {
				result += path.leafNode.entries.length - path.leafIndex;
				path.leafIndex = path.leafNode.entries.length - 1;
				this.internalNext(path);
			}
		} else {
			while (path.on) {
				result += path.leafIndex + 1;
				path.leafIndex = 0;
				this.internalPrior(path);
			}
		}
		return result;
	}

	/** @returns a path one step forward.  on will be true if the path hasn't hit the end. */
	next(path: Path<TKey, TEntry>): Path<TKey, TEntry> {
		const newPath = path.clone();
		this.moveNext(newPath);
		return newPath;
	}

	/** Attempts to advance the given path one step forward. (mutates the path) */
	moveNext(path: Path<TKey, TEntry>) {
		const p = path as PathImpl<TKey, TEntry>;
		this.validatePath(p);
		this.internalNext(p);
	}

	/** @returns a path one step backward.  on will be true if the path hasn't hit the end. */
	prior(path: Path<TKey, TEntry>): Path<TKey, TEntry> {
		const newPath = path.clone();
		this.movePrior(newPath);
		return newPath;
	}

	/** Attempts to advance the given path one step backwards. (mutates the path) */
	movePrior(path: Path<TKey, TEntry>) {
		const p = path as PathImpl<TKey, TEntry>;
		this.validatePath(p);
		this.internalPrior(p);
	}

	/**
	 * Invokes user-provided comperator to compare two keys.
	 * Inner-loop code, so this doesn't do backflips to iron out ES's idiosyncrasies (undefined quirks, infinity, nulls, etc.), but does ensure deterministic comparison.
	 *
	 * The antisymmetry check (a second, reversed compare) runs on every comparison when the tree was
	 * constructed with `{ checkComparator: true }`; otherwise it runs only for the first
	 * {@link BTree.SampleCheckCount} comparisons (a cheap sample), then drops off the hot path entirely.
	 * A subtly-inconsistent comparator that only misbehaves deep in a large tree can therefore slip past
	 * the default sample — use `{ checkComparator: true }` for the exhaustive (historical) check.
	 *
	 * If you want to eak out more performance at the risk of corruption, you can override this method and omit the consistency check.
	 */
	protected compareKeys(a: TKey, b: TKey): number {
		const result = this.compare(a, b);
		if (this._checkComparator || this._sampleChecksRemaining > 0) {
			if (result !== 0 && result === this.compare(b, a)) {
				throw new InconsistentComparatorError();
			}
			if (!this._checkComparator && this._sampleChecksRemaining > 0) {
				--this._sampleChecksRemaining;
			}
		}
		return result;
	}

	private *internalAscending(path: PathImpl<TKey, TEntry>): IterableIterator<PathImpl<TKey, TEntry>> {
		this.validatePath(path);
		while (path.on) {
			yield path;
			this.moveNext(path);	// Not internal - re-check after yield
		}
	}

	private *internalDescending(path: PathImpl<TKey, TEntry>): IterableIterator<PathImpl<TKey, TEntry>> {
		this.validatePath(path);
		while (path.on) {
			yield path;
			this.movePrior(path);	// Not internal - re-check after yield
		}
	}

	private findFirst(range: KeyRange<TKey>): PathImpl<TKey, TEntry> {	// Assumes range.first is defined
		const startPath = this.find(range.first!.key) as PathImpl<TKey, TEntry>;
		if (!startPath.on || !range.first!.inclusive) {
			if (range.isAscending) {
				this.internalNext(startPath);
			} else {
				this.internalPrior(startPath);
			}
		}
		return startPath;
	}

	private findLast(range: KeyRange<TKey>): PathImpl<TKey, TEntry> {	// Assumes range.last is defined
		const endPath = this.find(range.last!.key) as PathImpl<TKey, TEntry>;
		if (!endPath.on || !range.last!.inclusive) {
			if (range.isAscending) {
				this.internalPrior(endPath);
			} else {
				this.internalNext(endPath);
			}
		}
		return endPath;
	}


	private getPath(node: TreeNode<TKey, TEntry>, key: TKey): PathImpl<TKey, TEntry> {
		// Descend top-down, pushing each branch in root->leaf order (already the order Path.branches wants),
		// so no unshift/reversal is needed and building an N-level path costs O(depth), not O(depth^2).
		const branches: PathBranch<TKey, TEntry>[] = [];
		let current = node;
		while (!(current instanceof LeafNode)) {
			const branch = current;
			const index = this.indexOfKey(branch.partitions, key);
			branches.push(new PathBranch(branch, index));
			current = branch.nodes[index];
		}
		const leaf = current;
		const [on, index] = this.indexOfEntry(leaf.entries, key);
		return new PathImpl<TKey, TEntry>(branches, leaf, index, on, this._version);
	}

	// Twin binary search of indexOfKey below - same loop, differs only in key extraction (keyFromEntry here)
	// and the equal-case return ([true, split] here vs split+1 there).  Fix both together.
	private indexOfEntry(entries: TEntry[], key: TKey): [on: boolean, index: number] {
		let lo = 0;
		let hi = entries.length - 1;
		let split = 0;
		let result = -1;

		while (lo <= hi) {
			split = (lo + hi) >>> 1;
			result = this.compareKeys(key, this.keyFromEntry(entries[split]));

			if (result === 0)
				return [true, split];
			else if (result < 0)
				hi = split - 1;
			else
				lo = split + 1;
		}

		return [false, lo];
	}

	// Twin binary search of indexOfEntry above - same loop, differs only in key extraction (keys direct here)
	// and the equal-case return (split+1 here, taking the right partition, vs [true, split] there).  Fix both together.
	private indexOfKey(keys: TKey[], key: TKey): number {
		let lo = 0;
		let hi = keys.length - 1;
		let split = 0;
		let result = -1;

		while (lo <= hi) {
			split = (lo + hi) >>> 1;
			result = this.compareKeys(key, keys[split]);

			if (result === 0)
				return split + 1;	// +1 because taking right partition
			else if (result < 0)
				hi = split - 1;
			else
				lo = split + 1;
		}

		return lo;
	}

	private internalNext(path: PathImpl<TKey, TEntry>) {
		if (!path.on) {	// Attempt to move off of crack
			path.on = path.branches.every(branch => branch.index >= 0 && branch.index < branch.node.nodes.length)
				&& path.leafIndex >= 0 && path.leafIndex < path.leafNode.entries.length;
			if (path.on || path.leafIndex < path.leafNode.entries.length) {
				return;	// recovered onto an entry, or crack precedes an entry in this leaf
			}
			// end-of-leaf crack (leafIndex === entries.length): fall through to advance into the next leaf
		}
		if (path.leafIndex >= path.leafNode.entries.length - (path.on ? 1 : 0)) {
			let popCount = 0;
			let found = false;
			const last = path.branches.length - 1;
			while (popCount <= last && !found) {
				const branch = path.branches[last - popCount];
				if (branch.index === branch.node.partitions.length)	// last node in branch
					++popCount;
				else
					found = true;
			}

			if (!found) {
				path.leafIndex = path.leafNode.entries.length;	// after last row = end crack
				path.on = false;
			} else {
				path.branches.length -= popCount;	// truncate in place; the discarded splice result was pure garbage
				const branch = path.branches.at(-1)!;
				++branch.index;
				this.moveToFirst(branch.node.nodes[branch.index], path);
			}
		}
		else {
			++path.leafIndex;
			path.on = true;
		}
	}

	private internalPrior(path: PathImpl<TKey, TEntry>) {
		// Validation lives in the public wrappers (movePrior/descending/getCount enter via validated paths),
		// mirroring internalNext which also doesn't self-validate.  Don't re-add here - it double-validates.
		if (path.leafIndex <= 0) {
			let popCount = 0;
			let opening = false;
			const last = path.branches.length - 1;
			while (popCount <= last && !opening) {
				const branch = path.branches[last - popCount];
				if (branch.index === 0)	// first node in branch
					++popCount;
				else
					opening = true;
			}

			if (!opening) {
				path.leafIndex = 0;
				path.on = false;
			} else {
				path.branches.length -= popCount;	// truncate in place; the discarded splice result was pure garbage
				const branch = path.branches.at(-1)!;
				--branch.index;
				this.moveToLast(branch.node.nodes[branch.index], path);
			}
		}
		else {
			--path.leafIndex;
			path.on = true;
		}
	}

	private internalUpdate(path: PathImpl<TKey, TEntry>, newEntry: TEntry): [path: PathImpl<TKey, TEntry>, wasUpdate: boolean] {
		if (path.on) {
			const oldKey = this.keyFromEntry(path.leafNode.entries[path.leafIndex]);
			const newKey = this.keyFromEntry(newEntry);
			if (this.compareKeys(oldKey, newKey) !== 0) {	// if key changed, delete and re-insert
				let newPath = this.internalInsert(newEntry)
				if (newPath.on) {	// insert succeeded
					this.internalDelete(this.find(oldKey) as PathImpl<TKey, TEntry>);	// Re-find - insert invalidated path
					newPath = this.find(newKey) as PathImpl<TKey, TEntry>;	// Re-find- delete invalidated path
				}
				return [newPath, false];
			} else {
				const mutable = this.mutableLeaf(path);
				mutable.entries[path.leafIndex] = newEntry;
			}
		}
		return [path, true];
	}

	private internalDelete(path: PathImpl<TKey, TEntry>): boolean {
		if (path.on) {
			--this._count;	// The one deletion chokepoint - off-entry (no-op) deletes take the else branch and leave the count alone.
			const mutable = this.mutableLeaf(path);
			mutable.entries.splice(path.leafIndex, 1);
			if (path.branches.length > 0) {   // Only worry about underflows, balancing, etc. if not root
				if (path.leafIndex === 0 && path.leafNode.entries.length > 0) { // If we deleted index 0 and leaf is not empty, update branches with new key
					const pathBranch = path.branches.at(-1)!;
					this.updatePartition(pathBranch.index, path, path.branches.length - 1, this.keyFromEntry(path.leafNode.entries[path.leafIndex]));
				}
				const newRoot = this.rebalanceLeaf(path);
				if (newRoot) {
					this._root = newRoot;
				}
			}
			path.on = false;
			return true;
		} else {
			return false;
		}
	}

	private internalInsert(entry: TEntry): PathImpl<TKey, TEntry> {
		const path = this.find(this.keyFromEntry(entry)) as PathImpl<TKey, TEntry>;
		if (path.on) {
			path.on = false;
			return path;
		}
		this.internalInsertAt(path, entry);
		path.on = true;
		return path;
	}

	private internalInsertAt(path: PathImpl<TKey, TEntry>, entry: TEntry) {
		++this._count;	// The one insertion chokepoint - every public insert (insert/upsert/merge/key-change updateAt) funnels here.
		let split = this.leafInsert(path, entry);
		let branchIndex = path.branches.length - 1;
		while (split && branchIndex >= 0) {
			split = this.branchInsert(path, branchIndex, split);
			--branchIndex;
		}
		if (split) {
			const newBranch = new BranchNode<TKey, TEntry>([split.key], [this.root, split.right], this);
			this._root = newBranch;
			path.branches.unshift(new PathBranch(newBranch, split.indexDelta));
		}
	}

	/** Starting from the given node, recursively working down to the leaf, build onto the path based on the beginning-most entry. */
	private moveToFirst(node: TreeNode<TKey, TEntry>, path: PathImpl<TKey, TEntry>) {
		if (node instanceof LeafNode) {
			const leaf = node;
			path.leafNode = leaf;
			path.leafIndex = 0;
			path.on = leaf.entries.length > 0;
		} else {
			path.branches.push(new PathBranch(node, 0));
			this.moveToFirst(node.nodes[0], path);
		}
	}

	/** Starting from the given node, recursively working down to the leaf, build onto the path based on the end-most entry. */
	private moveToLast(node: TreeNode<TKey, TEntry>, path: PathImpl<TKey, TEntry>) {
		if (node instanceof LeafNode) {
			const leaf = node;
			const count = leaf.entries.length;
			path.leafNode = leaf;
			path.on = count > 0;
			path.leafIndex = count > 0 ? count - 1 : 0;
		} else {
			const branch = node;
			const pathBranch = new PathBranch(branch, branch.partitions.length);
			path.branches.push(pathBranch);
			this.moveToLast(branch.nodes[pathBranch.index], path);
		}
	}

	private leafInsert(path: PathImpl<TKey, TEntry>, entry: TEntry): Split<TKey, TEntry> | undefined {
		const { leafIndex: index } = path;
		const leaf = this.mutableLeaf(path);
		if (leaf.entries.length < NodeCapacity) {  // No split needed
			leaf.entries.splice(index, 0, entry);
			return undefined;
		}
		// Full. Split needed

		const midIndex = (leaf.entries.length + 1) >>> 1;
		const moveEntries = leaf.entries.splice(midIndex);

		// New node
		const newLeaf = new LeafNode(moveEntries, this);

		const delta = index < midIndex ? 0 : 1;
		if (delta) {	// new node goes into the new leaf
			path.leafNode = newLeaf;
			path.leafIndex -= leaf.entries.length;
			newLeaf.entries.splice(path.leafIndex, 0, entry);
		} else {	// new node goes into the old leaf
			leaf.entries.splice(index, 0, entry);
		}

		return new Split<TKey, TEntry>(this.keyFromEntry(moveEntries[0]), newLeaf, delta);
	}

	private branchInsert(path: PathImpl<TKey, TEntry>, branchIndex: number, split: Split<TKey, TEntry>): Split<TKey, TEntry> | undefined {
		const pathBranch = path.branches[branchIndex];
		const { index } = pathBranch;
		pathBranch.index += split.indexDelta;
		const mutable = this.mutableBranch(path, branchIndex);
		mutable.partitions.splice(index, 0, split.key);
		mutable.nodes.splice(index + 1, 0, split.right);
		if (mutable.nodes.length <= NodeCapacity) {  // no split needed
			return undefined;
		}
		// Full. Split needed

		const midIndex = mutable.nodes.length >>> 1;
		const movePartitions = mutable.partitions.splice(midIndex);
		const newPartition = mutable.partitions.pop()!;	// Extra partition promoted to parent
		const moveNodes = mutable.nodes.splice(midIndex);

		// New node
		const newBranch = new BranchNode<TKey, TEntry>(movePartitions, moveNodes, this);

		const delta = pathBranch.index < midIndex ? 0 : 1;
		if (delta) { // If new entry in new node, repoint and slide the index
			pathBranch.index -= midIndex;
			pathBranch.node = newBranch;
		}

		return new Split<TKey, TEntry>(newPartition, newBranch, delta);
	}

	private rebalanceLeaf(path: PathImpl<TKey, TEntry>): TreeNode<TKey, TEntry> | undefined {
		if (path.leafNode.entries.length >= HalfCapacity) {
			return undefined;
		}

		const leaf = path.leafNode;
		const parent = path.branches.at(-1)!;
		const depth = path.branches.length - 1;
		const pIndex = parent.index;
		const pNode = parent.node;

		const rightSib = pNode.nodes[pIndex + 1] as LeafNode<TEntry> | undefined;
		if (rightSib && rightSib.entries.length > HalfCapacity) {   // Attempt to borrow from right sibling
			const rightMutable = this.mutableLeaf(path, rightSib, 1);
			const leafMutable = this.mutableLeaf(path);
			const entry = rightMutable.entries.shift()!;
			leafMutable.entries.push(entry);
			this.updatePartition(pIndex + 1, path, depth, this.keyFromEntry(rightMutable.entries[0]!));
			return undefined;
		}

		const leftSib = pNode.nodes[pIndex - 1] as LeafNode<TEntry> | undefined;
		if (leftSib && leftSib.entries.length > HalfCapacity) {   // Attempt to borrow from left sibling
			const leftMutable = this.mutableLeaf(path, leftSib, -1);
			const leafMutable = this.mutableLeaf(path);
			const entry = leftMutable.entries.pop()!;
			leafMutable.entries.unshift(entry);
			this.updatePartition(pIndex, path, depth, this.keyFromEntry(entry));
			path.leafIndex += 1;
			return undefined;
		}

		if (rightSib && rightSib.entries.length + leaf.entries.length <= NodeCapacity) {  // Attempt to merge right sibling into leaf (right sib deleted)
			const leafMutable = this.mutableLeaf(path);
			const pNodeMutable = this.mutableBranch(path, depth);
			leafMutable.entries.push(...rightSib.entries);
			pNodeMutable.partitions.splice(pIndex, 1);
			pNodeMutable.nodes.splice(pIndex + 1, 1);
			// No partition update needed (mirror of the branch merge-right case below): a non-root leaf is never
			// empty at the underflow threshold, an index-0 deletion already propagated its new key to ancestors
			// in internalDelete before rebalancing, and merging the right sibling appends - so leaf.entries[0]
			// is unchanged and the partition already holds this exact key.
			return this.rebalanceBranch(path, depth);
		}

		if (leftSib && leftSib.entries.length + leaf.entries.length <= NodeCapacity) {  // Attempt to merge into left sibling (leaf deleted)
			const leftMutable = this.mutableLeaf(path, leftSib, -1);
			const pNodeMutable = this.mutableBranch(path, depth);
			path.leafNode = leftMutable;
			path.leafIndex += leftMutable.entries.length;
			leftMutable.entries.push(...leaf.entries);
			pNodeMutable.partitions.splice(pIndex - 1, 1);
			pNodeMutable.nodes.splice(pIndex, 1);
			return this.rebalanceBranch(path, depth);
		}
	}

	private rebalanceBranch(path: PathImpl<TKey, TEntry>, depth: number): TreeNode<TKey, TEntry> | undefined {
		const pathBranch = path.branches[depth];
		const branch = pathBranch.node;
		if (depth === 0 && branch.partitions.length === 0) {  // last node... collapse child into root
			return path.branches[depth + 1]?.node ?? path.leafNode;
		}

		if (depth === 0 || (branch.nodes.length >= HalfCapacity)) {
			return undefined;
		}

		const parent = path.branches.at(depth - 1)!;
		const pIndex = parent.index;
		const pNode = parent.node;

		const rightSib = pNode.nodes[pIndex + 1] as BranchNode<TKey, TEntry> | undefined;
		if (rightSib && rightSib.nodes.length > HalfCapacity) {   // Attempt to borrow from right sibling
			const rightMutable = this.mutableBranch(path, depth, rightSib, 1);
			const branchMutable = this.mutableBranch(path, depth);
			branchMutable.partitions.push(pNode.partitions[pIndex]);
			const node = rightMutable.nodes.shift()!;
			branchMutable.nodes.push(node);
			const rightKey = rightMutable.partitions.shift()!;	// Replace parent partition with old key from right sibling
			this.updatePartition(pIndex + 1, path, depth - 1, rightKey);
			return undefined;
		}

		const leftSib = pNode.nodes[pIndex - 1] as BranchNode<TKey, TEntry> | undefined;
		if (leftSib && leftSib.nodes.length > HalfCapacity) {   // Attempt to borrow from left sibling
			const leftMutable = this.mutableBranch(path, depth, leftSib, -1);
			const branchMutable = this.mutableBranch(path, depth);
			branchMutable.partitions.unshift(pNode.partitions[pIndex - 1]);
			const node = leftMutable.nodes.pop()!;
			branchMutable.nodes.unshift(node);
			const pKey = leftMutable.partitions.pop()!;
			pathBranch.index += 1;
			this.updatePartition(pIndex, path, depth - 1, pKey);
			return undefined;
		}

		if (rightSib && rightSib.nodes.length + branch.nodes.length <= NodeCapacity) {   // Attempt to merge right sibling into self
			const pMutable = this.mutableBranch(path, depth - 1);
			const branchMutable = this.mutableBranch(path, depth);
			const pKey = pMutable.partitions.splice(pIndex, 1)[0]
			branchMutable.partitions.push(pKey);
			branchMutable.partitions.push(...rightSib.partitions);
			branchMutable.nodes.push(...rightSib.nodes);
			pMutable.nodes.splice(pIndex + 1, 1);
			// No partition update needed: merging the right sibling in keeps branchMutable.nodes[0], so the
			// branch's subtree minimum is unchanged. (The old code wrote pMutable.partitions[0] here, which is
			// the parent's first separator - larger than the branch's true min - corrupting an ancestor partition.)
			return this.rebalanceBranch(path, depth - 1);
		}

		if (leftSib && leftSib.nodes.length + branch.nodes.length <= NodeCapacity) {   // Attempt to merge self into left sibling
			const pMutable = this.mutableBranch(path, depth - 1);
			const leftMutable = this.mutableBranch(path, depth, leftSib, -1);
			pathBranch.node = leftMutable;
			pathBranch.index += leftMutable.nodes.length;
			const pKey = pMutable.partitions.splice(pIndex - 1, 1)[0];
			leftMutable.partitions.push(pKey);
			leftMutable.partitions.push(...branch.partitions);
			leftMutable.nodes.push(...branch.nodes);
			pMutable.nodes.splice(pIndex, 1);
			return this.rebalanceBranch(path, depth - 1);
		}
	}

	private updatePartition(nodeIndex: number, path: PathImpl<TKey, TEntry>, depth: number, newKey: TKey) {
		if (nodeIndex > 0) {  // Only affects this branch; just update the partition key
			const mutable = this.mutableBranch(path, depth);
			mutable.partitions[nodeIndex - 1] = newKey;
		} else if (depth !== 0) {
			this.updatePartition(path.branches[depth - 1].index, path, depth - 1, newKey);
		}
	}

	/** Returns a mutable copy of a leaf, cloning it and its rootward spine only when this tree does not already
	 * own it.  Two coordinate forms, both addressed against the live `path` (never a pre-built clone):
	 *  - main spine (no `sib`): the leaf is `path.leafNode`, cloned rootward along `path.branches`.
	 *  - sibling borrow/merge (`sib`, `delta`): the leaf is `sib`, reached through the shared parent by shifting
	 *    the deepest branch index by `delta` (+1 right, -1 left) so it addresses the sibling's slot, not the main
	 *    leaf's — without this the wrong slot is made mutable and the borrow/merge corrupts the COW linkage.
	 * The clone material (map, sibling spine copy) is built lazily, only after a clone is decided, so a plain
	 * (base-less) tree or an already-owned leaf allocates nothing (F3). */
	private mutableLeaf(path: PathImpl<TKey, TEntry>, sib?: LeafNode<TEntry>, delta = 0): LeafNode<TEntry> {
		const leaf = sib ?? path.leafNode;
		if (this.base && leaf.tree !== this) {
			const map = new Map<TreeNode<TKey, TEntry>, TreeNode<TKey, TEntry>>();
			const newNode = leaf.clone(this);
			map.set(leaf, newNode);
			// Build the rootward spine only now that a clone is required.  The main-spine case reuses
			// path.branches directly; the sibling case needs an index-shifted copy so replaceRootward links the
			// clone into the sibling's parent slot without disturbing the live path's own indices.
			let branches = path.branches;
			if (sib) {
				branches = path.branches.map(b => b.clone());
				if (branches.length > 0) {
					branches[branches.length - 1].index += delta;
				}
			}
			this.replaceRootward(newNode, branches, map);
			path.remap(map);
			return newNode;
		}
		return leaf;
	}

	/** Returns a mutable copy of a branch, cloning it and its rootward spine only when this tree does not already
	 * own it.  Two coordinate forms, both addressed against the live `path` (never a pre-built segment list):
	 *  - main spine (no `sib`): the branch is `path.branches[depth]`, cloned rootward along `path.branches[0..depth]`.
	 *  - sibling borrow/merge (`sib`, `delta`): the branch is `sib`, reached through the shared parent at
	 *    `depth - 1` by shifting that parent's index by `delta` (see {@link branchSibSegments}).
	 * An owned bottom branch implies all ancestors are owned (the upward-closed ownership invariant), so an
	 * already-owned branch — or a base-less tree — returns immediately, allocating no map or segment list (F4).
	 * The segment list is otherwise built lazily, only after a clone is decided (F3). */
	private mutableBranch(path: PathImpl<TKey, TEntry>, depth: number, sib?: BranchNode<TKey, TEntry>, delta = 0): BranchNode<TKey, TEntry> {
		const branch = sib ?? path.branches[depth].node;
		// No base means nothing to copy-on-write against (branch already owned, or a hand-built tree's unowned-but-
		// exclusively-ours node); an owned bottom branch means the whole rootward spine is owned too.  Either way
		// return it directly rather than allocating a map + running replaceRootward + remapping an empty map.
		// NOTE: the owned-branch fast path is correct ONLY while ownership stays upward-closed (an owned node never
		// sits beneath a base-owned ancestor - assertOwnershipInvariant check 1). If that invariant is ever
		// weakened, this would skip a needed clone and corrupt the derived tree; revisit here first.
		if (!this.base || branch.tree === this) {
			return branch;
		}
		// Clone required: build the segment list now.  Sibling => the index-shifted spine addressing the sibling
		// through its shared parent; main spine => the plain rootward slice.
		const segments = sib
			? branchSibSegments(path, depth, sib, delta)
			: path.branches.slice(0, depth + 1);
		const map = new Map<TreeNode<TKey, TEntry>, TreeNode<TKey, TEntry>>();
		this.replaceRootward(undefined, segments, map);
		path.remap(map);
		return map.get(branch) as BranchNode<TKey, TEntry> ?? branch;
	}

	private replaceRootward(prior: TreeNode<TKey, TEntry> | undefined, segments: PathBranch<TKey, TEntry>[], map: Map<TreeNode<TKey, TEntry>, TreeNode<TKey, TEntry>>) {
		for (let i = segments.length - 1; i >= 0; --i) {
			const seg = segments[i];
			if (seg.node.tree === this) {
				// Ancestor is already owned by this tree: link the freshly-cloned child into it
				// rather than returning unconditionally, or the clone is orphaned and the owned
				// ancestor keeps pointing at the stale base node (dropped writes / phantom keys).
				// The `prior` guard preserves the mutableBranch(undefined, ...) no-op entry path.
				if (prior) {
					seg.node.nodes[seg.index] = prior;
				}
				return;
			}
			const newBranch = seg.node.clone(this);
			if (prior) {
				newBranch.nodes[seg.index] = prior;
			}
			map.set(seg.node, newBranch);
			prior = newBranch;
		}
		this._root = prior;
	}

	private validatePath(path: PathImpl<TKey, TEntry>) {
		if (!this.isValid(path)) {
			throw new InvalidPathError();
		}
	}
}

/**
 * Builds the branch-segment list addressing a *sibling* of the underflowing branch at `path.branches[depth]`,
 * for a copy-on-write `mutableBranch` clone during a branch borrow/merge. The parent of both the underflowing
 * branch and its sibling is `path.branches[depth - 1]`, whose index addresses the *underflowing* branch's slot
 * (`pIndex`). The sibling lives at `pIndex + delta` (+1 right, -1 left), so the cloned parent segment's index
 * must be shifted by `delta` — otherwise `replaceRootward`, on reaching the (already-owned) parent, would link
 * the freshly-cloned sibling into the underflowing branch's slot, clobbering it and orphaning a whole subtree.
 *
 * This is the branch-level analogue of the sibling form of {@link BTree.mutableLeaf} (which inlines the same
 * parent-index shift for the leaf-level borrow/merge). The sibling's own appended index is unused by the clone
 * and is left at 0.  Called only from {@link BTree.mutableBranch}, lazily, once a clone is actually required.
 */
function branchSibSegments<TKey, TEntry>(path: PathImpl<TKey, TEntry>, depth: number, sib: BranchNode<TKey, TEntry>, delta: number): PathBranch<TKey, TEntry>[] {
	const segments = path.branches.slice(0, depth).map(b => b.clone());
	segments[depth - 1].index += delta;	// parent now addresses the sibling, not the underflowing branch
	segments.push(new PathBranch(sib, 0));
	return segments;
}

class Split<TKey, TEntry> {
	constructor(
		public key: TKey,
		public right: TreeNode<TKey, TEntry>,
		public indexDelta: number,
	) { }
}
