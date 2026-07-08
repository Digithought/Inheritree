// Note: used to store isLeaf flag in each node thinking that instanceof might be slower; V8 benchmark showed instanceof to be 5x faster
export type TreeNode<TKey, TEntry> = LeafNode<TEntry> | BranchNode<TKey, TEntry>;

/** Type-erased node — any leaf or branch regardless of key/entry types.  Also the compatibility
 * alias for the pre-1.5 Inheritree exported name (before upstream introduced the `TreeNode` union). */
export type ITreeNode = TreeNode<any, any>;

// Owner token (Inheritree-specific): every node created through real tree operations
// (insert/clone/bulk load) carries its owning BTree's identity token (a per-tree `Symbol`), which
// copy-on-write consults to decide whether a node must be cloned before mutation (`node.owner ===
// tree.owner`). Carrying a bare token rather than the BTree itself keeps a shared node from pinning
// the whole owning tree — and, transitively, its entire base chain — alive; a cleared child cannot
// retain its base chain because nodes never point at trees to begin with. Manually-constructed nodes
// in non-COW tests have no owner, and none is needed there (the owner is only read when a base
// tree exists).
// NOTE: the token is a `Symbol()` — unique per tree and NOT serializable. There is no persistence path
// today, so nothing breaks. If serialization/structured-clone of nodes is ever added, the owner must be
// re-established on load (re-stamp reachable nodes with the loading tree's `owner`), not round-tripped.

export class LeafNode<TEntry> {
	constructor(
		public entries: TEntry[],
		public owner?: symbol // Owner token; populated for all nodes created by tree operations (see above)
	) { }

	clone(newOwner: symbol): LeafNode<TEntry> {
		// Shallow copy: entries are shared by reference across base/derived trees (same contract
		// as the rebalance/merge paths), only the array itself is duplicated for structural isolation.
		return new LeafNode(this.entries.slice(), newOwner);
	}
}

export class BranchNode<TKey, TEntry> {
	constructor(
		public partitions: TKey[],	// partition[0] refers to the lowest key in nodes[1]
		public nodes: TreeNode<TKey, TEntry>[],  // has one more entry than partitions, since partitions split nodes
		public owner?: symbol // Owner token; populated for all nodes created by tree operations (see above)
	) { }

	clone(newOwner: symbol): BranchNode<TKey, TEntry> {
		return new BranchNode(this.partitions.slice(), [...this.nodes], newOwner);
	}
}
