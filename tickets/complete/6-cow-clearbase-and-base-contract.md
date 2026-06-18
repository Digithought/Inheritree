description: Added scale tests and documentation for detaching a copy-on-write tree from its base, and for the rule that a base must not be changed while trees derived from it are still in use.
prereq:
files: test/b-tree.cow-clearbase.test.ts, test/helpers/invariants.ts, src/b-tree.ts, readme.md
difficulty: medium
----
Pins two correctness edges around the COW `base` relationship: `clearBase` at scale, and the
base-mutation-while-derived contract. All work is **test + documentation**; no production behavior changed.

## What landed (implement stage)

- **`test/b-tree.cow-clearbase.test.ts`** (new) — multi-level base (400 keys, stride 10, depth ≥ 1;
  `NodeCapacity` is 64) → COW child driven by a seeded, delete-biased, non-front-anchored op stream that
  forces real borrows/merges/splits, then `clearBase()`, then assertions. Two groups: *clearBase at scale*
  and *the base-immutability contract (pinned hazards)*.
- **`test/helpers/invariants.ts`** — added `reachableNodesOf(tree)` and `sharedReachableNodes(a, b)` for
  structural-sharing assertions by node identity.
- **`src/b-tree.ts`** — doc comments on `clearBase` and the `base` constructor param spelling out the
  immutability contract (no code change).
- **`readme.md`** — new "Base immutability contract" subsection; the "Help wanted" TODO now points at it.

The key honest finding from implement (verified in review): the ticket *hoped* `clearBase` would make a
child "genuinely independent." **At scale that is false** — `clearBase` is a cheap pointer drop, not a deep
copy, so a flattened child still shares untouched subtrees with its former base by identity, and once
detached neither side copies-on-write. The tests assert the truth (sharing persists; untouched-region base
mutations leak) rather than the hope.

## Review findings

**Scope reviewed:** the full implement diff (4674960) read first with fresh eyes — `src/b-tree.ts`
(`clearBase`, `root` getter, `indexOfKey`), the new test file, the two new helpers in
`test/helpers/invariants.ts`, and the readme. Verified `childIndex`/`leafForKey` in the test faithfully
mirror `BTree.indexOfKey`/`getPath` routing. Ran `npm run build` (clean) and the full `npm test` suite.

- **Correctness / behavior pinning** — Sound. The pinned-hazard tests assert genuinely *current* behavior
  (all pass), and the handoff is honest that they pin unguarded behavior rather than a fix. The "isolation
  that DOES hold" vs "leaks that DO happen" split is accurate against the source.
- **Docs** — Accurate. The readme "Base immutability contract" subsection and the `clearBase` / `base`-param
  doc comments match the real COW semantics in `src/b-tree.ts`; the "Help wanted" TODO was updated to point
  at the contract. Read every touched file to confirm.
- **Dead code (minor, FIXED inline)** — `reachableNodesOf` was exported but used by no test (and the handoff
  inaccurately claimed it was used in the assertions). Put it to work: the "still SHARES untouched nodes"
  test now also asserts the shared count exceeds half the child's reachable nodes — strictly stronger
  evidence of "pointer drop, not deep copy" than the prior `> 0`.
- **Coverage gap (minor, FIXED inline)** — the handoff flagged that `clearBase` on a deep chain (≥ 3 trees)
  was untested. Added a test: `base -> c1 -> c2` (both `c1` and `c2` heavily mutated via seeded streams),
  then `c2.clearBase()`, asserting `c2` flattens to exactly its own key set with valid invariants, its base
  pointer is dropped, and `c1`/`base` remain valid and value-unchanged by the downstream detach.
- **Runtime guard / true isolation (MAJOR, deferred to new ticket)** — the implementer correctly left
  enforcement out of scope for a "pin behavior" ticket. The underlying design question (runtime guard vs
  deep-copying `clearBase` vs stay doc-only) is real and aligns with the existing readme "Help wanted" note.
  Filed `tickets/backlog/enforce-base-immutability-guard.md`. The pinned-hazard assertions are designed to
  flip visibly if that work lands — that is intended, not a regression.
- **Error paths / type safety / resource cleanup** — Nothing to flag. Tests are pure in-memory; no resources
  to clean up. Build type-checks clean. The seeded op streams use fixed seeds and are not exhaustive (by
  design — the adjacent `cow-fork`/`cow-delete` suites carry the heavier randomized differential load); this
  is an acceptable, documented floor.

**Result:** full suite **168 passing** (was 167; +1 deep-chain test, plus the strengthened sharing
assertion). `npm run build` clean.

## How to validate

- `npm test` — full suite, 168 passing. Targeted:
  `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js test/b-tree.cow-clearbase.test.ts`.
- `npm run build` — clean type-check.
