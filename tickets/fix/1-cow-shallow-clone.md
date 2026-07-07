----
description: When a copied tree first changes a shared piece of data, the library makes a deep duplicate of the stored items, which can crash on ordinary data, quietly lose information, and behave inconsistently — a plain shallow copy is both safer and faster.
prereq:
files: src/nodes.ts (LeafNode.clone, BranchNode.clone), test/ (new tests)
difficulty: easy
----
Copy-on-write derived trees share nodes with their base and clone a node only the first time a
derived tree writes to it. That per-node clone currently uses `structuredClone` on the stored data:

    clone(newTree) { return new LeafNode(structuredClone(this.entries), newTree); }

`structuredClone` deep-copies every entry (a leaf holds up to 64), and `BranchNode.clone` does the
same to `this.partitions`. This is wrong on four counts and slower than the correct approach.

## The defect

Four distinct problems, all empirically verified in Node:

1. **Throws on legal entries.** Any entry containing a function, symbol, or other non-cloneable value
   raises `DataCloneError` — but *only* when a derived tree happens to copy-on-write the leaf holding
   that entry. The very same entry works fine in a plain (underived) tree. So it surfaces as a
   data-dependent, late, hard-to-reproduce failure that depends on internal node boundaries the user
   cannot see.
2. **Silently strips prototypes.** A class-instance entry becomes a plain object in the derived tree:
   its methods and getters vanish. No error is raised — the derived tree just returns wrong data.
3. **Breaks entry identity.** After a copy-on-write clone of a leaf, `derived.get(k) !== base.get(k)`,
   yet for entries in leaves that were never cloned the two remain `===`. Identity-based user logic
   therefore behaves inconsistently, flipping on invisible internal node boundaries.
4. **Un-freezes entries.** `structuredClone` of a frozen object returns an *unfrozen* copy, undoing the
   protection `freezeEntry` applies on insert.

It is also internally inconsistent with the rest of the design. The rebalance/merge paths already move
base-owned entries into child-owned leaves **by reference** — so cross-tree entry sharing is already an
assumption the code relies on. And it is the slow option: a deep clone where a shallow copy suffices,
copying up to 64 entries per cloned leaf.

The `{ freeze: false }` option sharpens the contradiction: that config exists to request maximum speed,
entries are never frozen under it, yet `structuredClone` still pays the full deep-copy cost — the one
configuration asking to go fast gets the slowest possible clone.

## The fix

Shallow-copy the arrays instead:

- `LeafNode.clone`: `this.entries.slice()`
- `BranchNode.clone`: `this.partitions.slice()`

The tree treats entries as immutable by its own contract: entries are frozen by default, and even with
`{ freeze: false }` the readme forbids mutating an entry after insertion. Sharing entries by reference
across a base and its child is therefore exactly as safe as the reference-sharing the tree already does
everywhere else — the clone still gives each node its own array, so structural writes remain isolated;
only the entry *objects* are shared, which the contract already permits.

## Repro

Add tests that exercise a copy-on-write clone (derive a tree, then write into the leaf holding the
entry under test so that leaf is cloned) and assert:

- **Class-instance entries** keep their prototype: methods and getters still work when read from the
  derived tree after the cloning write.
- **Function-bearing entries** do not raise `DataCloneError` when their leaf is cloned.
- **Entry identity** holds across base and derived after a copy-on-write clone of that leaf
  (`derived.get(k) === base.get(k)` for an unchanged entry that merely lived in a now-cloned leaf).
- **Frozen-ness** of entries survives cloning under the default (frozen) config — entries read from a
  cloned leaf are still frozen.

## Edge cases & interactions

- **`{ freeze: false }` config.** Confirm entries are still shared by reference (not deep-copied) and
  that nothing in the tree mutates a shared entry object; the readme's no-post-insert-mutation contract
  is what makes this safe.
- **BranchNode partitions.** Apply the same shallow `slice()` and verify branch-level clones keep
  child-node identity where expected; partitions reference child nodes, whose ownership is still decided
  by the existing `node.tree === this` check.
- **Rebalance/merge by-reference paths.** These already share entries across trees; the fix makes leaf
  cloning consistent with them rather than introducing a new sharing assumption — verify no path relied
  on `structuredClone` having produced an independent copy.
- **Multiple derived trees off one base.** Deriving several children and having each write to overlapping
  vs. disjoint leaves should keep every child's structural changes isolated while entry objects stay
  shared by reference.
- **Deep vs. shallow expectation in existing tests.** Any existing test that (perhaps unintentionally)
  asserted derived-tree entries were deep-independent copies will flip; that flip is the intended,
  visible change, not a regression.
