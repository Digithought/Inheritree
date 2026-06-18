description: New tests for forking multiple copies off one tree and for deep inheritance chains uncovered a real data-corruption bug in deletes on larger trees; the bug was fixed and the tests now guard it.
prereq:
files: test/b-tree.cow-fork.test.ts (new), src/b-tree.ts (FIX), test/helpers/invariants.ts, test/helpers/rng.ts
difficulty: hard
----
Implement stage is complete. This ticket added the planned copy-on-write (COW) test shapes — multi-child
fork isolation and deep (4-5 level) inheritance chains — and in doing so **surfaced a real, shipped
correctness bug in `src/b-tree.ts` which has been fixed in the same change**. Treat the source fix as the
primary thing to review; the tests are its guard.

Build + tests are green: `npx tsc --noEmit -p tsconfig.json` clean; `npm test` → **159 passing** (was 151;
+8 new) in ~40s.

## TL;DR for the reviewer

- **Source fix (scrutinise first):** `rebalanceBranch` (the branch-level borrow/merge during a COW delete)
  built the sibling's clone path with the shifted parent-slot index on the *wrong* path segment, so the
  freshly-cloned sibling branch was re-linked into the **underflowing branch's slot instead of the sibling's
  slot** — clobbering a whole subtree in the derived tree while leaving the base pristine. New helper
  `branchSibSegments` fixes it (the branch-level analogue of the existing `leafSibPath`). 3 call sites changed
  (borrow-right, borrow-left, merge-left).
- **Why it was invisible:** the bug only triggers at **tree depth ≥ 2** (there must be an intermediate branch
  level that can underflow and cascade `rebalanceLeaf` → `rebalanceBranch`). Every pre-existing COW suite uses
  ~200 keys = depth 1, so none ever reached the branch-rebalance path. It is **not** deep-chain-specific — it
  reproduces on a *single* direct child of a depth-2 base with *one* delete.
- **New tests:** `test/b-tree.cow-fork.test.ts`, 8 tests in 4 groups.

## The bug, precisely

`NodeCapacity` is 64, min fill 32. In a depth-2 tree (root branch → intermediate branches → leaves), deleting
one key from a min-fill (32-entry) leaf underflows it → leaf merge → the parent intermediate branch drops from
32 to 31 children → it underflows too → `rebalanceLeaf` returns into `rebalanceBranch`, which must borrow/merge
the intermediate branch against a base-owned sibling branch, cloning that sibling into the child and re-linking
it rootward (`mutableBranch` → `replaceRootward`).

`replaceRootward` links a cloned node into its parent at `segment.index` — where `path.branches[i].index` is
the slot in `branches[i].node` that points to `branches[i+1].node`. For a *sibling* path the parent segment's
index must point at the sibling (`pIndex ± 1`). The original code wrote:

```
this.mutableBranch([...path.branches.slice(0, depth), new PathBranch(rightSib, pIndex + 1)], path)
```

i.e. it put the shifted index (`pIndex + 1`) on the **sibling** segment (which `replaceRootward` never reads —
the sibling is the deepest segment, linked with `prior === undefined`) and left the **parent** segment at
`pIndex` (pointing at the underflowing branch). So the cloned sibling was installed at the parent's `pIndex`
slot, overwriting the underflowing branch's clone. Net effect on a depth-2 child after one delete: ~32 keys
silently vanished and the spine aliased the sibling (a forward cursor then looped, growing `path.branches`
unboundedly → OOM). The base tree was always left correct, which is exactly why no base-pristine assertion
caught it.

**Fix:** `branchSibSegments(path, depth, sib, delta)` clones `path.branches.slice(0, depth)`, shifts the
**parent** segment's index by `delta`, and appends the sibling — mirroring `leafSibPath`. The borrow/merge
then re-links the cloned sibling into the correct parent slot. Verified by direct structural dump: a depth-2
child after the trigger delete now has the correct two intermediate branches (32 + 60 leaves = 92 = 93 − 1
merged), both child-owned, base untouched at 93.

`rebalanceBranch`'s merge-**right** case was *not* changed: it never makes the sibling mutable (it reads the
right sibling's partitions/nodes and deletes the sibling from the parent), so it has no sibling-clone link to
get wrong. Reviewer should confirm that reasoning.

## What was built — `test/b-tree.cow-fork.test.ts` (8 tests, 4 groups)

All cases use object entries `{id, value, tag}` (so value-level isolation is checkable), a genuinely
multi-level base, and after each step assert: live set in BOTH directions (`assertTreeInvariants`-style strict
ordering + ascending==descending), `assertTreeInvariants`, `assertOwnershipInvariant` (connected, base-disjoint
spine), and every ancestor pristine vs a pre-mutation `snapshotBase`.

