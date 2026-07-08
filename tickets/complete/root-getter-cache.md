description: Reads on a tree derived from a long chain of past versions used to get slower the longer that history grew; the fix caches the resolved root so repeat reads stay fast.
files: src/b-tree.ts (root getter, clearBase, clear), test/b-tree.root-cache.test.ts
----
## What shipped (code review finding F11)

A derived tree resolves its effective root by walking its `base` chain (`this.base.root`, recursively). Every
`find`/`get`/`first`/`last` re-walked the whole chain, so the root-resolution cost grew with how many past
versions a tree derived from — Inheritree's snapshot-per-version pattern.

`src/b-tree.ts`:
- Private `_baseRoot?: TreeNode<TKey, TEntry>` cache, populated lazily in the `root` getter:
  `this._baseRoot ??= this.base.root`.
- `checkBase()` runs unconditionally as the first line of `root` — cache-THEN-check. A mutated base still
  throws `MutatedBaseError` on the child's next read, cache warm or not.
- `clearBase()` clears `_baseRoot = undefined` on detach.
- `clear()` now does the same (**review fix** — see findings below).

## Review findings

Adversarial pass over commit `1f75b50`. Read the full diff and every touched site (`root`, `clearBase`,
`clear`, `checkBase`/`chainVersion`) plus every `_root =` assignment in the file before trusting the handoff.

### Checked — sound, no change
- **Cache soundness.** Caching `base.root` is valid only because a base's effective root cannot legitimately
  change while a child derives from it, and `checkBase()` (run first, every call) trips `MutatedBaseError` on
  any violation. Verified the guard fires on the cached path (test 6, `cache-then-check`).
- **Cache never masks a local write.** `root` returns `_root` before it ever reads `_baseRoot`. Audited all
  `_root =` sites (root getter, `internalInsertAt`, `internalDelete`, `replaceRootward`, `clear`, `clearBase`,
  `buildFrom`) — none assigns `undefined`, so a warmed `_baseRoot` can never be resurrected once the child has
  its own root. No stale-root exposure.
- **Multi-level chains** collapse to per-level O(1) after warm-up (test 1, getter-invocation counter).
- **`clearBase()` on both written and unwritten children** resolves the correct root, cache cleared (tests 2, 3).
- **Plain (no-base) tree** never reads or writes `_baseRoot` (test 4).
- **Type safety / build.** `_baseRoot` typed identically to `_root`; `yarn build` (tsc) clean.

### Found & fixed inline (minor — resource cleanup)
- **`clear()` leaked the warmed cache.** `clearBase()` clears `_baseRoot` on detach "to not pin a stale
  reference"; `clear()` also detaches (`this.base = undefined`) but left `_baseRoot` holding the former base's
  root subtree — same dangling-reference hazard the implementer fixed in `clearBase`, missed in `clear`.
  Unread after `clear` (since `_root` is set and `base` is gone), so not a correctness bug, but it pins memory.
  Fixed: `clear()` now sets `_baseRoot = undefined` too. Added regression test
  (`clear() detaches like clearBase and drops the warmed base-root cache`).

### Tripwire (conditional — recorded, not a ticket)
- **Reads are O(chain depth), not truly O(1).** F11 removed the redundant chain-walk for *resolving the root
  value*, but `checkBase()`→`chainVersion()` still recurses the whole base chain on every guarded op. So a
  deep chain is O(depth) per read (down from ~O(depth²)), not O(1). Genuinely conditional — fine now, matters
  only if base chains get pathologically deep — and **already parked** at the site: the doc comment on
  `chainVersion()` in `src/b-tree.ts` ("O(chain depth); chains are short"), placed by the prior
  `enforce-base-immutability-guard` ticket. No new comment or ticket; `chainVersion` memoization is the next
  place to look if it ever surfaces.

### Not found (stated explicitly)
- No correctness, type-safety, error-handling, or DRY issues in the diff. No new tests needed beyond the
  `clear()` regression above — the implementer's 5 tests already cover happy path, deep chain, both `clearBase`
  variants, plain-tree, and the mutation-detection interaction.
- **No major findings** → no new `fix/`/`plan/`/`backlog/` tickets spawned.

## Validation
- `yarn build` (tsc): clean.
- `yarn test`: **336 passing** (335 before review + 1 new `clear()` regression test). No pre-existing failures.
