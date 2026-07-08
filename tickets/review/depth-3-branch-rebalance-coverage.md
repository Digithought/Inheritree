description: New tests were added that exercise deleting from a very large, deep tree — deep enough that a single delete triggers rebalancing that ripples up through two internal branch layers, a path no earlier test reached.
prereq:
files: test/b-tree.cow-fork.test.ts (new "depth-3 branch rebalance under copy-on-write" group), src/b-tree.ts (unchanged — rebalanceBranch / branchSibSegments are the code under test)
difficulty: medium
----

## What was done

Added a fifth `describe` group — **"depth-3 branch rebalance under copy-on-write"** — to `test/b-tree.cow-fork.test.ts`. It covers the previously-uncovered path where a copy-on-write delete's rebalancing cascades through **two** internal branch levels, i.e. `branchSibSegments` invoked at `depth >= 2`. **No source changed** (verified `git diff src/` is empty); this ticket is pure test coverage of already-shipped code.

### Key correction to the ticket's premise (important for the reviewer)

The ticket asserted a depth-3 tree needs **> ~131k entries** and would be **expensive** ("far heavier than anything currently in the suite"). Both are wrong, and I verified empirically:

- The `~131k` figure assumes nodes packed near capacity (fan-out ~64). But `makeBase` builds by **ascending `insert`**, which leaves interior nodes near **half** full (fan-out ~32), so the tree is ~twice as tall per entry. `depthOf(root)` reaches **3** somewhere between **66,000 (depth 2)** and **68,000 (depth 3)** entries.
- Building 70,000 ascending inserts takes **~25 ms**, not seconds. The whole new group runs in **~0.3 s**. (The old 131k/expensive fear was the reason the ticket floated a "CI-only" fallback — not needed.)

So the base is built **once** in a `before()` hook at `D3_COUNT = 70000` and every case forks a fresh COW child off it (ticket's preferred option (a)).

### The two tests

Both pick their target by a **structural finder** that reads the live base tree (fails loudly with a clear message if no matching site exists — it can't silently pass vacuously), mirroring the depth-2 regression's "probe, don't hardcode" style.

1. **`regression: an interior delete cascades a leaf merge into a two-level branch rebalance and stays correct`** — the depth-3 analogue of the depth-2 regression. Target = an interior min-fill leaf whose parent branch (depth 2) **and** grandparent branch (depth 1) are both at min fill. Deleting one key: leaf merges → depth-2 branch **left-merges** (`branchSibSegments`@depth 2) → depth-1 branch **borrows** from a sibling (`branchSibSegments`@depth 1). The test asserts this premise explicitly (`nodeChainToKey` → both branch levels min-fill) before deleting, so a future build-shape drift fails at a named line.
2. **`a leaf merge underflows a depth-2 branch that borrows a cloned sibling branch`** — a depth-2 **borrow** (distinct relink path from the left-merge above), no cascade to depth 1.

Between the two, both branch-level relink shapes that use `branchSibSegments` — **borrow** and **left-merge** — are exercised at `depth >= 2`.

### How correctness is proven (the regression teeth)

Same battery the depth-2 regression relies on, which is what caught the original escaped bug:
- **`assertTreeInvariants(cow)`** — order (rule 5), ascending≡descending (rule 6), and **stored-count vs traversal-count (rule 7)**. A mis-linked sibling branch orphans a whole subtree (~`MIN_FILL^2` ≈ 1024 keys at depth 2); that shows up as a count mismatch and/or missing keys.
- **`expectKeys(ascendingKeys(cow), base ids − targetKey)`** — child lost *exactly* the deleted key.
- **`assertOwnershipInvariant(cow, base, snap)`** — cloned spine connected + base-disjoint, and base pristine (key list + reachable-node **identities** vs a pre-mutation snapshot).
- Spot checks that `cow` owns its cloned root, the base still routes through the very same untouched target leaf, and the child is still `depthOf >= 3` after the op.

## How to validate / re-run

- Whole group: `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js test/b-tree.cow-fork.test.ts --grep "depth-3 branch rebalance" --timeout 0` → 2 passing (~0.3 s).
- Full file: same without `--grep` → **10 passing (~13 s)**.
- Full suite: `npm test` → **349 passing** (~1 min). `npm run build` (tsc) clean.

## Honest gaps / where to be adversarial (treat my tests as a floor)

- **The "it really cascaded to depth 2/1" guarantee is structural, not runtime-asserted.** During development I confirmed the exact finder targets fire `branchSibSegments` at depths {1,2} / {2} via **temporary instrumentation** (a counter pushed onto a global inside `branchSibSegments`), then **removed it** (`git diff src/` is empty — please confirm). The shipped test proves the cascade only *indirectly*: the finder's structural preconditions deterministically force it (the tree is fixed and deterministic), plus the invariant battery would fail if a relink were wrong. A reviewer wanting airtight, self-evident proof could add a runtime assertion on an observable consequence — e.g. the **lending sibling branch's child-count in the child = base's − 1** after the depth-1 borrow — rather than trusting the structural argument.
- **Deterministic-shape dependency.** Targets come from a fixed 70,000-ascending-insert tree. If `NodeCapacity`, the split/rebalance math, or `makeBase` ever changes, the finders may return −1 → the tests fail **loudly** (good), but someone must then re-probe for new targets. This is inherent to depth-3 testing (can't lower `NodeCapacity` to make it cheap).
- **Not covered (documented as a `NOTE:` tripwire in the group header, not filed as a ticket):** (1) a branch-level **right-merge** at depth 2 — it deliberately does *not* use `branchSibSegments` (absorbs+discards the sibling, no relink), lower risk; depth-2 drain/differential already sweep right-merges at depth 1. (2) A **randomized depth-3 differential** (à la the depth-2 one) — deferred on cost (needs a ~68k FLOOR + per-op work on a ~70k tree). If a depth-3 branch bug ever escapes these two deterministic regressions, that differential is the next thing to add (CI-only if it blows the `npm test` budget).
- **Value-level base-pristine** is proven by node **identity** (via `assertOwnershipInvariant`'s snapshot) rather than the explicit `liveSet(base).deep.equal(entries)` the depth-2 group uses — dropped because chai's deep-equal on 70k Entry objects cost ~9 s/test. Identity-equality implies value-equality (COW never mutates a base node in place), so it's sound and arguably stronger, but it's a *different* check; flagging in case you want parity.
