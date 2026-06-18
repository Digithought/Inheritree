description: Strengthened the randomized copy-on-write stress test so it can actually trip the delete bug it was meant to guard against, instead of silently passing on a tree too small to ever hit it.
prereq:
files: test/cow.test.ts, test/helpers/invariants.ts, test/helpers/rng.ts, test/b-tree.cow-delete.test.ts, src/b-tree.ts
difficulty: medium
----
Implement handoff for **cow-stress-hardening**. Reworked the "Randomized Operations Stress Test"
block in `test/cow.test.ts` so it genuinely exercises the COW delete-rebalance path the original
test was structurally unable to reach. No `src/` changes — this is a test-quality ticket.

## What changed (`test/cow.test.ts`)

The old randomized block (single test, ~line 325) had three defects that let the COW-delete bug
escape the suite entirely; all three are now fixed:

| Defect (old) | Fix (new) |
|---|---|
| `INITIAL_BASE_SIZE = 50` < `NodeCapacity` (64) → base was a **single leaf**, never rebalances | `INITIAL_BASE_SIZE = 400` → base is genuinely multi-level (root branch over ~7–12 leaves). Asserted at runtime: `base.getCount() > NodeCapacity` + `assertTreeInvariants(base)`. |
| Unseeded `Math.random()` → failures unreproducible | Seeded `lcg`/`lcgInt` from `test/helpers/rng.ts`. Three fixed seeds (`0xC0FFEE`, `0x9E3779B1`, `0xBADF00D`), each its own `it`. Seed is in the **test title and every assertion message** so a CI failure names the exact stream. |
| Ascending-only verification; shadow `Map` diffed only at the very end | After every op (sampled every `CHECK_INTERVAL = 20`, plus the final op): `assertTreeInvariants(derived)`, `assertOwnershipInvariant(derived, base, snap)`, **bidirectional** set-equality (ascending walk === reversed descending walk === sorted shadow `Map`), and `base` proven pristine value-for-value. |

Other deliberate choices:
- **Delete-biased op mix** (≈50% delete / 15% update / 35% insert) — delete is the path the bug lived in.
- **Interior (non-front-anchored) deletes**: the delete target is drawn from the sorted live keys at
  index `>= 1`, i.e. **never the current minimum**. A front-anchored delete only ever borrows/merges
  with its *right* sibling and dodges the bug (per `test/b-tree.cow-delete.test.ts`'s header).
- **Multi-level floor**: if the live size drops to `NodeCapacity * 3` (192) the op is forced to an
  insert, so the tree stays comfortably multi-level for the whole run (it descends from 400 toward
  ~192 and hovers there, churning merges/borrows at the boundary).
- **Object-entry shape preserved**: entries are still `{ id, value, origin }` (`Entry`), and the base is
  built **deterministically** (odd ids `1..799`) — the "deterministic variant + existing object shape"
  the ticket asked for. Inserts use even ids so they interleave with the base keys.
- `clearBase()` and Basic-Isolation tests were **left untouched**; only the randomized block changed.

## Teeth — verified, not assumed

The whole point of this ticket is that the test *can fail on the real bug*. Verified by temporarily
reverting **both** fix hunks from commit `353211c` (the `replaceRootward` owned-ancestor re-link and
the `leafSibPath` index shift) in a scratch copy of `src/b-tree.ts`, running only this block, then
restoring `src/` from a plain file backup (no `git restore`/`checkout` used):

- **All three seeds fail fast** on the broken source (op 3 / op 19 / op 15), surfacing as a dropped /
  phantom key — e.g. `[seed 0xc0ffee] key 199 present before delete @op3`.
- **All three pass** on the fixed source (~80–110 ms each).

`src/b-tree.ts` is back to its committed state — confirmed `git diff src/b-tree.ts` is empty.

## Validation run

- `npx tsc --noEmit -p tsconfig.json` → clean.
- `npm test` (full suite) → **124 passing** (was 122; the 1 old stress test became 3 seeded ones, net +2), ~17 s.

## Reviewer focus / known gaps (treat tests as a floor)

- **Tree height is 2, not 3.** 400 entries forces a branch root over leaves, which is enough to
  reproduce the bug (the escaped bug lives at "sibling owned by base while leaf owned by child", which
  occurs at height 2). A height-3 tree needs `> NodeCapacity^2` (≈4097) entries — deliberately *not*
  done here to keep per-test wall-clock low. If deeper-spine coverage is wanted, that's a separate,
  slower test (candidate for `7-coverage-and-ci`), not a defect in this one.
- **First tripwire is the `find().on` guard, not always the invariant assertions.** On the broken
  source the corruption is caught by "key present before delete" before the next sampled invariant
  check fires. That's a *stronger* early signal, but it means the per-op invariant assertions aren't
  the thing that catches *this particular* manifestation — confirm they're still valuable (they catch
  structural/ownership corruption that doesn't immediately desync the shadow). Both layers are kept.
- **Sampling, not per-op, for the O(n) checks.** Per the prereq review's note ("downstream tickets 2/5
  must keep sampling on large trees"), invariants are asserted every 20 ops, not every op. A bug that
  corrupts and then self-heals within a 20-op window between samples could be missed by the *invariant*
  layer — but the shadow `Map` desync it causes is permanent and caught at the next sample / at the
  `find` guard. Reviewer: judge whether 20 is tight enough, or whether the cheap shadow check should
  run every op while the expensive structural checks stay sampled.
- **Fixed seeds only.** Coverage is deterministic but bounded to three streams. Property-test-style
  randomization across many seeds is out of scope (would trade reproducibility for breadth).
- **Steady-state size hovers near the floor (~192) late in the run.** Early ops (large tree) and late
  ops (near-floor churn) both stress rebalance, but the tree never drains to empty here — drain-to-empty
  is already covered by `b-tree.cow-delete.test.ts`'s "cascading rebalance to empty" test.
