----
description: Each stored node points back at the whole tree object it belongs to just to answer a simple yes/no ownership question, which quietly keeps large amounts of related tree data alive in memory longer than needed — consider giving each tree a lightweight identity tag instead.
prereq:
files: src/nodes.ts, src/b-tree.ts
difficulty: medium
----
Node ownership is decided purely by identity: a node belongs to a tree when `node.tree === this`. But to
answer that O(1) question each node holds a reference to the entire `BTree` object — which drags along the
comparator and key-extractor closures and, transitively, the **whole base chain** of tree objects. Because
a shared node keeps its owning tree reachable, that base chain survives `clearBase()` for as long as any
shared node from it is still alive. The ownership check needs one bit of identity; it currently retains a
whole object graph.

## Proposal

Give each tree a dedicated ownership token — `readonly owner = Symbol()` per tree — and have nodes store
and compare that token instead of the tree:

- Ownership check becomes `node.owner === this.owner` — still O(1), same semantics.
- Nodes no longer reference `BTree` instances, so they stop pinning comparators, key-extractors, and the
  base chain. A cleared child can actually free its former base chain once its own shared nodes are the
  only thing that was holding it.
- Removes the `BTree<any, any>` type erasure currently forced into `nodes.ts` (nodes needn't name the
  tree type at all), improving type cleanliness and decoupling the two modules.

## Merge wrinkle

The merge changed `clear()` so it now creates an owner-stamped fresh root and drops the base — so a
cleared child already frees its chain. The token design would make that outcome *structural* (a cleared
child cannot retain its base chain, because nodes never pointed at trees to begin with) rather than merely
*correct-by-current-implementation*. It removes a class of retention reasoning instead of getting it right
case by case.

## What to evaluate

This is a design proposal, not a code task — weigh the benefit against the churn:

- **Benefit:** memory retention (base chains and closures released promptly once nodes no longer pin
  them) plus type cleanliness (drop `BTree<any,any>` from `nodes.ts`).
- **Cost:** a token must be threaded through every node construction and every clone signature; ownership
  checks across the codebase switch from `node.tree` to `node.owner`.

## What changes (enumerate for the decision)

- **Node fields:** replace the `tree` back-reference with an `owner` symbol field on `LeafNode` and
  `BranchNode`.
- **Clone signatures:** `LeafNode.clone` / `BranchNode.clone` (and any node constructor) currently take
  `newTree`; they would take/stamp `newOwner` instead.
- **Ownership checks:** every `node.tree === this` site in `src/b-tree.ts` becomes an `owner`-token
  comparison.
- **Type surface:** `nodes.ts` loses its dependency on the `BTree` type and its `<any, any>` erasure.

## Edge cases & interactions

- **Interaction with the shallow-clone fix.** Clone signatures are also touched by the entry
  shallow-copy change; sequence or coordinate the two so clone signatures are edited once, not twice.
- **What still needs the tree.** Confirm no node method genuinely requires the comparator/key-extractor
  (i.e. that ownership is the *only* reason nodes hold `tree`); if a node ever needs tree behavior,
  the token alone is insufficient and that path must pass the tree explicitly.
- **Base chain across multiple derivation levels.** Verify a multi-level chain (base → child → grandchild)
  releases correctly once tokens replace tree back-references, with no node accidentally still reaching a
  tree instance.
- **Token uniqueness/serialization.** `Symbol()` is unique per tree but not serializable — confirm no
  persistence or structured-clone path depends on the old `tree` reference or would need to round-trip the
  owner identity.
