description: Added (and reviewed) tests proving the higher-level edit operations — upsert, merge, and key-changing updates — keep an inherited tree and its parent correctly isolated, even at sizes large enough to trigger node splitting and rebalancing.
prereq: test-infra-cow-invariants
files: test/b-tree.cow-mutation-ops.test.ts (14 tests; reviewed + hardened), test/helpers/invariants.ts (reference), test/helpers/rng.ts (reference), src/b-tree.ts (read-only reference — UNCHANGED)
difficulty: medium
----
Closed the zero-coverage gap for the copy-on-write behaviour of `upsert`, `merge`, and `updateAt` (same-key value replace AND key-change) on a **multi-level** base. The suite `test/b-tree.cow-mutation-ops.test.ts` builds genuinely multi-level immutable bases (NodeCapacity = 64; base sizes 200–400), derives a COW child, and after each op asserts functional correctness (live set both directions + point lookups), `assertTreeInvariants(child)`, `assertOwnershipInvariant(child, base, snapshot)`, and value-level base immutability.

**No `src/` changes** — pure test-addition; `git diff src/` is empty. All tests pass against the current implementation.

## Review findings

Reviewed the implement diff (`8c1b493`) with fresh eyes against `src/b-tree.ts`, the two helper modules, and the sibling suites. **Status: APPROVED with one inline hardening.**

### What was checked

- **Contract accuracy (vs source, not just the handoff).** Read `upsert` (src/b-tree.ts:143), `merge` (161), `updateAt`/`internalUpdate` (128/429), `internalInsert` (469), `internalDelete` (448).
  - `upsert`'s inverted `on` contract (`on=false` for a newly-inserted key, `true` for existing) **is the documented intended behaviour** (doc comment, src/b-tree.ts:142) — not a latent quirk. The handoff flagged this for confirmation; confirmed. The tests correctly lock it in.
  - The merge **conflict path** assertions (`wasUpdate=false`, returned `path.on=false`, both keys survive) match the code exactly: `internalUpdate` → key changed → `internalInsert(other)` finds `other` present → returns `on=false` → original is not deleted. Verified the conflict path performs **no COW clone** (no `mutableLeaf`), which is why the test correctly guards with `if (hasLocalRoot(cow))` and why `assertOwnershipInvariant` still passes on a child with no local root.
- **Fresh-key uniqueness in the fuzz streams.** Audited the `freshKey` generator (`int + uid/1e5`): fractional parts stay `< 0.01`, `uid` is strictly increasing, so generated keys are pairwise distinct and never collide with integer base keys. Every op path additionally *asserts* absence/`on` semantics, so any collision would fail loudly rather than silently corrupt the shadow `Map`. Robust.
- **Scattered key-change order building** (the `order` array can contain duplicate `k`): harmless — the apply loop's `present.has` guards skip already-moved keys.
- **Helper coupling** (`leafForKey`/`enumerateLeaves`/`countOwned` reaching into `_root`/`.tree`): consistent with the landed sibling suites; acceptable for white-box COW structural probes.
- **Lint + tests.** No lint script exists in this project (`package.json` has none). `npx tsc --noEmit` → clean. New file → **14 passing**. Full suite (`test/**/*.test.ts`) → **151 passing** (~27s), no pre-existing failures (`.pre-existing-error.md` not written).

### Findings & disposition

- **MINOR — fixed inline.** *Heaviest-op case proved firing only implicitly.* The handoff's top self-flagged gap: the `insert SPLITS … delete REBALANCES` case asserted preconditions (full=64 / min-fill=32 leaves) but never explicitly asserted the split fired afterward. Analysis: precondition + `assertTreeInvariants` already *forces* both paths (a 65-entry leaf fails the fill check; a 31-entry non-root leaf fails MinFill), so coverage was sound — but there was no self-documenting structural assertion to guard against a future refactor that changes the precondition semantics. **Added** a robust post-op proof (independent of borrow-vs-merge): the child's leaf now holding `freshInFull` is a fresh **child-owned** clone, **distinct** from the base leaf, and **below capacity** (the 64-entry leaf was divided), while the base's original leaf is **untouched at 64 and base-owned**. This raised the file from 13 → 14 tests' worth of assertions (still 14 `it` blocks; the heaviest case gained the explicit checks). Re-ran: clean.

- **NOT A DEFECT — verified covered, no action.** *Merge on the key-change delete side.* The dedicated heaviest case's delete rebalances via **borrow** (its construction puts a full leaf to the right). A delete-side **merge** (which clones a parent via `rebalanceBranch`) during a key-change is exercised *incidentally* by the 2×900-op mixed streams (key-change deletes a present key, which can be a min-fill leaf forcing a merge) — and the merge-during-delete clone path itself is directly covered by the landed `cow-delete` suite. So the path is covered from two directions; a dedicated isolated case would be redundant polish, not a coverage hole. Left as-is.

- **NONE — other categories.** No correctness bugs, no DRY/SRP violations, no resource-cleanup or type-safety issues found in the test code. The suite's error-path coverage (conflict merge, absence assertions) and regression coverage (the documented bug-injection proof) are appropriate. Docs: this is a test-only change; `src/` and its doc comments are untouched and already accurate for the contracts under test (re-read and confirmed).

### Out of scope (project-wide, not this path)

Number keys / numeric-comparator only (no custom-comparator or non-numeric-key coverage) — a breadth concern shared by all sibling COW suites, not specific to mutation ops. Not filed; belongs to any future "comparator/key-type breadth" initiative, not this ticket.

## Validation performed (review)

- `npx tsc --noEmit -p tsconfig.json` → clean.
- New file alone after hardening → **14 passing** (~1s).
- Full suite (`test/**/*.test.ts`) → **151 passing** (~27s), zero failures, no `.pre-existing-error.md` written.
- Working tree: only `test/b-tree.cow-mutation-ops.test.ts` modified (hardening added), `git diff src/` empty.
