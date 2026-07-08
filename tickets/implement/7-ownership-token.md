---
description: Tree nodes currently hold a reference to their whole owning tree just to answer a yes/no ownership question, which keeps large amounts of related data alive in memory longer than needed; give each tree a lightweight identity token and have nodes carry that instead.
prereq:
files: src/nodes.ts, src/b-tree.ts, test/helpers/invariants.ts, test/b-tree.cow-insert.test.ts, test/b-tree.cow-delete.test.ts, test/b-tree.cow-fork.test.ts, test/b-tree.cow-mutation-ops.test.ts, test/b-tree.cow-feature-matrix.test.ts, test/b-tree.cow-clearbase.test.ts, AGENTS.md
difficulty: medium
---
Replace the per-node back-reference to the owning `BTree` with a lightweight per-tree identity token.

## Why

A node decides ownership by identity: it belongs to a tree when `node.tree === this`. To answer that O(1)
question each `LeafNode`/`BranchNode` holds a reference to the entire `BTree` — which drags in the
comparator closure, the key-extractor closure, and transitively the **whole base chain** of tree objects.
Because a shared node keeps its owning tree reachable, that base chain survives `clearBase()`/`clear()` for
as long as any shared node from it is still alive. The ownership check needs one bit of identity; it
currently retains an object graph.

A dedicated token makes prompt release **structural** rather than correct-by-current-implementation: a
cleared child *cannot* retain its base chain because nodes never point at trees to begin with. It also
drops the `BTree<any, any>` type erasure `nodes.ts` is forced into today, decoupling the two modules
(this is the "F10" item in `doc/review.html`).

## Design (resolved — build as specified)

Give each tree a unique identity token and stamp nodes with it instead of the tree:

- **`BTree`** gains a public `readonly owner = Symbol()` field (a class-field initializer — runs before the
  constructor body, so it is available everywhere a node is created). It is the tree's identity token.
- **Nodes** replace `tree?: BTree<any, any>` with `owner?: symbol`. It stays *optional*: manually-built
  test nodes have no owner and need none (the owner is only read when a base tree exists).
- **Ownership check** becomes `node.owner === this.owner` — same O(1), same semantics.
- **Clone signature** `clone(newTree)` becomes `clone(newOwner: symbol)`; the stamp is `newOwner` instead
  of the tree.

**Visibility decision (documented tradeoff).** `owner` is *public* on both `BTree` and the node classes.
Rationale: the ownership invariant helper and ~40 test assertions compare a node's owner against a specific
tree; the minimal, readable translation is `node.owner === tree.owner`, which needs `tree.owner` reachable.
A `Symbol` exposes no internal state and cannot be usefully forged (nodes are already fully constructible in
tests), so the cost is one extra public field on `BTree` — accepted in exchange for keeping every ownership
assertion a plain identity comparison rather than a white-box `(tree as any)` reach-in.

### Interface sketch (`src/nodes.ts`)

```ts
// no BTree import needed anymore
export class LeafNode<TEntry> {
	constructor(
		public entries: TEntry[],
		public owner?: symbol,   // tree identity token; set for nodes created by tree operations
	) { }
	clone(newOwner: symbol): LeafNode<TEntry> {
		return new LeafNode(this.entries.slice(), newOwner);
	}
}

export class BranchNode<TKey, TEntry> {
	constructor(
		public partitions: TKey[],
		public nodes: TreeNode<TKey, TEntry>[],
		public owner?: symbol,
	) { }
	clone(newOwner: symbol): BranchNode<TKey, TEntry> {
		return new BranchNode(this.partitions.slice(), [...this.nodes], newOwner);
	}
}
```

`ITreeNode` / `TreeNode` unions are unchanged. `nodes.ts` drops `import type { BTree }` entirely.

## Edge cases & interactions

- **Every node-creation site must stamp `this.owner`, not `this`.** In `src/b-tree.ts` these are: the lazy
  root getter (`root`), `clear()`, `internalInsertAt` (root-split branch), `leafInsert` (split leaf),
  `branchInsert` (split branch), and `buildFrom` (leaf pack + branch levels — note `buildFrom` builds from a
  `tree` local, so stamp `tree.owner`). Miss one and a freshly-split node is unowned → COW re-clones it
  needlessly or, worse, an ownership check misfires.
- **Every ownership check + clone call in `src/b-tree.ts`.** Checks: `mutableLeaf` (`leaf.owner !== this.owner`),
  `mutableBranch` (`branch.owner === this.owner`), `replaceRootward` (`seg.node.owner === this.owner`). Clone
  calls: `leaf.clone(this.owner)`, `seg.node.clone(this.owner)`. The upward-closed-ownership fast path in
  `mutableBranch` (its `NOTE`) is preserved verbatim — same semantics, only the compared value changes.
