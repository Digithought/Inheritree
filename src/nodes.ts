import type { BTree } from "./b-tree.js"; // For BTree owner type (copy-on-write)

// Note: used to store isLeaf flag in each node thinking that instanceof might be slower; V8 benchmark showed instanceof to be 5x faster
export type TreeNode<TKey, TEntry> = LeafNode<TEntry> | BranchNode<TKey, TEntry>;

/** Type-erased node — any leaf or branch regardless of key/entry types.  Also the compatibility
 * alias for the pre-1.5 Inheritree exported name (before upstream introduced the `TreeNode` union). */
export type ITreeNode = TreeNode<any, any>;

// Owner reference (Inheritree-specific): every node created through real tree operations
// (insert/clone/bulk load) carries a reference to the BTree that owns it, which copy-on-write
// consults to decide whether a node must be cloned before mutation. Manually-constructed nodes
// in non-COW tests have no owner, and none is needed there (the owner is only read when a base
// tree exists).

export class LeafNode<TEntry> {
	constructor(
		public entries: TEntry[],
		public tree?: BTree<any, any> // Owner; populated for all nodes created by tree operations (see above)
	) { }

	clone(newTree: BTree<any, any>): LeafNode<TEntry> {
		// NOTE: structuredClone deep-copies entries and does NOT preserve Object.freeze, so entries a
		// copy-on-write child inherited-but-never-rewrote become UNFROZEN copies once their leaf is cloned.
		// The base keeps its own frozen originals (isolation holds); only the child's shallow freeze guard is
		// absent on those cloned neighbors. Fine today (freeze is best-effort/non-transitive per readme.md); if
		// the child-side freeze guard must survive cloning, re-freeze here under the owner's freeze option.
		return new LeafNode(structuredClone(this.entries), newTree);
	}
}

export class BranchNode<TKey, TEntry> {
	constructor(
		public partitions: TKey[],	// partition[0] refers to the lowest key in nodes[1]
		public nodes: TreeNode<TKey, TEntry>[],  // has one more entry than partitions, since partitions split nodes
		public tree?: BTree<any, any> // Owner; populated for all nodes created by tree operations (see above)
	) { }

	clone(newTree: BTree<any, any>): BranchNode<TKey, TEntry> {
		return new BranchNode(structuredClone(this.partitions), [...this.nodes], newTree);
	}
}
