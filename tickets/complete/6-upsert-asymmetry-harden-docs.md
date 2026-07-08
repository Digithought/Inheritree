description: Documented and pinned with a test the fact that `upsert` reports a fresh insert's position in a way that looks empty right after success — a known, intentional quirk we're keeping (it matches the upstream project this codebase is forked from), now impossible to hit by surprise.
prereq:
files: src/b-tree.ts (upsert doc + NOTE ~434-456), test/b-tree.mutation-ops.test.ts (pinning test in `describe('upsert', ...)` ~131-151)
difficulty: easy
----

## What shipped

Kept `upsert`'s return-path asymmetry as-is (no API change — bare `Path`, `on = false` on insert /
`on = true` on update, per plan decision option (a)), and hardened against the trap:

1. **`src/b-tree.ts` upsert JSDoc (~434-442)** — rewritten to state the crack-before-row semantics,
   name the inverse-of-`insert` / opposite-of-`merge` relationship, and spell out the
   `tree.at(tree.upsert(x))` → `undefined` footgun plus workaround (`next(path)` / `get(key)`).
2. **`NOTE:` comment (~452-455)** — greppable tripwire naming the deliberate-upstream rationale and
   pointing at option (b) if a `src/` caller ever reads `upsert`'s result positionally.
3. **Pinning test** (`test/b-tree.mutation-ops.test.ts` ~131-151) — asserts `at(upsert)` is
   `undefined` on fresh insert (row reachable via `next()`/`get()`) and the entry on update.

## Review findings

Adversarial pass over the implement diff (`a16f8cf`), read before the handoff summary. Scope was a
doc + comment + test-only change; scrutinized for accuracy, coverage, and doc-truth drift.

- **Correctness of the three claims — CHECKED, no findings.** Verified against code: upsert stamps
  `on = false` on the insert branch / `on = true` on update (b-tree.ts 446-456); `merge` genuinely
  sets `path.on = true` on its insert branch (b-tree.ts 474), so the JSDoc's "opposite of merge"
  claim is literally true, not hand-wave; `insert`'s on-flag is the inverse. Doc, NOTE, and test are
  mutually consistent.
- **"Only tests read upsert's result" — CHECKED, confirmed.** Grepped `\.upsert\(` repo-wide: every
  caller is under `test/` (plus the definition in `src/b-tree.ts`). No `src/` code reads the returned
  path, so the footgun is theoretical inside the fork today. The tripwire's premise holds.
- **Test coverage — CHECKED, adequate.** New test pins both branches of the `at(upsert(...))`
  contract directly, which none of the pre-existing upsert tests did (they assert `.on` and reach the
  row via `at(next(...))`). The existing multi-level split/tail-split/in-place-update cases above it
  (lines ~70-129) already cover `on`/`next()` at branch scale. Not worth duplicating. No coverage gap
  found worth an inline add.
- **Build + tests — RUN, green.** `yarn build` clean (tsc exit 0). `yarn test`: **337 passing, 0
  failing** (~42s); the new `pins the at(upsert(...)) footgun...` case passes. No lint script exists
  in package.json (only build/test/doc/bench/pub/release) — none to run.
- **Doc-truth drift — CHECKED, one observation, deliberately not actioned.** The committed typedoc
  output `docs/classes/BTree.html` still renders the old terse upsert blurb ("on = true if existing;
  on = false if new"). It is **not** actioned here because: (a) `docs/` is regenerated only at release
  (`prepublish`/`release` run `yarn doc`), not per-commit; (b) it is *already* stale by several prior
  tickets — last regenerated at `hygiene-cleanup`, before root-getter-cache, enforce-base-immutability,
  comparator-antisymmetry, etc. — so a regen now would sweep in unrelated changes far outside this
  ticket's scope. It self-heals at the next release. See tripwire below.

Empty categories: **no major findings** (nothing spawned to fix/plan/backlog) — the change is a
correct, narrowly-scoped doc+test hardening with no behavior change. **No new bugs** — verified the
asymmetry the change documents is exactly what the code does. **No error-path/resource/type-safety
concerns** — no runtime code changed.

## Tripwires (conditional — not tickets)

- **Positional reliance on upsert's result** (carried from implement, lives as the `NOTE:` at
  `src/b-tree.ts` ~452): if the fork ever grows a `src/`-internal caller that reads `upsert`'s
  returned path positionally, revisit plan option (b) — align `upsert` with `merge` by returning
  `[path, wasUpdate]`. Semver-major; treat as a deliberate, upstream-coordinated move.
- **Stale committed typedoc under `docs/`**: the generated API-doc HTML drifts from source between
  releases (regenerated only by `yarn doc` at release time) and is currently several tickets behind.
  This is inherent to committing generated output + release-time regen, not specific to this change,
  and it corrects itself at the next release. Only becomes work if the project decides published docs
  must track every commit — at which point the fix is a per-commit `yarn doc` step or dropping the
  generated output from version control, not a patch to this ticket.
