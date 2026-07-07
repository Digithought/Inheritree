// Note: used to store isLeaf flag in each node thinking that instanceof might be slower; V8 benchmark showed instanceof to be 5x faster
export type TreeNode<TKey, TEntry> = LeafNode<TEntry> | BranchNode<TKey, TEntry>;

export class LeafNode<TEntry> {
	constructor(
		public entries: TEntry[],
	) { }
}

export class BranchNode<TKey, TEntry> {
	constructor(
		public partitions: TKey[],	// partition[0] refers to the lowest key in nodes[1]
		public nodes: TreeNode<TKey, TEntry>[],  // has one more entry than partitions, since partitions split nodes
	) { }
}
