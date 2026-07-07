description: Added tests that combine the copy-on-write tree-sharing feature with the newly merged tree capabilities (bulk load, the options-taking constructor, clear, counts, delete-while-iterating), plus a randomized fork oracle, so their interactions can't silently regress.
prereq:
files: test/b-tree.cow-feature-matrix.test.ts (new), test/b-tree.cow-oracle-fork.test.ts (new), src/nodes.ts (one NOTE comment added), test/helpers/invariants.ts (reused), test/b-tree.oracle.test.ts (template), src/b-tree.ts (behavior under test)
difficulty: medium
----
Copy-on-write (COW) inheritance lets a child tree share its base tree's nodes until the child mutates, at
which point the touched node (and its rootward path) is cloned and re-stamped to the child. The upstream
Digitree v1.5.0 merge added several capabilities — `BTree.buildFrom` (O(n) bulk load), the four-argument
constructor form `new BTree(keyFromEntry, compare, base, options)`, the O(1) stored count, a `clear()` that
drops the base, and a `deleteAt` that re-stamps its path for delete-while-iterating — but nothing exercised
any of them *together with* COW sharing. This ticket adds that coverage. **No production behavior changed;
this is tests only**, plus one `NOTE:` comment (see Tripwire below).

## What was added

Two new test files, 13 cases, all passing. They reuse the existing invariant helpers in
`test/helpers/invariants.ts` (`assertTreeInvariants`, `assertOwnershipInvariant`, `snapshotBase`,
`reachableNodesOf`, `sharedReachableNodes`) and the seeded RNG in `test/helpers/rng.ts`.

### `test/b-tree.cow-feature-matrix.test.ts` (11 cases)

- **COW over a buildFrom base** — derive a child from a *bulk-loaded* base, mutate it, and assert the child
  clones a private spine while the base stays byte-for-byte (structure + values + node identities). The point:
  bulk-loaded nodes are owner-stamped by the loader; if that stamping regressed, the child would think it
  already owns the shared nodes and mutate them in place. Plus a 1500-op randomized differential vs a shadow
  Map over a bulk-loaded base (dense-packed leaves → first interior insert into each splits).
- **clear() on a derived child** — asserts the merge's decision (an empty tree inherits nothing): base
  untouched, child empty + re-insertable, base pointer dropped, and — unlike `clearBase()` — the child shares
  **no** node with the former base (clear installs a fresh empty root). Also the never-written-child case.
- **Counts on children** — `size`/`getCount()` immediately after derive (equals base, no traversal); after
  child insert/delete (child moves, base fixed); across a `base -> c1 -> c2` chain (three independent counts,
  each cross-checked against a full traversal); no-op mutations leave the count alone; the partial
  `getCount({ path })` overload from a child cursor.
- **freeze:false via the 4-arg constructor** — pins that `new BTree(k, c, base, { freeze:false })` actually
  takes effect: a loose child stores unfrozen (mutable) entries while a default sibling off the same base
  freezes; a COW clone under freeze:false stays correctly owner-stamped and mutable; base isolation holds.
- **Delete-while-iterating across a clone boundary** — the README idiom (`deleteAt(p)` then `moveNext(p)` with
  no re-find) on a COW child, where `deleteAt` both clones the leaf, **remaps** the path onto the clone, and
  re-stamps the version onto that remapped path. A targeted single-delete case (asserts the path's leaf flips
  from base-owned to child-owned and `moveNext` lands exactly on the successor) and a full left-to-right sweep
  threading one path across many clone boundaries.

### `test/b-tree.cow-oracle-fork.test.ts` (2 seeded cases) — the strongest single addition

A COW counterpart to `test/b-tree.oracle.test.ts`. It drives the same randomized op stream (insert / delete /
upsert / merge / update / find / range, each with full return-value assertions) against a warmed-up
multi-level **base** for the first half, then **forks a child and drives the second half against the child** —
each tree checked against its **own independent** `Map` + sorted-key model. After every child mutation:
`assertTreeInvariants(child)` + count; at a stride: full ascending deep-equal vs the child model,
`assertOwnershipInvariant(child, base, snap)`, and a full re-verify of the (frozen) base against its fixed
model. Reproducible from the seed. Env overrides: `COW_ORACLE_PRE`, `COW_ORACLE_POST`, `COW_ORACLE_STRIDE`.