- **Do NOT blindly rename every `.tree` in tests.** Several test files use a fixture object with a `.tree`
  *property that is itself a `BTree`* — `b-tree.options.test.ts` (`dflt.tree.find`, `checked.tree.find`) and
  `b-tree.perf-descent-range-end.test.ts` (`a.tree`, `b.tree`). Those are NOT node owner references and must
  be left untouched. Only `node.tree` (a `LeafNode`/`BranchNode`'s owner) becomes `node.owner`.
- **Assertions comparing owner to a tree instance flip to comparing tokens.** `expect(node.tree).to.equal(child)`
  → `expect(node.owner).to.equal(child.owner)`; `node.tree === owner` (the `countOwned` helper in
  `b-tree.cow-mutation-ops.test.ts`, where `owner` is a `BTree`) → `node.owner === owner.owner`. The
  invariant helper `assertOwnershipInvariant` (`test/helpers/invariants.ts`, checks 1 and 2) compares
  `node.tree === child` → `node.owner === child.owner`.
- **Multi-level base chain (base → child → grandchild).** After the change no node reaches a tree instance,
  so a cleared grandchild releases its whole chain structurally. The existing deep-chain tests
  (`b-tree.cow-fork.test.ts`, "deep chains") plus `assertOwnershipInvariant` at each level already exercise
  this; keep them green (they need the `.tree` → `.owner` translation, no new tests required for correctness,
  but see the retention test below).
- **Token uniqueness / serialization.** `Symbol()` is unique per tree and *not* serializable. Confirmed:
  the codebase has no persistence, `JSON`, or `structuredClone` path that round-trips a node's owner or the
  tree reference, so nothing breaks. Do not attempt to make the token serializable.
- **`clear()` / `clearBase()` retention.** `clear()` already stamps a fresh owner-token root and drops the
  base; `clearBase()` drops the base pointer. With tokens, neither can leave a live node pointing back at a
  tree object. This is the core benefit — worth a focused retention test (below).

## TODO

### Phase 1 — core change (`src/nodes.ts`, `src/b-tree.ts`)
- Add `readonly owner = Symbol()` public field to `BTree`.
- In `nodes.ts`: replace `tree?: BTree<any,any>` with `owner?: symbol` on both node classes; change
  `clone(newTree)` → `clone(newOwner: symbol)`; remove the `import type { BTree }` and refresh the header
  comment (it explains the owner reference).
- In `b-tree.ts`: update all node-creation sites to pass `this.owner` (or `tree.owner` in `buildFrom`);
  update the three ownership checks and two clone calls to token comparisons/`this.owner`.

### Phase 2 — tests & helpers
- `test/helpers/invariants.ts`: translate `node.tree === child` → `node.owner === child.owner` in
  `assertOwnershipInvariant` (checks 1 & 2); update the surrounding comments that describe the `.tree` owner.
- Translate `node.tree` reads and `.to.equal(tree)` owner assertions across the COW test files
  (`cow-insert`, `cow-delete`, `cow-fork`, `cow-mutation-ops`, `cow-feature-matrix`, `cow-clearbase`), plus
  `countOwned` in `cow-mutation-ops`. **Leave the fixture `.tree` properties in `options` and
  `perf-descent-range-end` untouched** (see edge cases).

### Phase 3 — retention proof (new, small)
- Add a test that proves the structural retention win: build a base, derive a child that shares (does not
  clone) at least one base node, `clearBase()` (or `clear()`) the child, drop the base reference, and assert
  the child's shared node no longer reaches any `BTree` — i.e. `node.owner` is a `symbol`, and there is no
  `.tree`/tree back-reference on the node. (A direct object-graph assertion, not a GC test — assert the node
  carries only a token, giving the "base chain can't be pinned by a node" guarantee a regression anchor.)

### Phase 4 — docs
- `AGENTS.md` line ~8: "each node carries an optional `tree` owner reference" → owner *token* wording.
- Optional: note the F10 item in `doc/review.html` as resolved (design change landed). Not required for the
  build; mention in the review handoff either way.

### Validate
- `yarn build` then `yarn test 2>&1 | tee /tmp/ownership-token-test.log` (stream, don't silently redirect).
  Expect the full COW suite green with the token translation. Confirm no leftover `node.tree` reads in `src/`
  or in translated tests (grep), and that the two fixture `.tree` properties remain.
