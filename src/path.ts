import { BranchNode, LeafNode, type TreeNode } from "./nodes.js";

export class PathBranch<TKey, TEntry> {
	constructor (
			public node: BranchNode<TKey, TEntry>,
			public index: number,
	) {}

	clone() {
			return new PathBranch(this.node, this.index);
	}
}

/** Public, insulated view of a cursor in a BTree.  Exposes only what a consumer can safely touch; the
 * structural fields (branches / leafNode / leafIndex / version) live on the concrete {@link PathImpl} and
 * are deliberately kept off this interface so they can't be corrupted by accident.  A path is invalid once
 * the tree has been mutated (unless it is itself the result of a mutation method) - see {@link BTree.isValid}.
 * @member on - true if the cursor is on an entry, false if it is between entries ("in a crack").
 */
export interface Path<TKey, TEntry> {
	/** true if the cursor is on an entry; false if it sits in a "crack" between entries. */
	readonly on: boolean;
	/** @returns true if the other path is positioned identically (same leaf, index, on-state and tree version). */
	isEqual(other: Path<TKey, TEntry>): boolean;
	/** @returns an independent copy of this path (mutating one does not affect the other). */
	clone(): Path<TKey, TEntry>;
}

/** Concrete cursor implementation.  Exported from this module for internal use by BTree (and white-box tests),
 * but intentionally NOT re-exported on the package's public surface - consumers see only the {@link Path}
 * interface.  Do not change the properties of this object directly; use the methods of the BTree class.
 */
export class PathImpl<TKey, TEntry> implements Path<TKey, TEntry> {
	constructor(
			public branches: PathBranch<TKey, TEntry>[],
			public leafNode: LeafNode<TEntry>,
			public leafIndex: number,
			public on: boolean,
			public version: number,
	) { }

	isEqual(other: Path<TKey, TEntry>): boolean {
			const path = other as PathImpl<TKey, TEntry>;
			return this.leafNode === path.leafNode
					&& this.leafIndex === path.leafIndex
					&& this.on === path.on
					&& this.version === path.version;
	}

	clone(): PathImpl<TKey, TEntry> {
			return new PathImpl(this.branches.map(b => b.clone()), this.leafNode, this.leafIndex, this.on, this.version);
	}

	/* Update any of the nodes in this path based on the given mapping (Inheritree-specific: applied
	 * after copy-on-write clones replace shared nodes along this path's spine). */
	remap(map: Map<TreeNode<TKey, TEntry>, TreeNode<TKey, TEntry>>) {
		this.branches.forEach(b => {
			b.node = map.get(b.node) as BranchNode<TKey, TEntry> ?? b.node;
		});
		this.leafNode = map.get(this.leafNode) as LeafNode<TEntry> ?? this.leafNode;
	}
}
