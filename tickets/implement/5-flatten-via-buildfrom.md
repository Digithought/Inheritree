----
description: Add a method that produces a genuinely independent copy of a tree in one efficient pass, giving users a safe alternative to the current slow manual workaround.
prereq:
files: src/b-tree.ts (clearBase, new flatten()), readme.md ("Base immutability contract")
difficulty: easy
----
The `clearBase()` method is honest in its documentation about a sharing hazard: after it runs, the tree may still share nodes with its former base, so mutating one can affect the other. The documented workaround is to build a fresh tree and re-insert every entry, which costs O(n log n) for something the library can do in O(n): walk the tree once and clone every node not already owned by this tree.

The recent upstream merge supplies the implementation almost for free. Upstream's `buildFrom` is exactly the O(n) bottom-up bulk loader that a `flatten()` method needs. The core of the method is `BTree.buildFrom(this.entries(), this.keyFromEntry, this.compare)`, plus carrying over this tree's `freeze` and `checkComparator` options so the result behaves identically.

Adding `flatten()` gives users an explicit, efficient, genuine-isolation option and closes the base-immutability guard's blind spot after `clearBase()` for users who choose to flatten.

## Edge cases & interactions

- Preserve the `freeze` and `checkComparator` options on the flattened tree so it behaves identically to the original.
- Empty tree: `flatten()` returns a valid, independent empty tree.
- Tree with no base: `flatten()` still returns an independent copy (it does not assume a base exists).
- Isolation guarantee: the result must share no nodes by identity with the former base; a test should verify node-identity disjointness, not just value equality.
- Update the readme's base immutability contract to present `flatten()` as the safe genuine-isolation option alongside `clearBase()`.

## TODO

- [ ] Implement `flatten()` in src/b-tree.ts using `BTree.buildFrom(this.entries(), this.keyFromEntry, this.compare)` as the core.
- [ ] Carry over the `freeze` and `checkComparator` options to the flattened tree.
- [ ] Handle empty trees and trees with no base.
- [ ] Add tests: value equality with the source, and node-identity disjointness from the former base.
- [ ] Update readme.md's "Base immutability contract" section to document `flatten()` as the safe isolation option and contrast it with `clearBase()`.
