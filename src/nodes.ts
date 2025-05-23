import type { BTree } from "./b-tree.js"; // For BTree type

// Note: used to store isLeaf flag in each node thinking that instanceof might be slower; V8 benchmark showed instanceof to be 5x faster
export interface ITreeNode {
	// Reference to the BTree instance that owns this node
	tree: BTree<any, any>;
	clone(newTree: BTree<any, any>): ITreeNode;
}

export class LeafNode<TEntry> implements ITreeNode {
	constructor(
		public entries: TEntry[],
		public tree: BTree<any, any> // Pass owner on creation
	) { }

	clone(newTree: BTree<any, any>): LeafNode<TEntry> {
		return new LeafNode(structuredClone(this.entries), newTree);
	}
}

export class BranchNode<TKey> implements ITreeNode {
	constructor(
		public partitions: TKey[],	// partition[0] refers to the lowest key in nodes[1]
		public nodes: ITreeNode[],  // has one more entry than partitions, since partitions split nodes
		public tree: BTree<any, any> // Pass owner on creation
	) { }

	clone(newTree: BTree<any, any>): BranchNode<TKey> {
		return new BranchNode(structuredClone(this.partitions), [...this.nodes], newTree);
	}
}
