description: Decide whether to make the tree library actively prevent (or safely support) changing a base tree while copies derived from it are still being used, instead of only warning about it in the docs.
prereq:
files: src/b-tree.ts, test/b-tree.cow-clearbase.test.ts, readme.md
difficulty: hard
----
Copy-on-write derived trees read any un-modified node **directly from their base** (`BTree.root`,
`src/b-tree.ts`), and clone nodes only along a mutated path. Two hazards fall out of this and are currently
**documented but not enforced** (readme.md "Base immutability contract"; doc comments on `clearBase` and the
`base` constructor param):

1. **Mutating a base while a derived child is live** corrupts the child's view of every node it still shares
   with that base.
2. **`clearBase()` does not isolate at scale.** It is a cheap pointer drop, not a deep copy, so a flattened
   child still shares untouched subtrees with its former base by identity — and once detached neither side
   copies-on-write any longer, so a structural write to a shared node mutates it in place for both.

Ticket `cow-clearbase-and-base-contract` pinned this *current, unguarded* behavior with regression tests
(`test/b-tree.cow-clearbase.test.ts`, the "pinned hazards" group) and deliberately left enforcement out of
scope. The existing readme "Help wanted" note ("need version checking against base") gestures at the same
gap. This ticket is to decide and (if approved) build the enforcement/support.

## What to decide

Pick one (or a combination) — this is a real design choice, not a one-liner:

- **(a) Runtime guard.** Make the base aware it has derived children (child registration/refcount, or a
  base version stamped into each derived child and checked on base mutation) and throw when a base is mutated
  while derived children are live. Touches the hot mutation path; needs new state because children currently
  reference the base, not vice-versa.
- **(b) Truly-isolating `clearBase`.** A variant (or new method) that deep-copies the still-shared nodes (or
  rebuilds fresh) so the result is genuinely independent of the former base. More expensive; changes the
  cost model callers may rely on.
- **(c) Stay doc-only.** Accept the contract as documented and close this out.

## Acceptance

- A decision recorded for (a)/(b)/(c).
- If (a) or (b): implementation + tests, and the pinned-hazard assertions in
  `test/b-tree.cow-clearbase.test.ts` updated to reflect the new (guarded/isolated) behavior — that flip is
  the intended, visible diff, not a regression. Update readme.md and the `clearBase`/`base` doc comments to
  match.
- If (c): note the rationale and remove the "Help wanted" version-checking TODO (or keep it intentionally).
