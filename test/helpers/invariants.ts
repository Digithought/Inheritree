import { BranchNode, TreeNode, ITreeNode, LeafNode } from '../../src/nodes.js';
import { BTree, NodeCapacity } from '../../src/index.js';
import { asImpl } from './path-impl.js';

/** Options controlling {@link assertTreeInvariants}. */
export interface InvariantOptions {
	/** When true (the default), the root node is exempt from the minimum-fill lower bound.
	 * A B+tree's root is legitimately allowed to be under half-full: it may hold as few as a
	 * single entry (single-leaf tree) or — when it is a branch — as few as two children. Set
	 * false only when validating a tree you expect to be deep/full at the root. */
	allowUnderfilledRoot?: boolean;
}

/** Minimum fill used by the tree's rebalancer.
 * Mirrors `rebalanceLeaf` (src/b-tree.ts) and `rebalanceBranch` (src/b-tree.ts), both `NodeCapacity >>> 1`. */
const MinFill = NodeCapacity >>> 1;

function describeKey(key: unknown): string {
	try {
		const json = JSON.stringify(key);
		return json === undefined ? String(key) : json;
	} catch {
		return String(key);
	}
}

/**
 * Recursively validates the structural invariants of a {@link BTree}, throwing an Error (naming the
 * offending node path and the violated rule) on the first violation found.
 *
 * Reaches the root via `(tree as any)['_root']` and the user-supplied comparator / key extractor via
 * `(tree as any)['compare']` and `(tree as any)['keyFromEntry']`, so it works for any key type.
 *
 * Rules checked:
 *   1. Uniform leaf depth — every leaf sits at the same depth.
 *   2. Fill bounds — every non-root node holds between `NodeCapacity>>>1` and `NodeCapacity` entries
 *      (leaf) / children (branch); the root is exempt from the lower bound unless
 *      `opts.allowUnderfilledRoot` is false. A root branch must still have >= 2 children.
 *   3. Shape — every branch has `partitions.length === nodes.length - 1`.
 *   4. Partition separation — for a branch, every key in subtree `nodes[i]` is `< partitions[i]`, and
 *      `partitions[i]` equals the minimum key of subtree `nodes[i+1]` ("partition[0] refers to the
 *      lowest key in nodes[1]", src/nodes.ts).
 *   5. Global order — a full in-order traversal yields strictly increasing keys (no drops, no repeats).
 *   6. Bidirectional agreement — `ascending(first())` keys === reverse of `descending(last())` keys
 *      === the in-order key list.
 *   7. Count — `getCount()` equals the number of entries reached by traversal.
 */
