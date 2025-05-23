import { BranchNode, LeafNode, type ITreeNode } from "./nodes.js";

export class PathBranch<TKey> {
	constructor (
			public node: BranchNode<TKey>,
			public index: number,
	) {}

	clone() {
			return new PathBranch(this.node, this.index);
	}
}

/** Represents a cursor in a BTree.  Invalid once mutation has occurred (unless it is the results of a mutation method).
 * Do not change the properties of this object directly.  Use the methods of the BTree class to manipulate it.
 * @member on - true if the cursor is on an entry, false if it is between entries.
 */
export class Path<TKey, TEntry> {
	constructor(
			public branches: PathBranch<TKey>[],
			public leafNode: LeafNode<TEntry>,
			public leafIndex: number,
			public on: boolean,
			public version: number,
	) { }

	isEqual(path: Path<TKey, TEntry>) {
			return this.leafNode === path.leafNode
					&& this.leafIndex === path.leafIndex
					&& this.on === path.on
					&& this.version === path.version;
	}

	clone() {
			return new Path(this.branches.map(b => b.clone()), this.leafNode, this.leafIndex, this.on, this.version);
	}

	/* Update any of the nodes in this path based on the given mapping. */
	remap(map: Map<ITreeNode, ITreeNode>) {
		this.branches.forEach(b => {
			b.node = map.get(b.node) as BranchNode<TKey> ?? b.node;
		});
		this.leafNode = map.get(this.leafNode) as LeafNode<TEntry> ?? this.leafNode;
	}
}
