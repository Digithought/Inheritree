description: Added a fast, one-pass way to make a tree that's genuinely its own thing, no longer sharing hidden internal storage with any other tree.
prereq:
files: src/b-tree.ts (flatten(), buildFrom, clearBase), readme.md ("Base immutability contract", feature list), test/b-tree.flatten.test.ts
difficulty: easy
----
## What was built

`BTree.flatten()` (src/b-tree.ts, right before `freezeEntry`): walks this tree's entries once via `this.entries()` and rebuilds them into a fresh, standalone tree with `BTree.buildFrom(this.entries(), this.keyFromEntry, this.compare, { freeze: this._freeze, checkComparator: this._checkComparator })`. O(n) versus the documented O(n log n) build-fresh-and-re-insert workaround. Carries over `freeze` and `checkComparator`. Works for empty, base-less, and base-derived trees. readme.md gained a "Flatten" feature bullet plus a paragraph/snippet under "Base immutability contract" contrasting `flatten()` (genuine node isolation, O(n)) with `clearBase()` (cheap pointer-drop, still-shared structure).

## Review findings

Adversarial pass over commit f58b9e1. Build (`npm run build`) clean; full suite **304 passing** (was 303 + 1 test added this pass), no regressions.

**Correctness — checked, no defects.** `flatten()` is a thin wrapper over `BTree.buildFrom`. Verified `entries()` (src/b-tree.ts:483) yields strictly-ascending, duplicate-free entries — exactly `buildFrom`'s precondition — so the `UnsortedInputError` path is unreachable for any valid tree. `buildFrom` consumes the generator fully via `[...sorted]`. `keyFromEntry`, `compare`, `freeze`, `checkComparator` are all propagated; `BTreeOptions` has only those two options, so the flattened tree is behaviorally identical. Empty (n=0 early return in `buildFrom`), base-less, and base-derived inputs all handled.

**Node isolation — the load-bearing guarantee — confirmed real.** Tests assert by node *identity* (via `sharedReachableNodes`), not value equality: a narrowly-mutated base-derived child (verified base-sharing > 0 before flatten) yields zero shared nodes with both former base and source child, and later base mutation does not leak. This is the property `clearBase()` cannot offer.

**Minor finding — fixed inline (test coverage).** The options-carryover test proved only the `freeze:false` direction. A `flatten()` that hardcoded `freeze:false` would have passed it while silently dropping the safe default (`freeze:true`) — a real blind spot. Added a test asserting default carryover (`_freeze===true`, `_checkComparator===false`, and that `flat.get(1)` is frozen). test/b-tree.flatten.test.ts now has 6 tests.

**Entry-object sharing — observed, non-issue, no change.** The flattened tree shares entry *objects* by reference with the source; only *nodes* are isolated. This is library-wide convention (insert/buildFrom store the caller's object), and the readme states it precisely as "shares no node" — not "deep copy." Accurate as written; not filed and no comment added, since it is inherent behavior a reader meets everywhere in this library, not a `flatten`-specific surprise.

**No major findings; no new tickets filed. No tripwires recorded** — the change has no conditional/scale-dependent concern (it is a direct wrapper over the already-tested O(n) bulk loader; the O(n) claim rests on `buildFrom`, covered by test/b-tree.bulk-load.test.ts).

**Docs — verified current.** readme.md feature list, the "Base immutability contract" section, and the `flatten()`/`clearBase()` JSDoc all read coherently and reflect the shipped behavior (node isolation, option carryover, O(n) vs O(n log n)).
