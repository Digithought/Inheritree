description: Added a fast, one-pass way to make a tree that's genuinely its own thing, no longer sharing hidden internal storage with any other tree.
prereq:
files: src/b-tree.ts (flatten(), buildFrom, clearBase), readme.md ("Base immutability contract", feature list), test/b-tree.flatten.test.ts (new)
difficulty: easy
----
## What was built

`BTree.flatten()` (src/b-tree.ts, right before `freezeEntry`): walks this tree's entries once via `this.entries()` and rebuilds them into a fresh, standalone tree with `BTree.buildFrom(this.entries(), this.keyFromEntry, this.compare, { freeze: this._freeze, checkComparator: this._checkComparator })`. O(n), versus the documented O(n log n) "build fresh + re-insert every entry" workaround. Works identically whether the tree has a base or not, and on an empty tree (returns a valid, independent empty tree — `buildFrom` already handles n=0).

Carries over `freeze` and `checkComparator` from the source tree so the flattened tree behaves identically to the original on those two safety knobs.

readme.md: added a "Flatten" bullet to the top feature list, and a paragraph + code snippet under "Base immutability contract" contrasting `flatten()` (genuine isolation, O(n)) with `clearBase()` (cheap pointer-drop, still-shared structure) so a reader picks the right tool.

## Test coverage (test/b-tree.flatten.test.ts, 5 tests, all passing)

- Empty tree → valid independent empty tree, still insertable, doesn't affect the source.
- Base-less tree → flatten shares zero nodes (by identity, via the existing `sharedReachableNodes` helper from test/helpers/invariants.ts) with the source, values match, independently mutable.
- **The core isolation guarantee**: a child derived from a base, narrowly mutated (so most of its structure is still base-shared — confirmed via `sharedReachableNodes(child, base).length > 0` before flattening), is flattened; the result shares **zero** nodes with either the former base or the source child, and a subsequent structural mutation of the former base does not leak into the flattened copy (contrast with `clearBase()`, which is documented to still leak — see test/b-tree.cow-clearbase.test.ts).
- `freeze: false` / `checkComparator: true` options carry over (checked via the private `_freeze`/`_checkComparator` fields, matching the style other option tests in this repo use).
- Large multi-level tree (20 leaf-capacities' worth of entries): exact key/value reproduction, `assertTreeInvariants` passes.

Full suite: `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js "test/**/*.test.ts" --colors` → **303 passing**, no regressions, ~42s. `npm run build` (tsc) is clean.

## Use cases for a reviewer to probe

- Does `flatten()` on a tree with duplicate/unfrozen shared references between entries do anything surprising? (It shouldn't — `buildFrom` freezes per its own `freeze` option, same as any bulk load.)
- Confirm `flatten()` is not accidentally exposed as depending on tree structure beyond `entries()` — it should be agnostic to whether the tree came from a base, a bulk load, or plain inserts.
- The isolation test picks a specific narrow-mutation pattern (delete 3 + insert 2 keys) to leave most structure base-shared before flattening; a reviewer may want to fuzz this further (random op stream, like test/b-tree.cow-clearbase.test.ts's `driveOps`) for extra confidence, though the current test already proves the zero-shared-nodes property directly rather than by sampling.

## Known gaps / non-issues

- No dedicated perf/benchmark test proving the O(n) claim empirically (e.g. comparing op counts of `flatten()` vs. the old rebuild-and-reinsert workaround) — the complexity argument rests on `buildFrom`'s existing, separately-tested O(n) bulk-load behavior (test/b-tree.bulk-load.test.ts), which `flatten()` is a thin wrapper over.
- Did not add a runtime guard preventing misuse (e.g., calling `flatten()` doesn't need one — it has no sharp edges comparable to `clearBase()`'s). Nothing further seemed warranted here.
