import type { BTree } from "./b-tree.js"; // For BTree type

// Note: used to store isLeaf flag in each node thinking that instanceof might be slower; V8 benchmark showed instanceof to be 5x faster
export interface ITreeNode {
	// Reference to the BTree instance that owns this node. Optional: every node created through
	// real tree operations (insert/clone) carries an owner, which copy-on-write consults to decide
	// whether a node must be cloned before mutation. Manually-constructed nodes in non-COW tests
	// have no owner, and none is needed there (the owner is only read when a base tree exists).
	tree?: BTree<any, any>;
	clone(newTree: BTree<any, any>): ITreeNode;
}

export class LeafNode<TEntry> implements ITreeNode {
	constructor(
		public entries: TEntry[],
		public tree?: BTree<any, any> // Owner; populated for all nodes created by tree operations (see ITreeNode.tree)
	) { }

	clone(newTree: BTree<any, any>): LeafNode<TEntry> {
		return new LeafNode(structuredClone(this.entries), newTree);
	}
}

export class BranchNode<TKey> implements ITreeNode {
	constructor(
		public partitions: TKey[],	// partition[0] refers to the lowest key in nodes[1]
		public nodes: ITreeNode[],  // has one more entry than partitions, since partitions split nodes
		public tree?: BTree<any, any> // Owner; populated for all nodes created by tree operations (see ITreeNode.tree)
	) { }

	clone(newTree: BTree<any, any>): BranchNode<TKey> {
		return new BranchNode(structuredClone(this.partitions), [...this.nodes], newTree);
	}
}
