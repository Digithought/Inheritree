description: Reviewed the shared B-tree copy-on-write test helpers (ownership validator, base snapshot, seeded RNG) that other test tickets depend on; they are correct and honestly covered, with two minor fixes applied.
prereq:
files: test/helpers/invariants.ts, test/helpers/rng.ts, test/invariants.test.ts, test/b-tree.cow-delete.test.ts, src/b-tree.ts, src/nodes.ts
difficulty: medium
----
Adversarial review of the implement-stage work (commit 02f6e54) that added the COW ownership validator
(`assertOwnershipInvariant` + `snapshotBase` + `BaseSnapshot`), its self-tests, and wired the shared
`invariants`/`rng` helpers into `test/b-tree.cow-delete.test.ts`. No `src/` changes were in scope (the
COW-delete fix itself landed earlier in 353211c); `src/*` was read only to judge the validator's fidelity.

## Outcome

Helpers are correct and faithful to the COW model in `src/b-tree.ts`/`src/nodes.ts`. Two **minor** issues
were found and fixed inline (below). No **major** issues — no new fix/plan/backlog tickets filed.

Test floor after review: **`npm test` → 122 passing** (was 121; +1 regression self-test).
**`npx tsc --noEmit -p tsconfig.json` → clean.**

## Review findings

### Checked

- **Validator vs. source (fidelity).** Read `src/nodes.ts` (`ITreeNode.tree` owner, `LeafNode`/`BranchNode`
  `clone`) and `src/b-tree.ts` (`root` getter, `_root`, `mutableLeaf`/`mutableBranch`/`replaceRootward`,
  `leafSibPath`). Confirmed the validator's three rules correctly encode the COW invariant: the mutable
  spine is upward-closed from `child.root` (connectivity), no child-owned node is reachable from `base.root`
  (shared-mutable), and base immutability via effective-root key list + reachable-node identities. Owner is
  read via `.tree`; roots via the public `root` getter — key-type-agnostic, matches `assertTreeInvariants`.
- **Self-test fixtures vs. real corrupt shapes.** The hand-built connectivity fixture (child-owned leaf under
  a base-owned branch) and shared-mutable fixture (same `LeafNode` wired into both trees) each exercise the
  intended branch of the validator and match the documented "base node aliased into the mutable spine" /
  "shared mutable node" manifestations. The orphaned-clone (dropped-write) manifestation is, as the handoff
  states, deliberately out of scope for the ownership checks and caught by `assertTreeInvariants(child)` +
  base-immutability instead — verified both are paired at every cow-delete call site.
- **DFS correctness.** Connectivity uses per-path crossing state (passed by value) — a child-owned node
  below *any* non-child node on its path is flagged, regardless of sibling paths. Correct.
- **Edge/error paths.** No-write deferring child (root === base.root); drain-to-empty; two forked children;
  multi-level base→mid→leaf; 4000-op randomized differential. Snapshot-gating (2-arg vs 3-arg) and
  base-mutation detection both asserted.
- **Cost.** Each assertion is O(n) (ascend + descend + two DFS traversals). Call sites sample (every 200 ops
  in the differential suite), not per-op — confirmed; downstream tickets 2/5 must keep sampling on large trees.
- **RNG swap.** cow-delete's inline LCG was replaced by the shared `rng.ts` (`lcg`/`lcgInt`/`shuffle`).
  Constants/range differ, so *which* random keys are exercised changed, but assertions are invariant-based
  and seeds are fixed — behavioral coverage shift only, not a correctness regression. Verified `shuffle`/
  `lcgInt` produce the same orders the old inline code intended (sorted-by-random == Fisher–Yates here).
- **Docs.** Grepped the source tree (`README.md`, `doc/`) — nothing references these test-internal helpers,
  so no documentation was out of date. `doc/` contains only icon assets. The accidental `doc/Icon/*` image
  files committed in 02f6e54 are unrelated to this ticket but harmless and left untouched (not mine to revert).

### Found & fixed (minor — fixed in this pass)

- **Base-immutability threw on an unwritten intermediate base (real downstream footgun).** The `snapshot`
  branch called `assertTreeInvariants(base)` unconditionally; for an unwritten COW child used as a base — the
  multi-level chain shape ticket 5 is explicitly documented to build (`base → c1 → c2 → …`, validating `c2`
  against an untouched `c1`) — `base` has no local `_root` and `assertTreeInvariants` throws
  *"tree has no local root"*. Reproduced standalone before fixing. **Fix:** guard the structural call behind
  `(base as any)['_root']`; immutability is still fully proven via the effective-root key list and reachable-
  node identities (both already use `base.root`). Added a regression self-test (`a snapshot of an UNWRITTEN
  intermediate base …`) that asserts the chain passes *and* that a post-snapshot mutation of the intermediate
  is still caught. This unblocks ticket 5's deep-chain pattern.
- **JSDoc / inline check numbering was out of order (`1, 3, 2`).** Renumbered the doc-comment list and the
  `// --- Check N ---` labels to sequential `1, 2, 3` (connectivity, shared-mutable, base-immutability) to
  match execution order, and clarified the base-immutability entry re: unwritten intermediate bases.

### Not found / empty categories

- **No correctness bugs in the validator logic.** The three rules faithfully mirror the COW model in `src/`.
- **No major issues → no new tickets filed.** The intermediate-base limitation the handoff flagged for a
  reviewer decision was small, safe, and well-contained, so it was fixed inline rather than deferred.
- **No `src/` defects surfaced.** The validator is test infrastructure; the production COW-delete fix it
  judges (353211c) was not re-litigated and its tests continue to pass.

### Open / deferred (intentionally not done — out of scope here)

- **Throwaway "revert the production fix" assurance test.** The handoff suggests temporarily reverting
  `replaceRootward` to prove the validators catch the real bug. Deliberately *not* added — test infra should
  not depend on broken `src`, and the existing fixtures + functional differential already exercise the real
  COW-delete paths. Left as an optional future hardening, not a gap that blocks downstream tickets.
- **Cycle-robustness of the connectivity DFS.** Unlike `collectReachableNodes`, the connectivity visitor has
  no `seen` guard, so a (severely corrupt) cyclic linkage would stack-overflow rather than throw a clean
  error. Not fixed: a cycle is itself catastrophic corruption and the overflow still fails the test; adding a
  guard risks masking double-visit logic. Noted for awareness only.
