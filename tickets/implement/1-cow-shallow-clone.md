description: When a copied tree first changes a shared piece of data, the library made a deep duplicate of the stored items, which could crash on ordinary data, quietly lose information, and behave inconsistently — a plain shallow copy is safer and faster; this fix has been applied and tested.
prereq:
files: src/nodes.ts (LeafNode.clone, BranchNode.clone), test/b-tree.cow-entry-sharing.test.ts
difficulty: easy
----
## What changed

`src/nodes.ts`: both `LeafNode.clone` and `BranchNode.clone` used `structuredClone` on their
stored arrays (`entries` / `partitions`), deep-copying every entry a leaf holds (up to 64) on
every copy-on-write clone. This broke prototypes on class-instance entries, threw
`DataCloneError` on function-bearing entries, broke `===` identity between base and derived
trees, and un-froze entries that `freezeEntry` had frozen on insert — all only on the leaf(s)
that happened to get copy-on-write cloned, so failures were data- and node-boundary-dependent.

Both `clone()` methods now do a plain shallow copy (`.slice()`) of the array, matching the
reference-sharing the rebalance/merge paths already rely on (entries are treated as immutable
by contract — frozen by default, and the readme forbids mutating an entry post-insert even
under `{ freeze: false }`).

```ts
// LeafNode
clone(newTree: BTree<any, any>): LeafNode<TEntry> {
	return new LeafNode(this.entries.slice(), newTree);
}

// BranchNode
clone(newTree: BTree<any, any>): BranchNode<TKey, TEntry> {
	return new BranchNode(this.partitions.slice(), [...this.nodes], newTree);
}
```

## Tests added

New file `test/b-tree.cow-entry-sharing.test.ts`, all forcing a COW leaf clone (derive a tree,
then write a *different* key so the leaf holding the entry under test gets cloned):

- class-instance entry keeps its prototype (methods/getters work) after the COW clone
- function-bearing entry no longer throws `DataCloneError` on clone
- entry identity holds: `derived.get(k) === base.get(k)` for an untouched entry in a cloned leaf
- entries stay frozen (`Object.isFrozen`) after clone under the default config
- under `{ freeze: false }`, entries are shared by reference (not deep-copied) between base and derived
- branch-level clone: multi-level tree (400 entries, forces a branch above leaves), untouched
  leaves keep base-identity entries after a sibling leaf clones

Ran full suite: `yarn test` → 316 passing, no regressions. No pre-existing failures encountered.

## Gaps / things review should double check

- Did not re-check every existing test for an implicit assumption that derived-tree entries were
  deep-independent from base (the ticket flagged this as a possible intended-visible-change, not
  a regression) — none surfaced as a failure in the full run, but worth a deliberate skim during
  review since a silent false-negative (a test that happens to still pass despite checking the
  wrong thing) wouldn't show up as red.
- `BranchNode.clone`'s `[...this.nodes]` (child-node array) was already a shallow copy before this
  fix and is unchanged — only `partitions` used `structuredClone` there. Confirmed via the
  multi-level test that child-node identity for un-cloned children still holds.
