description: Tree nodes used to hold a reference to their whole owning tree just to answer a yes/no ownership question; they now carry a lightweight per-tree identity token instead, so a shared node can no longer keep the whole owning tree (and its history) alive in memory.
prereq:
files: src/nodes.ts, src/b-tree.ts, test/helpers/invariants.ts, test/invariants.test.ts, test/b-tree.cow-clearbase.test.ts, test/b-tree.cow-fork.test.ts, test/b-tree.cow-insert.test.ts, test/b-tree.cow-mutation-ops.test.ts, test/b-tree.cow-feature-matrix.test.ts, AGENTS.md, doc/review.html
difficulty: medium
----

## What shipped

Replaced the per-node back-reference to the owning `BTree` with a per-tree identity **token** (a
`Symbol`). Ownership is still the same O(1) identity check — only the compared value changed.

- **`src/b-tree.ts`** — `BTree` gained a public `readonly owner = Symbol()` class-field initializer
  (runs before the constructor body, so it is available at every node-creation site including the lazy
  `root` getter). Every node-creation site now stamps `this.owner` (or `tree.owner` inside the static
  `buildFrom`): the lazy `root` getter, `clear()`, `internalInsertAt` (root-split branch), `leafInsert`
  (split leaf), `branchInsert` (split branch), and both `buildFrom` levels (leaf pack + branch levels).
  The three ownership checks became token comparisons — `mutableLeaf` (`leaf.owner !== this.owner`),
  `mutableBranch` (`branch.owner === this.owner`), `replaceRootward` (`seg.node.owner === this.owner`)
  — and the two clone calls now pass `this.owner`.
- **`src/nodes.ts`** — both node classes replace `tree?: BTree<any,any>` with `owner?: symbol` (still
  optional: hand-built test nodes have no owner and need none); `clone(newTree)` became
  `clone(newOwner: symbol)`; the `import type { BTree }` is gone entirely (nodes.ts no longer depends on
  b-tree.ts), which removes the `BTree<any,any>` type erasure the module was previously forced into.
  This is the "F10" item in `doc/review.html`, now marked Resolved.
- **`test/helpers/invariants.ts`** — `assertOwnershipInvariant` checks 1 & 2 translated
  (`node.tree === child` → `node.owner === child.owner`); surrounding comments updated.
- **COW test suites** — every node-owner assertion translated from `expect(node.tree).to.equal(tree)`
  to `expect(node.owner).to.equal(tree.owner)`, plus the `countOwned` helper and the direct
  node-construction sites in `test/invariants.test.ts` (which pass the owner positionally — these do
  NOT match a `.tree` grep, so watch for them).
- **New retention test** — `test/b-tree.cow-clearbase.test.ts`, "a shared node carries only an owner
  TOKEN...": derives a child that shares an untouched base subtree, `clearBase()`s it, then asserts
  every node reachable from the flattened child carries only a `Symbol` owner, has no `'tree'` property,
  and exposes no property that is a `BTree` instance. This is a direct object-graph assertion (not a GC
  test) that pins the structural win: a detached child cannot pin its former base chain.
- **Docs** — `AGENTS.md` node description updated to "owner token" wording; `doc/review.html` F10 marked
  Resolved in both the summary table and the finding body.

## Why it matters (the point of the change)

Previously a node held the whole `BTree`, which transitively retained the comparator closure, the
key-extractor closure, and the **entire base chain** of tree objects. A shared node therefore kept its
owning tree — and its history — reachable, so the base chain survived `clearBase()`/`clear()` for as
long as any shared node from it was alive. The token makes prompt release **structural** rather than
correct-by-current-implementation: a cleared child *cannot* retain its base chain because nodes never
point at trees to begin with.

## Reviewer: where to focus / what to test

- **Ownership-check parity is the correctness crux.** The whole change hinges on `node.owner ===
  this.owner` being semantically identical to the old `node.tree === this`. Confirm every one of the
  seven node-creation sites stamps a token (a *missed* site leaves a freshly-split node unowned →
  needless re-clone, or a misfired ownership check). The full COW suite (insert / delete / fork /
  mutation-ops / feature-matrix / clearbase / oracle-fork) exercises these and is green; treat it as the
  floor, not the ceiling.
