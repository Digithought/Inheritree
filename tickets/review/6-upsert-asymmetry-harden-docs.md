description: Documented and pinned with a test the fact that `upsert` reports a fresh insert's position in a way that looks empty right after success — a known, intentional quirk we're keeping (it matches the upstream project this codebase is forked from), now impossible to hit by surprise.
prereq:
files: src/b-tree.ts (upsert doc + NOTE ~434-455), test/b-tree.mutation-ops.test.ts (new pinning test in `describe('upsert', ...)` ~131-152)
difficulty: easy
----

## What changed

Implements the plan decision in the ticket this replaces (`tickets/implement/6-upsert-asymmetry-harden-docs.md`,
itself from `plan/` ticket `upsert-on-flag-alignment`): **kept `upsert`'s return-path asymmetry as-is**
(no API change — still returns a bare `Path`, `on = false` on insert / `on = true` on update), and made
the trap impossible to hit blind:

1. **`src/b-tree.ts` `upsert` JSDoc (~434-442)** — rewritten to state plainly: `on = false` means the
   key was newly inserted and the path sits on the crack *before* the new row (NOT on it); `on = true`
   means an existing entry was updated and the path sits on it. Calls out that this is the inverse of
   `insert`'s on-flag and the opposite of `merge` (which sets `on = true` on insert too). Spells out the
   footgun explicitly: `tree.at(tree.upsert(x))` is `undefined` on a fresh insert, and gives the
   workaround (`tree.at(tree.next(path))` or `tree.get(key)`).

2. **`NOTE:` tripwire comment (~446-449)**, next to the `path.version = ++this._version` line inside
   `upsert`, greppable, naming the deliberate-upstream-contract rationale and pointing back at this
   ticket by slug if the fork ever starts depending on `upsert`'s result positionally (no `src/` caller
   does today — only tests read it).

3. **New pinning test** in `test/b-tree.mutation-ops.test.ts`, inside the existing
   `describe('upsert', ...)` block (now ~131-152): `'pins the at(upsert(...)) footgun: undefined on
   fresh insert, the entry on update'`. Asserts both branches directly:
   - fresh key: `tree.at(tree.upsert(NEW))` → `undefined`; confirms the row is reachable via
     `tree.at(tree.next(result))` and `tree.get(NEW)`.
   - existing key: `dict.at(dict.upsert({ id, value: 'X' }))` → deep-equals the updated entry.

No changes to `internalInsertAt`, freezing, `_count`/`_version` stamping, or any `src/` call site's
behavior — this is a doc + comment + test-only change, as scoped.

## How to validate

- `yarn build` — clean, no tsc errors (tsc is silent on success; confirmed via exit code 0).
- `yarn test` — full suite run: **337 passing, 0 failing** (~46s). In particular:
  - `Multi-level mutation ops (upsert / merge / updateAt) > upsert > pins the at(upsert(...)) footgun...`
    — the new test — passes.
  - Every pre-existing `upsert`/`merge` assertion across the oracle, COW, api-breadth, count, and
    options suites is unchanged and still green (the asymmetry these encode was not touched).
- Manually re-read the new JSDoc block and NOTE comment against the plan's rejected-vs-adopted rationale
  in the original implement ticket to confirm no drift from decision (a).

## Known gaps / things I did not do (by design, per the ticket)

- **No behavior change.** `upsert`'s return value is still a bare `Path` with the asymmetric `on` flag.
  This ticket explicitly rejected aligning it with `merge`'s `[path, wasUpdate]` shape (option (b) in the
  plan) — that remains a live option only if a future `src/`-internal caller is found to rely on
  `upsert`'s path positionally. Don't reopen that without a concrete trigger.
- **No sweep of external docs/README/typedoc output** beyond the JSDoc comment itself — the ticket scoped
  this to the JSDoc + one NOTE + one test. If there's a rendered API doc site (`yarn doc` via typedoc)
  that also needs a look, I did not check it; typedoc pulls straight from the JSDoc I edited so it should
  pick up the improved wording automatically on next `yarn doc` run, but I have not verified the rendered
  output.
- **Test coverage is narrow by design**: one new test, two assertions (insert branch, update branch), on
  a single-level (small, non-multi-level) tree for the insert case and a plain dict for the update case.
  It intentionally does not duplicate the existing multi-level split/rebalance upsert tests just above it
  in the same file (lines ~70-129) — those already cover `on`/`at(next(...))` at multi-level scale; this
  test's whole job is pinning the bare `at(upsert(...))` return, which none of the existing tests did
  directly.

## Review findings (tripwire to carry forward)

- **Tripwire, not a ticket**: if the fork ever grows a `src/`-internal caller that reads `upsert`'s
  returned path positionally (today only `test/*` reads it — grepped, confirmed clean), revisit option
  (b) from the plan: align `upsert` with `merge` by returning `[path, wasUpdate]`. This is a semver-major
  API change, so treat it as a deliberate, upstream-coordinated move, not an opportunistic patch. Landed
  as the `NOTE:` comment at `src/b-tree.ts` ~446.
