description: Reads on a tree derived from a long chain of past versions used to get slower the longer that history grew; the fix caches the resolved root so repeat reads stay fast.
files: src/b-tree.ts (root getter, clearBase), test/b-tree.root-cache.test.ts
----
## What changed (code review finding F11)

A derived tree resolves its effective root by walking its `base` chain (`this.base.root`, recursively). Every
`find`/`get`/`first`/`last`/etc. re-walked the whole chain, so read cost grew with how many past versions a
tree was derived from — the exact pattern Inheritree's snapshot-per-version use case produces.

`src/b-tree.ts`:
- Added a private `_baseRoot?: TreeNode<TKey, TEntry>` cache field, populated lazily in the `root` getter:
  `this._baseRoot ??= this.base.root` (replacing the old unconditional `return this.base.root`).
- `checkBase()` (the base-immutability guard from ticket `enforce-base-immutability-guard`, already landed on
  `master`) still runs **unconditionally as the first line of `root`**, before the cache is even consulted —
  cache-then-check, not cache-instead-of-check. A base mutated out from under a live child still throws
  `MutatedBaseError` on the child's next read, cache warm or not.
- `clearBase()` now also clears `_baseRoot = undefined`. Not load-bearing for correctness (once `base` is
  `undefined`, `root`'s has-base branch that reads `_baseRoot` is unreachable — the no-base branch only ever
  reads/writes `_root`), but keeps the field from holding a stale reference after detach.
- The no-base (plain tree) code path never reads or writes `_baseRoot` — verified by test.

## Use cases / how to validate

- **Deep chain, repeated reads**: build a chain `base -> c1 -> c2 -> c3 -> c4` (5 levels), read through `c4`
  once (warms every level's cache), then read many more times. Ancestor `root` getters (`base`, `c1`, `c2`,
  `c3`) must NOT be re-invoked on the later reads — only the first read walks the chain.
- **`clearBase()` then read**: an unwritten child's cache is warmed, then `clearBase()`s — the detached tree
  must still resolve to the correct root (either the pinned former-base root for an unwritten child, or its
  own locally-cloned root for a written one), not a stale cached value.
- **Base mutation still detected**: warm a child's cache with several legitimate reads, then mutate the base
  while the child is still live (attached) — the child's next `root` read (direct or via `find`/etc.) must
  still throw `MutatedBaseError`, proving the cache doesn't mask the base-immutability violation.
- **Plain tree unaffected**: a base-less tree never touches `_baseRoot` at all.

All four are covered in `test/b-tree.root-cache.test.ts` (5 tests, all passing):
1. `a deep chain collapses to O(1) root resolution after the first read...` — instruments each ancestor's
   `root` getter with a call counter (via an instance-level `Object.defineProperty` override, not touching the
   prototype) and asserts each is invoked exactly once regardless of how many further reads happen downstream.
2. `clearBase() invalidates the cache: a locally-written child ignores a stale cached base root...`
3. `an unwritten child: clearBase after warming the cache still pins the exact former base root`
4. `a plain (no-base) tree never touches _baseRoot`
5. `cache-then-check: a cached root does not mask base mutation...`

Full suite: `yarn test` — 335 passing (was 330 before this ticket; +5 new). `yarn build` (`tsc`) is clean.

## Known gaps / things the reviewer should know

- **`checkBase()` itself is still O(chain depth) per call** (`chainVersion()` recurses up the whole base
  chain to detect a mutation anywhere in it). This ticket only removed the redundant chain-walk for
  *resolving the root value*; it deliberately did NOT touch `checkBase`/`chainVersion`'s own cost, which is
  out of scope here (that guard's own performance was not part of this ticket, and memoizing it is a separate,
  nontrivial question — a naive cache would need its own invalidation-on-mutation story). So a very deep chain
  is now O(depth) per operation (down from roughly O(depth) recursive calls each doing an O(remaining-depth)
  `checkBase`, i.e. O(depth^2)-ish) rather than truly O(1). If chain-depth performance becomes a concern again,
  `checkBase`/`chainVersion` is the next place to look — left as a comment-worthy note, not filed as a ticket
  since there's no known reachable case where it currently matters (no test exercises pathologically deep
  chains for wall-clock timing; the counting test above measures getter invocation count, not depth-of-`checkBase`).
- Test coverage for the cache is a fresh, small file (`test/b-tree.root-cache.test.ts`) rather than additions
  to the existing `test/b-tree.base-immutability-guard.test.ts` / `test/b-tree.cow-clearbase.test.ts` — kept
  separate since it's a distinct concern (caching, not guard correctness), but there is some conceptual overlap
  worth the reviewer's eye (e.g. the cache-then-check test partially re-covers ground the guard's own test file
  already covers from a different angle).