export function assertTreeInvariants<TKey, TEntry>(tree: BTree<TKey, TEntry>, opts: InvariantOptions = {}): void {
	const allowUnderfilledRoot = opts.allowUnderfilledRoot ?? true;
	const anyTree = tree as any;
	const root = anyTree['_root'] as TreeNode<TKey, TEntry> | undefined;
	const base = anyTree['base'] as BTree<TKey, TEntry> | undefined;
	const compare = anyTree['compare'] as (a: TKey, b: TKey) => number;
	const keyFromEntry = anyTree['keyFromEntry'] as (entry: TEntry) => TKey;

	if (!root) {
		// A copy-on-write child with no local writes defers entirely to its base; structural validation
		// of that shared structure belongs to the base's own check (and to the COW ownership helper).
		if (base) {
			throw new Error('assertTreeInvariants: tree has no local root (defers to a base); validate the base directly');
		}
		// Otherwise the root is lazily uninitialised, i.e. a fresh empty tree. Confirm it presents as
		// empty in both directions and with a zero count, then accept it.
		if (tree.first().on || tree.last().on || tree.getCount() !== 0) {
			throw new Error('assertTreeInvariants: _root is unset but the tree is not empty');
		}
		return;
	}
	if (typeof compare !== 'function' || typeof keyFromEntry !== 'function') {
		throw new Error('assertTreeInvariants: could not reach compare/keyFromEntry on the tree');
	}

	const leafDepths = new Set<number>();
	const orderedKeys: TKey[] = [];	// full in-order key list, built during recursion (rule 5)

	function checkFill(count: number, isRoot: boolean, isLeaf: boolean, path: string): void {
		const kind = isLeaf ? 'leaf' : 'branch';
		const unit = isLeaf ? 'entries' : 'children';
		if (count > NodeCapacity) {
			throw new Error(`Fill violation (rule 2) at ${kind} ${path}: ${count} ${unit} exceeds NodeCapacity (${NodeCapacity}).`);
		}
		if (!isRoot && count < MinFill) {
			throw new Error(`Fill violation (rule 2) at ${kind} ${path}: ${count} ${unit} below minimum fill (${MinFill}).`);
		}
		if (isRoot && !allowUnderfilledRoot && count < MinFill) {
			throw new Error(`Fill violation (rule 2) at root ${kind} ${path}: ${count} ${unit} below minimum fill (${MinFill}) with allowUnderfilledRoot=false.`);
		}
	}

	// Validates the subtree rooted at `node` and returns its [min, max] key, or null for an empty leaf
	// (only legal at the root of an empty tree).
	function recurse(node: TreeNode<TKey, TEntry>, depth: number, isRoot: boolean, path: string): { min: TKey, max: TKey } | null {
		if (node instanceof LeafNode) {
			leafDepths.add(depth);
			const entries = node.entries as TEntry[];
			checkFill(entries.length, isRoot, true, path);
			if (entries.length === 0) {
				return null;	// empty leaf: only valid for the root of an empty tree
			}
			let min!: TKey;
			let max!: TKey;
			for (let i = 0; i < entries.length; i++) {
				const key = keyFromEntry(entries[i]);
				// Rule 5: a single running check across all leaves covers within-leaf order and cross-leaf seams.
				if (orderedKeys.length > 0 && compare(orderedKeys[orderedKeys.length - 1], key) >= 0) {
					throw new Error(`Order violation (rule 5) at leaf ${path}[${i}]: key ${describeKey(key)} is not strictly greater than prior key ${describeKey(orderedKeys[orderedKeys.length - 1])}.`);
				}
				if (i === 0) {
					min = key;
				}
				max = key;
				orderedKeys.push(key);
			}
			return { min, max };
		}

		if (node instanceof BranchNode) {
			const branch = node;
			// Rule 3: shape
			if (branch.partitions.length !== branch.nodes.length - 1) {
				throw new Error(`Shape violation (rule 3) at branch ${path}: partitions.length (${branch.partitions.length}) !== nodes.length - 1 (${branch.nodes.length - 1}).`);
			}
			// Rule 2: fill bounds on child count
			checkFill(branch.nodes.length, isRoot, false, path);
			if (isRoot && branch.nodes.length < 2) {
				throw new Error(`Structure violation (rule 2) at root branch ${path}: a root branch must have >= 2 children but has ${branch.nodes.length}.`);
			}

			const childBounds: ({ min: TKey, max: TKey } | null)[] = [];
			for (let i = 0; i < branch.nodes.length; i++) {
				childBounds.push(recurse(branch.nodes[i], depth + 1, false, `${path}.${i}`));
			}

			// Rule 4: partition separation
			for (let i = 0; i < branch.partitions.length; i++) {
				const left = childBounds[i];
				const right = childBounds[i + 1];
				if (!left || !right) {
					throw new Error(`Partition violation (rule 4) at branch ${path}: subtree adjacent to partition[${i}] is empty.`);
				}
				const p = branch.partitions[i];
				// Every key in nodes[i] < partitions[i]; max of the (sorted) left subtree suffices.
				if (compare(left.max, p) >= 0) {
					throw new Error(`Partition violation (rule 4) at branch ${path}: max key of nodes[${i}] (${describeKey(left.max)}) is not < partition[${i}] (${describeKey(p)}).`);
				}
				// partitions[i] === minimum key of nodes[i+1].
				if (compare(p, right.min) !== 0) {
					throw new Error(`Partition violation (rule 4) at branch ${path}: partition[${i}] (${describeKey(p)}) does not equal the minimum key of nodes[${i + 1}] (${describeKey(right.min)}).`);
				}
			}

			const first = childBounds.find(b => b !== null);
			let last: { min: TKey, max: TKey } | null = null;
			for (let i = childBounds.length - 1; i >= 0; i--) {
				if (childBounds[i]) {
					last = childBounds[i];
					break;
				}
			}
			if (!first || !last) {
				throw new Error(`Structure violation at branch ${path}: branch subtree contains no entries.`);
			}
			return { min: first.min, max: last.max };
		}

		throw new Error(`Unknown node type at ${path}: ${Object.prototype.toString.call(node)}.`);
	}

	recurse(root, 0, true, 'root');

	// Rule 1: uniform leaf depth
	if (leafDepths.size > 1) {
		throw new Error(`Depth violation (rule 1): leaves occur at differing depths {${[...leafDepths].sort((a, b) => a - b).join(', ')}}.`);
	}

	// Rules 6 & 7 use the public navigation API. ascending()/descending() mutate and re-yield the same
	// path object, so the key must be read inside the loop (never spread into an array).
	const ascKeys: TKey[] = [];
	for (const p of tree.ascending(tree.first())) {
		const impl = asImpl(p);
		ascKeys.push(keyFromEntry(impl.leafNode.entries[impl.leafIndex]));
	}
	const descKeys: TKey[] = [];
	for (const p of tree.descending(tree.last())) {
		const impl = asImpl(p);
		descKeys.push(keyFromEntry(impl.leafNode.entries[impl.leafIndex]));
	}

	// Rule 6: ascending() === in-order key list
	if (ascKeys.length !== orderedKeys.length) {
		throw new Error(`Traversal mismatch (rule 6): ascending() yielded ${ascKeys.length} keys but the in-order structure has ${orderedKeys.length}.`);
	}
	for (let i = 0; i < orderedKeys.length; i++) {
		if (compare(ascKeys[i], orderedKeys[i]) !== 0) {
			throw new Error(`Traversal mismatch (rule 6) at index ${i}: ascending() key ${describeKey(ascKeys[i])} !== in-order key ${describeKey(orderedKeys[i])}.`);
		}
	}
	// Rule 6: reverse of descending() === in-order key list
	if (descKeys.length !== orderedKeys.length) {
		throw new Error(`Traversal mismatch (rule 6): descending() yielded ${descKeys.length} keys but the in-order structure has ${orderedKeys.length}.`);
	}
	for (let i = 0; i < orderedKeys.length; i++) {
		const mirrored = descKeys[descKeys.length - 1 - i];
		if (compare(mirrored, orderedKeys[i]) !== 0) {
			throw new Error(`Bidirectional mismatch (rule 6) at index ${i}: descending() (reversed) key ${describeKey(mirrored)} !== ascending key ${describeKey(orderedKeys[i])}.`);
		}
	}

	// Rule 7: count
	const count = tree.getCount();
	if (count !== orderedKeys.length) {
		throw new Error(`Count violation (rule 7): getCount() returned ${count} but traversal found ${orderedKeys.length} entries.`);
	}
}

