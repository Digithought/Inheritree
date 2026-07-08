description: Tree nodes no longer hold a reference to their whole owning tree just to answer a yes/no ownership question — they carry a lightweight per-tree identity token instead, so a shared node can no longer keep the whole owning tree (and its history) alive in memory.
files: src/nodes.ts, src/b-tree.ts, test/helpers/invariants.ts, test/invariants.test.ts, test/b-tree.cow-clearbase.test.ts, test/b-tree.cow-fork.test.ts, test/b-tree.cow-insert.test.ts, test/b-tree.cow-mutation-ops.test.ts, test/b-tree.cow-feature-matrix.test.ts, AGENTS.md, doc/review.html
----

## What shipped

Replaced the per-node back-reference to the owning `BTree` with a per-tree identity **token** (a
`Symbol`). Ownership stays the same O(1) identity check — only the compared value changed from the tree
object to its token. Resolves review finding **F10** in `doc/review.html`.

- **`src/b-tree.ts`** — `BTree` gained `readonly owner = Symbol()` (class-field initializer, set before
  the constructor body so it is available at every node-creation site). All seven node-creation sites
  stamp `this.owner` (or `tree.owner` in the static `buildFrom`): lazy `root` getter, `clear()`, root-split
  branch, split leaf, split branch, and both `buildFrom` levels. The three ownership checks became token
  comparisons (`mutableLeaf`, `mutableBranch`, `replaceRootward`); the two `clone` calls pass `this.owner`.
- **`src/nodes.ts`** — both node classes replace `tree?: BTree<any,any>` with `owner?: symbol`;
  `clone(newTree)` became `clone(newOwner: symbol)`; the `import type { BTree }` is gone (nodes.ts no
  longer depends on b-tree.ts, removing the `BTree<any,any>` type erasure).
- **Tests** — every node-owner assertion translated (`node.tree === tree` → `node.owner === tree.owner`),
  plus the `countOwned` helper, `assertOwnershipInvariant` checks 1 & 2, and the positional
  node-construction sites in `test/invariants.test.ts`. New retention test in
  `test/b-tree.cow-clearbase.test.ts` asserts every node reachable from a flattened child carries only a
  `Symbol` owner, has no `'tree'` property, and exposes no `BTree` instance — a direct object-graph proof
  that a detached child cannot pin its former base chain.
- **Docs** — `AGENTS.md` node description updated to "owner token"; `doc/review.html` F10 marked Resolved.

## Why it matters

Previously a node held the whole `BTree`, transitively retaining the comparator closure, key-extractor
closure, and the **entire base chain** of tree objects — so a shared node kept its owning tree and its
history reachable past `clearBase()`/`clear()`. The token makes prompt release **structural**: nodes never
point at trees, so a cleared child cannot retain its base chain.

## Review findings

Reviewed the full implement diff (e0756c2) with fresh eyes before the handoff, from every angle
(correctness, DRY, type safety, resource cleanup, retention semantics, serialization, docs).

- **Ownership-check parity (correctness crux) — CONFIRMED complete.** Grepped `new LeafNode|new BranchNode`
  in `src/`: exactly seven sites, all stamp a token; grepped `.clone(` call sites: both pass `this.owner`.
  No node-creation or clone site left unstamped. The three ownership comparisons are faithful translations
  of the old `node.tree === this`. `undefined` owners (hand-built nodes) never equal a tree's `Symbol`, so
  the clone-when-not-owned semantics are unchanged.
- **`buildFrom` stamps `tree.owner` not `this.owner` — CONFIRMED correct.** It is a static method building
  from a fully-constructed `tree` local (owner already initialized before any node is built). `this.owner`
  there would be a type error, so the site is self-guarding.
- **Class-field init ordering — CONFIRMED safe.** `owner` is the first field; no node is created during
  construction (bulk load is the separate static `buildFrom`), and the lazy `root` getter only runs
  post-construction. `owner` is always set before first read.
