description: Made edits to non-shared trees faster by no longer paying copy-on-write bookkeeping that only shared trees need. Reviewed and accepted.
files: src/b-tree.ts (mutableLeaf, mutableBranch, rebalanceLeaf, rebalanceBranch, branchInsert, updatePartition; leafSibPath removed), bench/index.ts (delete-heavy scenarios), doc/review.html (F3/F4 marked resolved), test/b-tree.cow-delete.test.ts (dangling leafSibPath reference)
----
Review of the `cow-lazy-mutable-node` implementation (commit `111ebae`). Implements findings F3 and F4
from the copy-on-write (COW) review: the mutable-node layer (`mutableLeaf`/`mutableBranch`) no longer
allocates clone material (spine slices, sibling paths, maps, remaps) unless a clone actually happens.
Accepted — the refactor is behavior-preserving and well covered.

## What the change does (recap)

- `mutableLeaf`/`mutableBranch` now take raw coordinates against the live path — `(path, sib?, delta?)` and
  `(path, depth, sib?, delta?)` — and build any slice/sibling-segment list only *after* deciding a clone is
  needed (F3).
- `mutableBranch` gained the ownership fast path `if (!this.base || branch.tree === this) return branch;`,
  mirroring the one `mutableLeaf` already had — an already-owned bottom branch means the whole rootward
  spine is owned (upward-closed ownership invariant), so no clone is required (F4).
- The free function `leafSibPath` (which eagerly cloned the whole branch array plus a throwaway `PathImpl`,
  including a fabricated unread `leafIndex`) is deleted; its index-shift logic is inlined into `mutableLeaf`
  and now runs only on the clone path. `branchSibSegments` is retained but called lazily inside
  `mutableBranch`.

## Review findings

**Checked:** behavior-preservation of the refactor (old-vs-new call-site mapping at all 24 `mutable*` sites),
the F4 fast-path correctness against the ownership invariant, ordering hazards in borrow/merge cascades
(sibling-then-main and parent-then-branch clone order), type safety, dead-code removal, test coverage, and
doc/comment accuracy across every file the change touches (and the review doc it *should* touch).

- **Correctness (behavior-preservation) — CONFIRMED, no findings.** Every call site maps 1:1 to the old
  form: `path.branches.slice(0, D+1)` → `mutableBranch(path, D)`; full `path.branches` →
  `mutableBranch(path, branches.length-1)`; `leafSibPath(path, sib, δ)` → `mutableLeaf(path, sib, δ)`;
  `branchSibSegments(path, depth, sib, δ)` → `mutableBranch(path, depth, sib, δ)`. Traced the four hazardous
  cases by hand: (a) sibling-then-main leaf borrow (`mutableLeaf(path, sib, δ)` then `mutableLeaf(path)`) —
  the first uses a *cloned, index-shifted* branch copy so it never disturbs the live path's indices, and the
  parent it clones is picked up by the second call's `replaceRootward`; (b) the two `rebalanceLeaf` merge
  sites that now pass `path` (formerly no `mainPath`) to `mutableBranch` — safe because the preceding
  `mutableLeaf(path)` already cloned the spine, so the branch is owned and the fast path returns before any
  remap; (c) parent-then-branch order in the branch merges (`mutableBranch(path, depth-1)` then
  `(path, depth)`) — the parent clone remaps the path, then the branch clone links into the now-owned parent;
  (d) owned sibling passed to `mutableBranch` — old code's `replaceRootward` returned immediately on the owned
  deepest segment with an empty map (no-op remap), matching the new fast path exactly. No divergence found.

- **F4 fast-path safety — CONFIRMED.** Returning an owned branch without cloning is correct only while
  ownership is upward-closed (an owned node never sits beneath a base-owned ancestor). This is exactly
  `assertOwnershipInvariant` check 1, which the stress suite re-checks after every one of 1500 delete-biased
  ops per seed. The implementer parked this as a `NOTE:` code comment at the site — verified present and
  accurate (`src/b-tree.ts`, `mutableBranch`). Correctly a tripwire, not a ticket.

- **Dead code — CONFIRMED removed.** `leafSibPath` gone; grep shows no remaining callers. The fabricated
  `leafIndex` it set was confirmed unread (`mutableLeaf` only ever touches `.leafNode`/`.branches`).

- **Type safety — no findings.** `tsc -p tsconfig.build.json` clean. Return types unchanged; `depth`/`depth-1`
  indices are in range at every caller (branch rebalance sections all guard `depth === 0` first, so `depth-1
  >= 0`).

- **Tests — pass, coverage adequate.** `yarn test` = **298 passing, 0 failing** (38s). Load-bearing suites:
  `cow-delete`, `cow-mutation-ops`, `cow-fork` (incl. 4–5 level deep chains), `cow-feature-matrix`, and the
  randomized delete-biased stress test with per-op ownership + isolation re-checks. These exercise the new
  fast path (derived owned-spine steady state) and every borrow/merge cascade level. No new correctness test
  is warranted for a behavior-preserving refactor; the allocation-free property is a performance claim covered
  by `bench/`, not unit-testable.

- **Docs — fixed inline (minor).**
  - `doc/review.html` still listed F3 and F4 as **Open**; they are now implemented. Marked both **Resolved**
    (table rows, finding-block headers, verdict paragraph) with resolution notes, consistent with how the doc
    already tracks F6/F7/F9/F12 as resolved. This is the doc where these findings live.
  - `test/b-tree.cow-delete.test.ts` docblock named the deleted `leafSibPath` symbol in its historical bug
    narrative. Reworded to describe the bug without the dangling symbol and note the logic now lives inlined
    in `mutableLeaf`.
  - `AGENTS.md` reference to `mutableLeaf`/`mutableBranch` is generic and still accurate — no change needed.
    Public API (readme) is unchanged (the refactor is entirely in private/internal methods).

- **Major findings (new tickets):** none. No defect or design problem warranting a fix/plan/backlog ticket
  surfaced.

- **Tripwire (already parked by implementer; re-affirmed):** the F4 `branch.tree === this` fast path in
  `mutableBranch` depends on upward-closed ownership; a future change that let a child-owned node sit beneath
  a base-owned ancestor would make this skip a needed clone and corrupt the derived tree. Documented as a
  `NOTE:` at the code site; `assertOwnershipInvariant` check 1 is the guard. Not a ticket.

- **Known deferral (not a defect, not filed):** the implement ticket asked to benchmark this fork against
  *upstream* Digitree. That needs network + `yarn add -D digitree`, unavailable in the sandbox, so the
  implementer ran a within-fork BEFORE/AFTER interleaved comparison instead (delete-heavy: +2.5% plain/number,
  +8.6% derived/number, +4.2% plain/string, +5.1% derived/string — uniform gain, no regression). The
  fork-vs-upstream number measures residual COW overhead over vanilla Digitree — a separate, coarser measure,
  not a blocker for this change. A human with network can run it out-of-band; low value, not worth a
  standalone ticket. `doc/review.html` F3 already points at `bench/` for this.

## Validation run during review

- `yarn build` — clean (tsc, no errors).
- `yarn test` — 298 passing, 0 failing.
- No lint script exists in this project (`package.json` has build/test/doc/bench only); `tsc` is the type gate.