// ---------------------------------------------------------------------------------------------------
// COW ownership invariant (Inheritree-specific)
// ---------------------------------------------------------------------------------------------------
//
// Every node carries a `.tree` owner (src/nodes.ts). A copy-on-write child `new BTree(keyFn, cmp, base)`
// shares its base's nodes until it needs to mutate one, at which point it clones the target and re-links
// the clone rootward (`mutableLeaf`/`mutableBranch`/`replaceRootward`, src/b-tree.ts). The escaped
// COW-delete bug left "an owned ancestor pointing at a stale base node" — i.e. the clone-rootward
// linkage came apart. These helpers encode the structural rules that linkage must satisfy.

/** A snapshot of a base tree captured *before* a COW child mutates, used to prove the base was untouched.
 * Obtain one from {@link snapshotBase}; feed it to {@link assertOwnershipInvariant} after the child's ops. */
export interface BaseSnapshot<TKey> {
	/** The base's full ordered key list at snapshot time. */
	readonly keys: readonly TKey[];
	/** Identities of every node reachable from the base's root at snapshot time. COW must never add,
	 * drop, or replace any of these. */
	readonly nodes: ReadonlySet<ITreeNode>;
}

/** Collects the set of node object identities reachable from `root` (inclusive).
 * The `seen` guard means an accidentally aliased/cyclic linkage is recorded once rather than looping. */