- **Retention claim — CONFIRMED structural, not incidental.** A node's reachable object graph is
  `owner: symbol` + entries/partitions + child *nodes*; it never reaches a `BTree`. A `Symbol` holds no
  back-reference to its tree, so holding the token cannot keep the tree alive. `clearBase` drops `base` and
  `_baseRoot`, so the base object is genuinely releasable. The new retention test pins this.
- **Serialization — no defect today; tripwire recorded.** Grepped `src/` for `JSON.(stringify|parse)`,
  `structuredClone`, `toJSON`, `serialize`: no persistence path exists, so the non-serializable `Symbol`
  breaks nothing. **Minor finding fixed inline:** the non-serializability tripwire lived only in the
  implement handoff, not at a code site. Added a `NOTE:` to the owner-token comment in `src/nodes.ts` so a
  future reader adding serialization meets it there (re-stamp on load, don't round-trip the token).
- **`mutableBranch` upward-closed-ownership tripwire — CONFIRMED still in code** (the `NOTE:` at the
  owned-branch fast path in `src/b-tree.ts`). The change swapped the compared value but not the invariant;
  `assertOwnershipInvariant` check 1 remains the guard. No action.
- **Public `owner` field tradeoff — reviewed, accepted.** Public on both `BTree` and the node classes so
  ~40 test assertions and the invariant helper read as plain `node.owner === tree.owner`. A `Symbol`
  exposes no internal state and cannot be usefully forged (nodes are already fully constructible in tests).
  Documented in the F10 finding. Legitimate to revisit only if the project wants `BTree.owner` non-public
  (cost: `(tree as any).owner` reach-ins at every assertion). Left as shipped.
- **Docs — CONFIRMED current.** `AGENTS.md` and `doc/review.html` F10 (summary table + finding body)
  reflect the new reality. `readme.md` describes only public API, not node internals — no update needed.
- **`doc/review.html` F1/F4 stale `.tree` snippets — parked as a note, not a ticket.** They are
  point-in-time code samples inside *already-resolved* findings (F1 shallow-clone at ~line 109; F4 fast-path
  `branch.tree === this` at ~line 166), i.e. historical review artifacts recording what the code looked
  like when found. Out of F10's scope. If the project ever treats `doc/review.html` as living
  documentation rather than a findings log, a follow-up sweep would refresh them — not filed, because the
  document reads as a log.
- **No new tickets filed; no `blocked/` decisions.** No major findings surfaced. Nothing conditional
  became a real latent defect.

## Tripwires (conditional — not tickets)

- **Token is not serializable.** `Symbol()` is unique per tree and cannot survive a serialize/deserialize
  round-trip. No persistence path exists today, so nothing breaks. If persistence/structured-clone of
  nodes is ever added, re-establish the owner on load (re-stamp reachable nodes with the loading tree's
  `owner`), do not round-trip the token. Now documented at the owner-token comment in `src/nodes.ts` (added
  this pass) and indexed here.
- **`mutableBranch` owned-branch fast path stays correct only while ownership is upward-closed.** Carried
  verbatim from before this change (the `NOTE:` at the fast path in `src/b-tree.ts`).
  `assertOwnershipInvariant` check 1 is the guard.

## Validation performed

- `yarn build` — clean (tsc exit 0), before and after the `src/nodes.ts` comment addition.
- `yarn test` — **338 passing, 0 failing** (~35s), including the new retention test. No pre-existing
  failures; no `.pre-existing-error.md` written. (The inline fix is comment-only and cannot affect runtime,
  so the green run stands.)
- Grep-confirmed: no `node.tree` reads remain in `src/` or translated tests; the two fixture `.tree`
  properties (`b-tree.options.test.ts`, `b-tree.perf-descent-range-end.test.ts`) are unrelated struct
  fields, untouched as intended.

## Known gaps carried forward

- **`docs/` generated typedoc not regenerated** — regenerates only at release; already several tickets
  behind. No new drift beyond the node type signature. (Standing situation, unchanged by this ticket.)