1. **multi-child fork isolation** — two children A and B off one base, mutated with key-disjoint,
   non-front-anchored op sets (scattered deletes, interior-gap inserts, one value-replace upsert), interleaved,
   re-verifying BOTH after every step. Explicit cross-isolation: A's delete/insert/value-replace are invisible
   to B and vice versa; base untouched.
2. **concurrent children stress** — 4 children round-robin over a seeded op stream (insert / delete / upsert /
   updateAt same-key / updateAt key-change), each with its own shadow `Map`; 2 seeds, 640 ops, invariants +
   per-child shadow + base-pristine sampled every 20 ops. (NB base here is 300 keys = **depth 1** — this group
   targets multi-child isolation, not branch rebalance.)
3. **deep inheritance chains (base → c1 → c2 → c3 → c4)** — depth-2 base (3000 keys). c1/c2/c3 each insert in
   distinct regions (own part of the spine, inherit the rest); c4 mutates an untouched region with interior
   inserts + a delete band. Asserts each level's exact state, whole-chain ownership against per-level
   snapshots, and that c4's cloned spine to an inserted key is c4-owned at **every** node down through the
   un-owned levels it cloned. A second test does the **borrow/merge-against-an-ancestor-owned-sibling** case on
   the deepest child (the rootward-clone-through-unowned-ancestors path the bug lived in).
4. **depth-2 branch rebalance under COW** — the focused regression for the fixed bug:
   - crisp single-delete regression (the minimal trigger),
   - shuffled full drain of a depth-2 child to empty (full ordered-set + invariants every 100 deletes, cheap
     count/absence checks every step),
   - delete-heavy (65%) randomized differential vs a shadow map over 4000 ops, staying depth-2 via a floor.

## How to validate

- `npx tsc --noEmit -p tsconfig.json` — clean.
- `npm test` — 159 passing.
- Run just this file: `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js test/b-tree.cow-fork.test.ts`
- **Confidence check the reviewer can run:** temporarily revert the 3 `branchSibSegments(...)` call sites in
  `src/b-tree.ts` to the old `[...path.branches.slice(0, depth), new PathBranch(sib, pIndex ± 1)]` form and
  confirm group 4's "regression" test fails (the depth-2 single-delete corrupts). The deep-chain group also
  fails but its symptom is a cursor-loop OOM rather than a clean assertion — see the gap below.

## Known gaps / risks (treat the tests as a floor, not a ceiling)

- **Cursor-loop → OOM, not a clean failure.** A corrupt spine that aliases a node makes forward iteration loop
  forever (`path.branches` grows without bound), so `liveSet`/`collectAscending` OOMs instead of throwing.
  Group 4's *regression* test deletes the structure-aware way and asserts on the result, but it still relies on
  iteration. There is **no iteration-depth / visited-node guard** anywhere (the helper review ticket already
  flagged the connectivity DFS has no `seen` guard for the same reason). Consider a bounded-iteration guard so
  a future regression fails fast and loud instead of hanging a CI box. Out of scope here; worth a follow-up.
- **Depth-3+ branch rebalance is only incidental.** Group 4's differential inserts fresh keys that can split
  leaves and push the tree to depth 3, so deeper cascades *can* occur, but there is no test that deterministically
  constructs a depth-3 tree and forces a borrow/merge that cascades across **two** branch levels. The fix is
  depth-general (`branchSibSegments` works at any depth and the parent is always owned by the time
  `rebalanceBranch` runs, since the leaf's `mutableLeaf` already cloned the whole leaf-path to root), but a
  reviewer who wants belt-and-suspenders coverage should add an explicit depth-3 cascade case.
- **Stress group is depth-1.** Group 2 (multi-child concurrency) does not exercise branch rebalance; that
  coverage lives in groups 3-4 on single children / chains. A depth-2 multi-child concurrent stress would be a
  reasonable hardening (raise its base count past ~2048), omitted here to keep wall-clock down.
- **Cost.** Group 4's drain (~2.6s) and differential (~5.4s) dominate this file (~11s). They sample invariants
  (every 100 ops) rather than every op; a reviewer increasing the op counts should keep sampling or the O(n)
  checks will blow the budget.
- **Fix surface.** Only the three sibling-clone call sites were touched; `mutableBranch` / `replaceRootward` /
  `leafSibPath` are unchanged. If the reviewer prefers, the same correction could instead live inside
  `replaceRootward` (deriving the link slot from the child rather than the segment index), which would also
  cover any future caller — but that is a larger, riskier change than the localized `branchSibSegments` fix.