function collectReachableNodes(root: ITreeNode | undefined): Set<ITreeNode> {
	const seen = new Set<ITreeNode>();
	if (!root) {
		return seen;
	}
	const stack: ITreeNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (seen.has(node)) {
			continue;
		}
		seen.add(node);
		if (node instanceof BranchNode) {
			for (const child of (node as BranchNode<unknown, unknown>).nodes) {
				stack.push(child);
			}
		}
	}
	return seen;
}

/** Reads a tree's full ordered key list via the public ascending cursor (key-type-agnostic). */
function orderedKeysOf<TKey, TEntry>(tree: BTree<TKey, TEntry>): TKey[] {
	const keyFromEntry = (tree as any)['keyFromEntry'] as (entry: TEntry) => TKey;
	const keys: TKey[] = [];
	// ascending() re-yields one mutated path object, so the key must be read inside the loop.
	for (const p of tree.ascending(tree.first())) {
		const impl = asImpl(p);
		keys.push(keyFromEntry(impl.leafNode.entries[impl.leafIndex]));
	}
	return keys;
}

/** Captures the base's ordered keys and reachable-node identities for a later immutability assertion.
 * Call this *before* the COW child performs the operations under test. */
export function snapshotBase<TKey, TEntry>(base: BTree<TKey, TEntry>): BaseSnapshot<TKey> {
	return { keys: orderedKeysOf(base), nodes: collectReachableNodes(base.root) };
}

/** Every node identity reachable from a tree's *effective* root (the public `root` getter, which falls
 * through a COW child to its base). The companion to {@link sharedReachableNodes} for structural-sharing
 * assertions — e.g. proving that `clearBase` does (or does not) leave nodes shared with the former base. */
export function reachableNodesOf<TKey, TEntry>(tree: BTree<TKey, TEntry>): Set<ITreeNode> {
	return collectReachableNodes(tree.root);
}

/**
 * The node identities reachable from BOTH trees' effective roots — i.e. the structure they physically share.
 *
 * Copy-on-write only clones nodes along a *mutated* path; untouched subtrees stay shared by identity. So a
 * derived child shares part of its base's structure, and — because `clearBase` merely drops the base pointer
 * rather than deep-copying — a *flattened* child can still share untouched nodes with its former base. A
 * non-empty result is exactly why a base (or former base) must be treated as frozen while such sharing is
 * live: mutating a shared node in place corrupts the other tree's view of it.
 */
export function sharedReachableNodes<TKey, TEntry>(a: BTree<TKey, TEntry>, b: BTree<TKey, TEntry>): ITreeNode[] {
	const aNodes = collectReachableNodes(a.root);
	const shared: ITreeNode[] = [];
	for (const node of collectReachableNodes(b.root)) {
		if (aNodes.has(node)) {
			shared.push(node);
		}
	}
	return shared;
}

/**
 * Validates the copy-on-write ownership invariants of a child tree against its base, throwing on the
 * first violation. This targets the COW-delete bug class ("an owned ancestor keeps pointing at a stale
 * base node"): it proves the child's mutable spine is a connected, base-disjoint region and — when a
 * pre-mutation {@link BaseSnapshot} is supplied — that the base was left untouched.
 *
 * Checks:
 *   1. Upward-closed ownership (connectivity). Traversing from `child.root`, once you step through a node
 *      not owned by `child` (into base territory), no descendant may be owned by `child`. A child-owned
 *      node beneath a base-owned ancestor means a clone was grafted below shared structure / a base node
 *      was aliased into the child's mutable spine — the spine is no longer connected from the root.
 *   2. No shared *mutable* node. A node the child can mutate (child-owned) must never also be reachable
 *      from `base.root`; otherwise a child write would corrupt the base in place.
 *   3. Base immutability (only when `snapshot` is provided). The base's ordered keys and its reachable-node
 *      identities must match the pre-mutation snapshot, and — when the base owns a local root — its
 *      structure must still satisfy `assertTreeInvariants`. An unwritten intermediate base (a multi-level
 *      chain `base -> c1 -> c2 ...`, validating `c2` against an untouched `c1`) has no local root and is
 *      validated by identity/keys alone; its structure is its own base's invariant.
 *
 * Reaches the child's and base's roots through the public `root` getter and node `.tree` owners, so it is
 * key-type-agnostic. Note that the dropped-write manifestation of the original bug (an *orphaned*,
 * unreachable clone) is caught functionally by `assertTreeInvariants(child)` plus the base-immutability
 * check here — pair the two in COW tests.
 */