- **`buildFrom` stamps `tree.owner`, not `this.owner`.** It builds from a `tree` local, not `this`.
  Worth an eyeball — a `this.owner` there would compile fine (static method has no `this.owner`… it
  would actually be a type error, so it's self-guarding, but confirm the intent).
- **The retention test is a proof, not just a regression.** It asserts the *absence* of any BTree
  back-reference on reachable nodes. If you want to stress it, extend it to a multi-level base→child→
  grandchild chain and assert the same on the grandchild after `clear()` (the design notes this is
  already covered functionally by the deep-chain fork tests, but a second retention-style assertion at
  depth would harden it).
- **Public-visibility tradeoff — a deliberate decision, please sanity-check it.** `owner` is public on
  both `BTree` and the node classes. Rationale (documented in the F10 finding and the ticket): the
  ownership-invariant helper and ~40 test assertions compare a node's owner against a specific tree, and
  the minimal readable translation is `node.owner === tree.owner`, which needs `tree.owner` reachable. A
  `Symbol` exposes no internal state and cannot be usefully forged (nodes are already fully
  constructible in tests), so the cost is one extra public field on `BTree`. If the reviewer prefers
  keeping `BTree.owner` non-public, the alternative is a white-box `(tree as any).owner` reach-in at
  every assertion site — rejected here for readability, but it's a legitimate call to revisit.

## Known gaps / honest notes

- **`doc/review.html` F1 and F4 snippets still show the old `.tree`.** These are point-in-time review
  records for *already-resolved* findings (F1 shallow-clone code sample at ~line 109; F4 fast-path
  snippet `branch.tree === this` at ~line 166). I deliberately left them as historical artifacts — the
  ticket scoped only F10. If the project treats `doc/review.html` as living documentation rather than a
  findings log, those two snippets are now stale and would want a follow-up sweep. Flagging, not fixing.
- **`docs/` generated typedoc is not regenerated here** (same standing situation as prior tickets — it
  regenerates only at release and is already several tickets behind). No new drift introduced by this
  change beyond the node type signature.
- **No persistence/serialization path exists**, so the non-serializable `Symbol` token breaks nothing
  today. Confirmed there is no `JSON`/`structuredClone` round-trip of a node's owner. If serialization
  is ever added, the token is per-tree-unique and *not* serializable by design — see the tripwire below.

## Review findings

- Left `doc/review.html` F1/F4 historical code snippets showing the old `node.tree` untouched (parked as
  a note above, not a ticket) — they are resolved-finding artifacts, out of this ticket's F10 scope.
- Recorded the token's non-serializability as a code-adjacent tripwire (below), not a ticket — it is
  purely conditional on a persistence feature that does not exist.

## Tripwires (conditional — not tickets)

- **Token is not serializable.** `Symbol()` is unique per tree and cannot survive a serialize/deserialize
  round-trip. The codebase has no persistence path today, so nothing breaks. *If* a persistence or
  structured-clone feature is ever added that round-trips nodes, the owner token must be re-established
  on load (re-stamp reachable nodes with the fresh tree's `owner`), not naively serialized. Recorded
  here in the handoff index; the concept is also documented at the `owner` field in `src/b-tree.ts` and
  the header comment in `src/nodes.ts`.
- **`mutableBranch` owned-branch fast path stays correct only while ownership is upward-closed.** Carried
  verbatim from before this change (the `NOTE:` at the fast path in `src/b-tree.ts`): the change swapped
  the compared value (`branch.owner === this.owner`) but not the invariant it relies on. `assertOwnership
  Invariant` check 1 is the guard.

## Validation performed

- `yarn build` — clean (tsc exit 0, `dist/` regenerated).
- `yarn test` — **338 passing, 0 failing** (~34s), including the new retention test. No pre-existing
  failures surfaced; no `.pre-existing-error.md` written.
- Grep-confirmed: no `node.tree` reads remain in `src/` or translated tests; the two fixture `.tree`
  properties (`b-tree.options.test.ts` `dflt.tree`/`checked.tree`, `b-tree.perf-descent-range-end.test.ts`
  `a.tree`/`b.tree`) remain untouched as intended.
