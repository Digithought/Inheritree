----
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

## Review finding F2 detail — a nearly-free version guard

The codebase already has the machinery to make option (a) cheap. Every tree maintains a `_version`, and
every public operation funnels through either `validatePath` or the root getter — so an O(1) guard can be
dropped onto those two chokepoints and cover every entry point. Concrete proposal:

    constructor(..., base?) { ...; this.baseVersion = base?.chainVersion() ?? 0; }

    // Version of this tree plus everything it inherits from (O(chain depth); chains are short)
    private chainVersion(): number {
      return this._version + (this.base ? this.base.chainVersion() : 0);
    }

    private checkBase() {
      if (this.base && this.base.chainVersion() !== this.baseVersion) throw new MutatedBaseError();
    }

Call `checkBase()` in the **root getter** and in **`isValid`**. Between them these cover every entry point:
a fresh operation resolves through the root getter, and navigation on an existing path goes through
`validatePath` → `isValid`. The recursive sum in `chainVersion()` handles multi-level chains (a mutation
anywhere up the base chain changes the total). Cost in the common single-level case is two integer
operations per public call — effectively free.

### Why the merge raises the stakes

The merge changed derivation so that a child's `_count` is now **seeded from the base at derivation time**.
That means a base-immutability violation is no longer merely a risk of *structural* corruption of shared
nodes — it now *also silently skews the child's O(1) `_count`*, even in cases where the shared nodes happen
to survive intact. The count drifts with no visible symptom. The version guard converts that silent,
data-dependent skew into a loud, immediate `MutatedBaseError` at the child's next operation.

### Two honest limitations to document

- **Detection is deferred to the child's *next* operation**, not raised at the moment the base is mutated.
  The base has no back-reference to its children, so the guard can only notice the stale version when the
  child is next used. This is a detect-late guard, not a prevent-at-mutation guard — document it as such.
- **The post-`clearBase()` obligation stays unguardable.** Once a child drops its base, there is no base
  version left to compare against, so the shared-subtree hazard from hazard #2 above is outside this guard's
  reach. The escape hatch there is a genuine `flatten()` / true-isolation option — that is option (b) above
  and belongs in a **separate ticket**, not this guard.

## Acceptance

- A decision recorded for (a)/(b)/(c).
- If (a) or (b): implementation + tests, and the pinned-hazard assertions in
  `test/b-tree.cow-clearbase.test.ts` updated to reflect the new (guarded/isolated) behavior — that flip is
  the intended, visible diff, not a regression. Update readme.md and the `clearBase`/`base` doc comments to
  match.
- If (a): tests must cover the deferred-detection semantics (error surfaces on the child's next op, not at
  base-mutation time), multi-level chains, and the seeded-`_count` skew case that the guard is specifically
  meant to catch.
- If (c): note the rationale and remove the "Help wanted" version-checking TODO (or keep it intentionally).

## Edge cases & interactions

- **Multi-level base chains** (base → child → grandchild): a mutation at any level must change
  `chainVersion()` for every descendant; verify the recursive sum catches a mutation two levels up.
- **Deferred detection window:** between a base mutation and the child's next operation the child holds a
  corrupted view with no error — document that this guard is detect-on-next-use, not prevent-on-mutation.
- **Post-`clearBase()`:** the guard cannot cover a detached child (no base version to compare); the
  true-isolation `flatten()` escape hatch is a separate ticket.
- **Seeded `_count` skew:** a violation that leaves shared nodes structurally intact but still corrupts the
  child's inherited count — the case the guard most needs to catch, and easy to miss without a targeted test.
- **Guard overhead on the hot path:** confirm the two-integer-op cost in the single-level case does not
  regress the mutation/read benchmarks.