export function assertOwnershipInvariant<TKey, TEntry>(
	child: BTree<TKey, TEntry>,
	base: BTree<TKey, TEntry>,
	snapshot?: BaseSnapshot<TKey>,
): void {
	const childRoot = child.root;
	const baseRoot = base.root;

	// --- Check 1: ownership is upward-closed from the child's root (connectivity). ---
	const visitConnectivity = (node: ITreeNode, crossedToBase: boolean, path: string): void => {
		const childOwned = node.tree === child;
		if (crossedToBase && childOwned) {
			throw new Error(
				`Ownership violation (connectivity) at ${path}: a node owned by the child is reachable beneath a base-owned ancestor; the copy-on-write spine must be connected from the root.`,
			);
		}
		const nowCrossed = crossedToBase || !childOwned;
		if (node instanceof BranchNode) {
			const nodes = (node as BranchNode<TKey, TEntry>).nodes;
			for (let i = 0; i < nodes.length; i++) {
				visitConnectivity(nodes[i], nowCrossed, `${path}.${i}`);
			}
		}
	};
	visitConnectivity(childRoot, false, 'child.root');

	// --- Check 2: no shared *mutable* node. ---
	const baseReachable = collectReachableNodes(baseRoot);
	const visitShared = (node: ITreeNode, path: string): void => {
		if (node.tree === child && baseReachable.has(node)) {
			throw new Error(
				`Ownership violation (shared mutable node) at ${path}: a child-owned node is also reachable from the base; a child write would mutate the base in place.`,
			);
		}
		if (node instanceof BranchNode) {
			const nodes = (node as BranchNode<TKey, TEntry>).nodes;
			for (let i = 0; i < nodes.length; i++) {
				visitShared(nodes[i], `${path}.${i}`);
			}
		}
	};
	visitShared(childRoot, 'child.root');

	// --- Check 3: base immutability (only when a pre-mutation snapshot was supplied). ---
	if (snapshot) {
		// Structural re-validation of the base is only meaningful (and only possible) when the base owns a
		// local root. An *unwritten* COW child used as a base (multi-level chain: base -> c1 -> c2 ...,
		// validating c2 against an untouched c1) defers entirely to its own base, so assertTreeInvariants
		// would throw "no local root"; its structure is that base's invariant, not this one's. Immutability
		// is still proven below via the effective-root key list and reachable-node identities.
		if ((base as any)['_root']) {
			assertTreeInvariants(base);
		}
		const compare = (base as any)['compare'] as (a: TKey, b: TKey) => number;
		const currentKeys = orderedKeysOf(base);
		if (currentKeys.length !== snapshot.keys.length) {
			throw new Error(
				`Base mutation detected: base now has ${currentKeys.length} keys but ${snapshot.keys.length} were snapshotted before the child mutated.`,
			);
		}
		for (let i = 0; i < currentKeys.length; i++) {
			if (compare(currentKeys[i], snapshot.keys[i]) !== 0) {
				throw new Error(
					`Base mutation detected at key index ${i}: base key ${describeKey(currentKeys[i])} !== snapshotted key ${describeKey(snapshot.keys[i])}.`,
				);
			}
		}
		// Identity: COW must never add, drop, or replace a base node.
		const currentNodes = collectReachableNodes(base.root);
		if (currentNodes.size !== snapshot.nodes.size) {
			throw new Error(
				`Base mutation detected: base reachable-node count changed from ${snapshot.nodes.size} to ${currentNodes.size}.`,
			);
		}
		for (const node of currentNodes) {
			if (!snapshot.nodes.has(node)) {
				throw new Error('Base mutation detected: a node reachable from base was absent from the pre-mutation snapshot (base structure was rewritten).');
			}
		}
	}
}