## How to validate

- Just the new files: `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js test/b-tree.cow-feature-matrix.test.ts test/b-tree.cow-oracle-fork.test.ts`
- Full suite: `npm test` → **298 passing** (~43s), including these 13. `npm run build` (tsc) is clean.
- Efficacy spot-check the reviewer may want: these are *regression nets*, so confirm they have teeth — e.g.
  temporarily break `LeafNode.clone` owner-stamping (pass the wrong owner) and confirm the buildFrom-base and
  oracle-fork cases fail; or make `deleteAt` skip the path re-stamp and confirm the delete-while-iterating
  cases fail. I did not leave any such mutation in the tree (`git status` on `src/` shows only the NOTE).

## Honest gaps & decisions (treat the tests as a floor)

- **The oracle fork does NOT mutate the base after forking — deliberately.** The ticket's wording ("drives
  both the base and the child") reads as if the base keeps mutating post-fork. That would **violate the
  base-immutability contract**: a live child reads un-rewritten nodes straight from `base.root`, so mutating
  the base corrupts the child's shared view (a hazard already pinned in `test/b-tree.cow-clearbase.test.ts`).
  The contract-respecting shape I implemented: drive the base *before* the fork (against the base model), fork,
  then drive the child *after* (against the child model), keeping the base frozen and re-verifying it against
  its now-fixed model every stride. Both trees are still validated against separate, independent models — a
  child write leaking into the base surfaces as base-vs-base-model divergence. If the reviewer wants two
  *independently-mutating* views, the correct COW pattern is two children off one frozen base (already covered
  by `test/b-tree.cow-fork.test.ts`'s multi-child stress) — not mutating the base.
- **buildFrom base skews toward split-clones, not borrow/merge-clones.** Bulk load packs leaves near capacity
  (64), so a single child delete from such a leaf rarely underflows → the deterministic buildFrom case
  exercises leaf-split clones far more than borrow/merge rebalance clones. The randomized differential over the
  buildFrom base does drive deletes to underflow eventually, but a reviewer wanting a *guaranteed* COW
  borrow/merge specifically off a bulk-loaded min-fill leaf would need to engineer one (buildFrom only leaves a
  possibly-min-fill final pair). The heavy borrow/merge-under-COW coverage already lives in
  `test/b-tree.cow-fork.test.ts` / `test/b-tree.cow-mutation-ops.test.ts` over insert-built bases.
- **freeze:false × COW is pinned functionally, not stress-tested.** The two freeze:false cases assert the 4-arg
  form takes effect and one clone stays mutable/owner-stamped; they don't run a long freeze:false churn (the
  standalone freeze:false stress lives in `test/b-tree.options.test.ts`).
- **Op counts are tuned for `yarn test` speed** (fork oracle: 500 base + 1500 child ops × 2 seeds). Bumping via
  the env vars stresses harder but is opt-in, mirroring the base oracle's `ORACLE_OPS`.

## Tripwire (parked, not a ticket)

While writing the freeze:false case I noticed `LeafNode.clone` (`src/nodes.ts`) uses `structuredClone`, which
does **not** preserve `Object.freeze`. So for a *freeze:true* COW child, entries it inherited-but-never-rewrote
become **unfrozen copies** once their leaf is cloned. Base isolation is unaffected (the base keeps its own
frozen originals); only the *child's* shallow freeze guard is absent on those cloned neighbors — best-effort
and non-transitive by documented design (readme.md), so fine today. Parked as a one-line `NOTE:` at the exact
site (`src/nodes.ts` `LeafNode.clone`). This is the only non-test edit in the diff. Flagging here per the
tripwire rule; not filing it as a ticket.
