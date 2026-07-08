description: A derived tree now throws a clear error the next time you use it after its base tree was illegally modified, instead of silently returning corrupted data.
files: src/b-tree.ts, test/b-tree.base-immutability-guard.test.ts, test/b-tree.cow-clearbase.test.ts, test/helpers/invariants.ts, readme.md, AGENTS.md
difficulty: medium
----

## What shipped

A **detect-on-next-use** runtime guard turning the previously doc-only base-immutability contract into an
enforced one. When a `base` tree is mutated while a derived child is still live, the base op itself still
succeeds silently (a base has no back-reference to its children), but the child's **next** operation throws
the new `MutatedBaseError` instead of returning a corrupted view (or a silently-skewed O(1) count).

### Mechanism (src/b-tree.ts)

- `MutatedBaseError` — new exported error class (auto-exported via `src/index.ts`'s `export *`).
- `private readonly baseVersion` — snapshot of `base.chainVersion()` at construction (0 when no base).
- `chainVersion()` — `this._version + (base ? base.chainVersion() : 0)`; O(chain depth). One comparison
  detects a mutation anywhere up the chain. Snapshot excludes the child's own `_version`, so a child mutating
  itself never trips its own guard.
- `checkBase()` — throws if `base && base.chainVersion() !== baseVersion`; no-op when there is no base.

The five guard chokepoints: `get root()`, `validatePath()`, `get size()`, no-arg `getCount()`, top of
`clearBase()`. Every public read/write/count/iterator routes through one of these.

## Review findings

Adversarial pass over commit `566f4d6`. Read the implement diff first, then the full current `src/b-tree.ts`,
the guard + clearBase test files, the invariants helper, `readme.md`, and `AGENTS.md`.

### Checked — chokepoint completeness (the core risk)
Traced every public API method to confirm none reaches shared structure or `_count` without passing a guard:
- `find/get/at/first/last/insert/upsert/merge/range/entries/keys/[Symbol.iterator]/next/prior/flatten`
  all resolve through `get root()` (via `find`/`first`/`last`) — guarded.
- `moveNext/movePrior/updateAt/deleteAt/ascending/descending/getCount(from)/at` route through
  `validatePath()` — guarded.
- `size` and no-arg `getCount()` are the only direct `_count` reads — both explicitly guarded.
- Grep of every `_count` / `this._root` / `this.base` read (see `src/b-tree.ts`) confirms the remaining
  reads are all internal (constructor seeding, `buildFrom`, the mutation chokepoints reached via a guarded
  `find`, `replaceRootward`). **No gap found.**

### Found + fixed inline (minor)
- **Constructor-time detection was untested.** Deriving a *new* child off an already-corrupted intermediate
  base (`base → c1` live, mutate `base`, then `new BTree(…, c1)`) throws `MutatedBaseError` at construction —
  because the constructor seeds `_count` via `c1.getCount()`, which runs `checkBase` on `c1`. Verified
  empirically against `dist/`, then added a regression test to the *multi-level chain detection* group in
  `test/b-tree.base-immutability-guard.test.ts` ("deriving a new child off an already-corrupted intermediate
  base throws at construction"). This is a genuinely nice property (you cannot launder a corrupt base by
  wrapping a fresh child around it) that had no anchor. Test count 329 → **330 passing**.

### Reviewer questions from the handoff — dispositions
- **`effectiveRootInternal` in `test/helpers/invariants.ts` (out-of-plan change): correct call.** The
  white-box validators must detect base mutation via node identity/keys, which is *their* job; letting the new
  runtime guard short-circuit their read would leave those detection branches untested. Test-only; no
  production code depends on it. Confirmed as the right fix over rewriting the three self-tests to expect
  `MutatedBaseError`.
- **`clear()` intentionally un-guarded: correct and safe.** Unlike `clearBase()` (which preserves data by
  sharing nodes, hence can launder corruption), `clear()` discards *all* entries and reads no shared
  structure, so it cannot surface corruption. Leaving it out of the chokepoint set is sound.
- **`isValid()` on a stale-base path still returns `true`: harmless in practice.** The public `Path` interface
  exposes no data accessor (`on`/`isEqual`/`clone` only) — the only way to *read* an entry is `at()`, which
  is guarded. So even the `if (tree.isValid(p)) tree.at(p)` pattern still throws `MutatedBaseError` at the
  `at()` call. Weaker concern than the handoff implies; no change needed.
- **Coarse detection / unbenchmarked overhead: accepted by design.** The guard fires on any base
  `_version` bump (safe coarseness, consistent with the existing path-version model); per-call cost is one
  branch + one add + one compare in the single-level common case. Reasoning-only per the plan.

### Docs
Re-read `readme.md` (*Base immutability contract*) and the `AGENTS.md` core-concepts note against the shipped
code: both accurately describe enforced-by-guard, detect-on-next-use, and the post-`clearBase()` unguardable
limitation. The *Help wanted* version-checking TODO was correctly removed. No doc drift found.

### Tripwire (parked, not a ticket)
- `chainVersion()` is O(base-chain depth) and runs on every guarded op. Already parked as the doc comment on
  `chainVersion()` in `src/b-tree.ts` ("O(chain depth); chains are short"): *if* deep multi-level base chains
  ever become common and the guard shows up as hot, cache/propagate a chain-version instead of recomputing.
  Confirmed the comment is present and adequate.

### Major findings / new tickets
None. No new fix/plan/backlog tickets filed.

### Build + test status
- `npm run build` — clean.
- `npm test` — **330 passing, 0 failing** (~42s). The only behavioral diff from before the ticket is the
  intended pinned-test flip in `test/b-tree.cow-clearbase.test.ts`, plus the one added regression test.
