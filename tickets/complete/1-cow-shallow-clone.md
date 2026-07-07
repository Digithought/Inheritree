description: The library used to deep-copy every stored item whenever a copied data tree first changed something it shared with its original — that could crash on ordinary data, quietly lose information, or behave inconsistently. It's been changed to a plain shallow copy, which is safer and faster; reviewed and complete.
prereq:
files: src/nodes.ts (LeafNode.clone, BranchNode.clone), test/b-tree.cow-entry-sharing.test.ts
difficulty: easy
----
## What shipped

`LeafNode.clone` and `BranchNode.clone` in `src/nodes.ts` replaced `structuredClone(...)` of
their stored arrays with a plain `.slice()` shallow copy. Deep-cloning every entry on each
copy-on-write clone broke prototypes on class-instance entries, threw `DataCloneError` on
function-bearing entries, broke `===` identity between base and derived trees, and un-froze
entries `freezeEntry` had frozen on insert — all only on the leaf(s) that happened to get
COW-cloned, so failures were data- and node-boundary-dependent.

```ts
// LeafNode
clone(newTree: BTree<any, any>): LeafNode<TEntry> {
	return new LeafNode(this.entries.slice(), newTree);
}
// BranchNode
clone(newTree: BTree<any, any>): BranchNode<TKey, TEntry> {
	return new BranchNode(this.partitions.slice(), [...this.nodes], newTree);
}
```

New test file `test/b-tree.cow-entry-sharing.test.ts` (6 cases) locks the behavior: prototype
survival, no `DataCloneError`, entry identity across base/derived, frozen-ness preserved under
default config, reference sharing under `{ freeze: false }`, and branch-level (multi-level tree)
child-node identity.

## Review findings

**Read the fix diff (`66dd805`) with fresh eyes before the handoff.** The actual code change is
in the fix commit; the implement commit (`344c2d5`) only moved the ticket file.

**Correctness — CONFIRMED sound.** The shallow copy is not merely "safer/faster" — it is what the
documented contract already required. `readme.md` §*Base immutability contract* (lines 117-119)
states a derived tree "reads any un-modified node **directly from its base**" and COW "only clones
the nodes a child actually mutates." The old `structuredClone` *contradicted* that: it silently
substituted deep-copied entries on any COW-cloned leaf. The new `.slice()` aligns code with doc.

**DRY / consistency — CONFIRMED.** The rebalance/merge paths (`src/b-tree.ts` lines 941-977) already
move entry *references* between leaves via `push`/`shift`/`unshift` with no cloning. `clone()` now
matches that reference-sharing model instead of being the one outlier that deep-copied.

**`BranchNode.partitions` are keys, not entries — checked deliberately.** `structuredClone` used to
deep-copy partition *keys* too; `.slice()` now shares key references with the base branch. Safe:
keys are immutable-by-contract identically to entries (readme.md line 34 — "Don't attempt to change a
key value after it has been inserted"), and partitions are only ever read in binary-search compares,
never mutated. Structural isolation is preserved because `.slice()` copies the array itself, so a
derived branch's split/merge mutates its own partitions array, not the base's.

**`[...this.nodes]` child-node array** was already a shallow copy pre-fix and is unchanged; the
multi-level branch test confirms un-cloned children keep base identity.

**Type safety — fine.** `entries.slice()` → `TEntry[]`, `[...nodes]` → `TreeNode[]`; both match the
constructor signatures. `tsc -p tsconfig.build.json` clean.

**Tests — reviewed in full, non-vacuous.** Each assertion matches its `it` name; the COW-forcing
pattern (derive, then insert a *different* key so the target leaf clones) is correct. Covers happy
path, both crash paths (prototype loss, `DataCloneError`), identity, freeze on/off, and the
branch-above-leaves case. Did **not** add further tests — the existing 316-case suite already
exercises COW structural isolation heavily (`assertOwnershipInvariant`), and the new file closes the
entry-semantics gap the fix targeted.

**Implementer gap #1 (existing tests silently asserting deep-independence) — investigated, non-issue.**
No existing test asserts derived-tree entries are independent objects; such a test would have been
asserting the *old buggy* behavior against the documented contract. Full suite green.

**Documentation — checked, no change needed.** `readme.md` already describes reference-sharing (the
base-immutability contract above); the *old* deep-copy behavior was the anomaly, so nothing in the
docs went stale. There is no `CHANGELOG.md` in the repo. Implementer gap #3 (should this be
documented) resolves to "already documented."

**Tripwires:** none. No conditional/speculative concerns surfaced.

**No new tickets filed** — no major findings; nothing needed inline fixing beyond what shipped.

## Validation performed this pass

- `yarn build` (clean + `tsc -p tsconfig.build.json`) — succeeds, no type errors.
- `yarn test` — **316 passing, 0 failing**, ~32s. No pre-existing failures.
- Read `src/nodes.ts`, the fix diff, `src/b-tree.ts` freeze/rebalance/merge paths, the new test file
  in full, and `readme.md` COW/freeze sections.
- No lint script exists (`package.json` has no `lint` target); type-check via build stands in.


## End
