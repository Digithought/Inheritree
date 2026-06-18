description: Strengthened the randomized copy-on-write stress test so it can actually trip the delete bug it was meant to guard against, instead of silently passing on a tree too small to ever hit it.
prereq:
files: test/cow.test.ts, test/helpers/invariants.ts, test/helpers/rng.ts, test/b-tree.cow-delete.test.ts, src/b-tree.ts
difficulty: medium
----
Completed **cow-stress-hardening**. The "Randomized Operations Stress Test" block in
`test/cow.test.ts` was reworked so it genuinely exercises the COW delete-rebalance path the original
test was structurally unable to reach. Test-quality ticket — no `src/` changes.

See the implement handoff (commit `9f00fab`) for the full description of what changed. Summary: the old
block built a single-leaf base (`INITIAL_BASE_SIZE = 50` < `NodeCapacity = 64`) on unseeded
`Math.random()` and only diffed the shadow `Map` at the end; the new block builds a multi-level base of
400 object entries, drives three fixed-seed (`0xC0FFEE`, `0x9E3779B1`, `0xBADF00D`) delete-biased op
streams whose deletes hit interior (non-front-anchored) keys, and after every sampled op asserts
structural + ownership invariants, bidirectional shadow-set equality, and base-pristine value equality.

## Review findings

Adversarial pass over the implement diff (`git show 9f00fab -- test/cow.test.ts`), reading the changed
file plus every helper it leans on (`test/helpers/invariants.ts`, `test/helpers/rng.ts`) and the sibling
suite it cross-references (`test/b-tree.cow-delete.test.ts`).

**Teeth — independently re-verified (the core deliverable).** The whole point of this ticket is that the
test *can* fail on the real bug, so I reproduced that claim from scratch rather than trusting the
handoff. In a throwaway git worktree (main tree never touched, `git worktree`/`git apply --reverse` only —
no `restore`/`reset`/`checkout`/`clean`/`stash`), I reverse-applied the fix commit `353211c` to
`src/b-tree.ts` and ran `test/cow.test.ts`:
  - **All three seeds fail on the buggy source**, at exactly the ops the handoff named:
    `key 199 present before delete @op3` (0xc0ffee), `key 439 @op19` (0x9e3779b1), `key 409 @op15`
    (0xbadf00d). The other 8 COW tests (Basic Isolation / clearBase) still pass — they don't reach the
    multi-level rebalance path, which corroborates *why* the old size-50 test never caught the bug.
  - **All three pass on the fixed (committed) source** (~81–91 ms each). Worktree removed, main
    `git diff src/b-tree.ts` empty, `node_modules` intact.

**Logic correctness — checked, no defects.**
  - Interior-delete index math is sound: `lcgInt(rng, 1, sortedKeys.length)` yields `[1, length)`, so it
    never selects index 0 (the global minimum) and never goes out of bounds; guarded by `shadow.size >= 2`.
  - Op-mix / floor behaviour verified by reasoning: delete-biased net drift (~−0.15/op) drains 400 toward
    the `NodeCapacity*3 = 192` floor, where forced inserts pin it. The tree is `> NodeCapacity` for the
    entire run, so it is genuinely multi-level throughout (confirmed at runtime by the
    `base.getCount() > NodeCapacity` assertion + `assertTreeInvariants`).
  - Shadow ↔ derived stay in lock-step: insert/update/delete each mutate both, and the `path.on`
    pre-condition assertions (present-before-delete/update, absent-before-insert) would catch any desync
    immediately — which is in fact the first tripwire on the buggy source.
  - Base-pristine check compares against a deep copy taken before any COW write, by value (`deep.equal`),
    so shared object identity between base/derived/shadow doesn't mask a real mutation.

**Minor finding — fixed in this pass.** `test/cow.test.ts` carried pre-existing dead code in its shared
header: an unused `LeafNode` import and an unused `getAllKeyValues`/`KeyValue` helper (zero references in
the file; `tsc` tolerated them because `noUnusedLocals` is off). Removed both. `tsc --noEmit` clean and
all 124 tests still pass after removal.

**Observation — not actioned (out of scope, no defect).** Small test helpers (`hasLocalRoot`,
`collectDescending`, `liveSetBidirectional`, an ascending-collector) are duplicated between
`test/cow.test.ts` and `test/b-tree.cow-delete.test.ts`. Hoisting them into a shared `test/helpers/`
module is a reasonable future DRY cleanup but is broader than this ticket and risks churn in a file the
ticket deliberately left otherwise untouched. Candidate for a future test-infra ticket if desired; left
as-is.

**Known gaps (carried from the handoff, reviewed and accepted as deliberate, not defects):**
  - Tree height is 2, not 3 — 400 entries is enough to reproduce this bug (it lives at "sibling owned by
    base while leaf owned by child", a height-2 phenomenon); a height-3 tree would need `> NodeCapacity^2`
    (~4097) entries and materially slower tests. Deeper-spine coverage, if wanted, is a separate slower
    test (natural fit for `7-coverage-and-ci`), not a defect here.
  - O(n) invariants are sampled every 20 ops, not per-op (a deliberate perf choice carried from the
    prereq review); the permanent shadow desync any corruption causes is still caught at the next sample
    or at the per-op `find` guard, so a transient self-healing corruption is the only theoretical miss.
  - Coverage is three fixed seeds (deterministic/reproducible by design), not property-test breadth.

**Validation run (final, on committed source + this pass's cleanup):**
  - `npx tsc --noEmit -p tsconfig.json` → clean.
  - `npm test` → **124 passing** (~15 s).
  - Lint: the project ships an `eslint` dev-dependency but has **no root ESLint config and no `lint`
    script**, so there is no configured lint step to run (not introduced or regressed by this ticket).
