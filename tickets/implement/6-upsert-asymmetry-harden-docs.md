description: One add-or-update tree operation reports the added item's position in a way that looks empty right after a successful add; we keep that behavior (matching the upstream project it forks) but make the trap loud in the docs and pin it with a test so nobody hits it by surprise.
prereq:
files: src/b-tree.ts (upsert ~434-448, at ~349), test/b-tree.mutation-ops.test.ts (upsert describe ~66-130)
difficulty: easy
----

## Decision (resolved in plan)

**Option (a) adopted: keep upstream's `upsert` asymmetry as final.** `upsert` continues to
return an `on = false` crack path on a fresh insert and an `on = true` on-entry path on update.
We do **not** change the return shape and do **not** align it with `merge`.

Why (a) over (b) (align `upsert` with `merge` / add a `[path, wasUpdate]` result):

- **No fork-internal reliance.** Grep across the repo: the only readers of `upsert`'s return value
  are tests (`test/*`). No `src/` call site reads it. The `tree.at(tree.upsert(x))` footgun never
  actually trips inside this codebase, so the ergonomic cost of keeping (a) is theoretical here.
- **`b-tree.ts` is merge-heavy.** This file tracks upstream (Digitree) and merges painfully.
  Upstream's v1.5.0 pass deliberately left the `upsert` asymmetry in place while tightening the
  neighboring `updateAt` (now throws `PathNotOnEntryError` on a crack path). (a) is zero-drift;
  matching a deliberate upstream contract keeps future merges clean.
- **(b) is a breaking public API change.** Changing `upsert` from returning `Path` to
  `[path, wasUpdate]` breaks every external consumer of the published library (semver major) to fix
  a footgun that is already documented and that the fork never trips. High cost, no current need.
- **Reversible.** If fork usage of `upsert`'s result ever grows and the footgun starts biting, (b)
  is still on the table. That conditional is recorded as a tripwire below, not a queued ticket.

The one thing (a) loses is ergonomics for external callers who write `tree.at(tree.upsert(x))` and
get `undefined` on the success-by-insert case. The mitigation is documentation + a pinning test —
make the trap loud — not an API break.

## Tasks

- **Sharpen the `upsert` JSDoc** (`src/b-tree.ts` ~434-437). The current doc says only
  "`on = true if existing; on = false if new`". Expand it to state the trap explicitly:
  - `on = false` means the key was **newly inserted** (the returned path sits on the crack *before*
    the new row); `on = true` means it **updated** an existing entry (path sits *on* it). This is the
    inverse of `insert`'s contract and the opposite of `merge`, which sets `on = true` on insert.
  - Warn in words that `tree.at(tree.upsert(x))` returns `undefined` **exactly when `x` was newly
    added**, and that to read the freshly-inserted entry a caller must move off the crack first
    (`tree.at(tree.next(path))`), as the existing tests already do.

- **Add a tripwire comment** at the `upsert` site (`src/b-tree.ts` ~446, near the single
  `path.version = ++this._version` line), tagged `NOTE:` so it stays greppable, e.g.:
  `// NOTE: upsert returns on=false on insert / on=true on update (inverse of insert, opposite of merge) - a deliberate upstream contract kept for merge-cleanliness. If the fork ever depends on upsert's result positionally, revisit aligning with merge (a [path, wasUpdate] result) - see ticket 6.`

- **Add a pinning test** so the footgun can't silently change. In
  `test/b-tree.mutation-ops.test.ts` under the existing `describe('upsert', ...)` (~66-130), add a
  case that asserts the `at(upsert(...))` behavior directly (the existing tests assert `result.on`
  and reach the row via `at(next(result))`, but none pin `at(upsert(...))` itself):
  - fresh key: `expect(tree.at(tree.upsert(NEW))).to.equal(undefined)` (and confirm the entry is
    reachable via `tree.at(tree.next(result))` / `tree.get(NEW)`), with a comment naming this as the
    documented footgun.
  - existing key: `expect(dict.at(dict.upsert({ id, value: 'X' }))).to.deep.equal({ id, value: 'X' })`
    — the update case resolves normally.

- **Run `yarn build` and `yarn test`** (stream output: `yarn test 2>&1 | tee /tmp/test.log`).
  Existing `upsert` assertions across the suite (oracle, cow-*, api-breadth, count, options) already
  encode the asymmetry — they must stay green unchanged. If any go red, the doc/test change touched
  behavior it shouldn't have.

## Edge cases & interactions

- **`at()` on the returned path.** The whole point: `at(upsert(x))` is `undefined` on insert. The
  new test pins both branches (insert → `undefined`, update → the entry). Do not "fix" this by making
  `upsert` return `on = true`; that is option (b), explicitly rejected here.
- **Chaining the returned path into other ops.** A crack path from `upsert`-insert is still a valid
  cursor: `next(path)` lands on the new row, and feeding it to `updateAt` would (correctly) throw the
  new `PathNotOnEntryError` since `on = false` — that guard is *expected* to fire on an insert-path,
  not a regression. Don't add handling for it; just don't let the doc imply the path is on-entry.
- **`merge` parity is intentionally NOT achieved.** (a) keeps the two siblings inconsistent by
  design. The doc must call out the difference (merge sets `on = true` on insert, upsert leaves it
  `false`) rather than paper over it. The existing `merge` test at ~147 already asserts
  `'merge leaves the path ON the new row (unlike upsert)'` — leave it as-is.
- **Freeze / count / version invariants unchanged.** This ticket touches only doc text, one comment,
  and one test. No change to `internalInsertAt`, freezing, `_count`, or `_version` stamping. If a
  count/oracle/cow test moves, something went wrong.
- **`freeze: false` trees.** Behavior of `on`/`at` is independent of the freeze option; the pinning
  test can use the default (frozen) tree. No separate case needed.

## Tripwire (record, do not file as a ticket)

Landed as the `NOTE:` comment above and to be echoed in the review's `## Review findings`: *if the
fork begins to depend on `upsert`'s result positionally (any `src/` caller reading it), revisit
option (b) — align `upsert` with `merge` and surface insert-vs-update explicitly, ideally
upstream-first to avoid merge friction on this file.*
