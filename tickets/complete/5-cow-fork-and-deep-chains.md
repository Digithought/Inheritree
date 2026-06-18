description: Reviewed and accepted a data-corruption fix in the tree's delete-rebalancing on larger trees, plus the new copy-on-write fork and deep-inheritance tests that guard it.
prereq:
files: src/b-tree.ts (rebalanceBranch + branchSibSegments), test/b-tree.cow-fork.test.ts, test/helpers/invariants.ts, test/helpers/rng.ts
difficulty: hard
----
Implementation (commit `1998b5b`) added copy-on-write (COW) test shapes — multi-child fork isolation and
deep (4–5 level) inheritance chains — and in doing so surfaced and fixed a real, shipped correctness bug in
`rebalanceBranch` (`src/b-tree.ts`): during a COW branch borrow/merge, the freshly-cloned sibling branch was
re-linked into the *underflowing branch's* parent slot instead of the *sibling's* slot, silently clobbering a
whole subtree in the derived tree (the base stayed pristine, which is why it escaped every existing suite).
The fix is the new `branchSibSegments` helper (branch-level analogue of `leafSibPath`), applied at the three
sibling borrow/merge call sites; merge-right was correctly left unchanged.

The review accepted the fix as correct and complete for the depth at which the bug reproduces (depth-2). Two
hardening follow-ups were filed in `backlog/` (see below); neither blocks this work.

## Review findings

### What was checked
- **Read the implement diff first** (`git show 1998b5b -- src/b-tree.ts`) with fresh eyes, then the full
  `rebalanceBranch` / `rebalanceLeaf` / `mutableBranch` / `mutableLeaf` / `replaceRootward` flow, `Path` /
  `PathBranch` (clone/remap), `nodes.ts` (owner + clone semantics), the new test file, and both test helpers.
- **Fix correctness** — traced all four `rebalanceBranch` rebalance branches:
  - borrow-right, borrow-left, merge-left now build the sibling clone path via `branchSibSegments`, which
    clones `path.branches[0..depth-1]`, shifts the **parent** segment's index by the borrow/merge delta, and
    appends the sibling. `replaceRootward` then links the cloned sibling into the parent at the correct
    (sibling) slot. Confirmed the helper clones the parent `PathBranch` *before* shifting — mutating the live
    `path.branches[depth-1].index` would corrupt the cursor; this is the subtle requirement and it is met.
  - merge-right was **not** changed and is correct: it copies the right sibling's partitions/nodes into the
    (owned) underflowing branch and drops the sibling from the parent — there is no sibling clone to re-link,
    so no slot to get wrong.
  - The fix's precondition (the parent branch is already child-owned when `rebalanceBranch` runs) holds: the
    leaf merge's `mutableLeaf`/`mutableBranch(path.branches)` clones the whole path to root first, and each
    cascade step calls `mutableBranch(path.branches.slice(0, depth))` before recursing.
  - `grep` for `new PathBranch(` / `leafSibPath` / `branchSibSegments`: no other sibling borrow/merge site was
    missed; the remaining `new PathBranch` uses are insert/split/descent, unrelated.
- **Test efficacy (not a tautology)** — temporarily reintroduced the buggy form inside `branchSibSegments`
  and confirmed group-4's regression test fails (`-10250 / +25000`, a corrupted ordered set); restored the
  fix and confirmed the working tree is byte-identical to `HEAD` (`git diff` empty).
- **Test helper soundness** — the test's `childIndex` exactly mirrors the source `indexOfKey` (same binary
  search, `split + 1` on equality), so the ownership-spine probes (`nodeChainToKey` / `leafForKey`) descend to
  the same nodes the real tree does.
- **Type check**: `npx tsc --noEmit -p tsconfig.json` → clean.
- **Tests**: `npm test` → **159 passing** (~41s), including the 8 new cases.
- **Lint**: no `eslint.config.*` exists in the project (eslint is an unconfigured devDependency); there is no
  lint step to run. Not a regression — consistent with the implement stage.
- **Docs**: `readme.md` documents only the public API/concepts (no API changed); `docs/` is typedoc-generated
  and regenerated on publish. The fix is internal — no doc update needed or missed.

### Minor findings — fixed/addressed in this pass
- **Inaccurate handoff claim, corrected here (no code change).** The handoff stated group-4's differential
  "inserts fresh keys that can split leaves and push the tree to depth 3, so deeper cascades can occur." This
  is false: with `NodeCapacity = 64`, a depth-3 tree (root → branch → branch → leaves) needs more than
  ~64*64*32 ≈ 131k entries, and the differential's `FLOOR` caps the working set at ~2100–4000 keys, so it
  stays strictly depth-2. Consequently `branchSibSegments` at `depth >= 2` is **uncovered**, not "incidental."
  Recorded accurately here and in the backlog ticket below. No source defect — the fix is depth-general by
  construction (`segments[depth - 1]` for any depth, with rootward recursion); this is a coverage gap only.

### Major findings — filed as new tickets
- `backlog/depth-3-branch-rebalance-coverage` — add a deterministic test that forces a borrow/merge cascading
  across **two** branch levels (`branchSibSegments` at `depth >= 2`). Central tradeoff documented: a depth-3
  tree needs >~131k entries (`NodeCapacity` is fixed), so it is far heavier than the current suite and may need
  to be a slow/CI-only test.
- `backlog/bounded-iteration-guard` — a corrupt aliased spine makes the cursor loop forever (`path.branches`
  grows unbounded) so iteration **OOMs** instead of throwing; the depth-2 regression still relies on iteration
  to observe corruption. Add an O(1)-per-step iteration ceiling (and a cycle guard for the ownership
  validators) so the *next* such bug fails fast and loud rather than hanging CI. Flagged by the implementer.

### Empty categories (explicit)
- **No security findings** — pure in-memory data-structure library; the change touches no I/O, parsing, or
  external surface.
- **No performance regression** — the fix adds one small array clone per branch borrow/merge (already a rare
  path), mirroring the existing `leafSibPath`; the hot read/iteration paths are untouched. (The separate
  iteration-guard follow-up explicitly calls out keeping any guard O(1)-per-step.)
- **No type-safety findings** — `tsc` clean; the helper is fully typed and generic over `TKey`/`TEntry`.
- **No resource-cleanup findings** — no handles, timers, or external resources are involved.

### Disposition
Fix is correct and well-covered at the depth where the bug reproduces. Build, type check, and the full test
suite are green. Accepted; two hardening follow-ups parked in `backlog/`.
