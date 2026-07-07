description: Added tests that combine the copy-on-write tree-sharing feature with the newly merged tree capabilities (bulk load, the options-taking constructor, clear, counts, delete-while-iterating), plus a randomized fork oracle, so their interactions can't silently regress.
prereq:
files: test/b-tree.cow-feature-matrix.test.ts, test/b-tree.cow-oracle-fork.test.ts, src/nodes.ts (NOTE comment only), test/helpers/invariants.ts, test/b-tree.oracle.test.ts
difficulty: medium
----
Copy-on-write (COW) inheritance lets a child tree share its base tree's nodes until the child mutates, at
which point the touched node (and its rootward path) is cloned and re-stamped to the child. The upstream
Digitree v1.5.0 merge added several capabilities — `BTree.buildFrom` (O(n) bulk load), the four-argument
constructor form `new BTree(keyFromEntry, compare, base, options)`, the O(1) stored count, a `clear()` that
drops the base, and a `deleteAt` that re-stamps its path for delete-while-iterating — but nothing exercised
any of them *together with* COW sharing. This ticket added that coverage: two new test files, 13 cases, all
passing. **No production behavior changed** — the only non-test edit is one `NOTE:` comment in `src/nodes.ts`
(the tripwire below).

## What landed (implement stage)

- **`test/b-tree.cow-feature-matrix.test.ts`** (11 cases) — COW × each merged capability at its intersection
  with the COW layer: a bulk-loaded (`buildFrom`) base under a mutating child (structural + randomized
  differential vs a shadow Map); `clear()` on a derived child (drops base, installs fresh empty root, shares
  no former-base node — distinct from `clearBase()`); O(1) counts after derive / after mutation / through a
  `base -> c1 -> c2` chain / the partial `getCount({ path })` overload; the 4-arg `{ freeze:false }`
  constructor form taking effect and still owner-stamping COW clones; delete-while-iterating across a clone
  boundary (`deleteAt` clones the leaf, remaps + re-stamps the path, `moveNext` recovers with no re-find).
- **`test/b-tree.cow-oracle-fork.test.ts`** (2 seeded cases) — a COW counterpart to
  `test/b-tree.oracle.test.ts`: drive a warmed-up multi-level base for the first half of a random op stream,
  fork a child, drive the second half against the child, each tree checked against its own independent
  `Map` + sorted-key model, with ownership + base-immutability re-verified at a stride.
- **`src/nodes.ts`** — one `NOTE:` comment at `LeafNode.clone` (the tripwire); no code change.

## Review findings

**Scope reviewed:** read the full implement diff (26659b8) with fresh eyes *before* the handoff summary —
both new test files in full, the `src/nodes.ts` NOTE, and every reused helper in `test/helpers/invariants.ts`
(`assertTreeInvariants`, `assertOwnershipInvariant`, `snapshotBase`, `reachableNodesOf`,
`sharedReachableNodes`). Cross-checked every behavioral claim the tests pin against the actual source in
`src/b-tree.ts`: the 4-arg constructor overload (`baseOrOptions | options`, lines 105–120), `clear()`
dropping the base + installing a fresh root (493–498), `clearBase()` as a mere pointer drop (146–149), the
`root` getter falling through to the base (122–131), and the `getCount({ path })` partial-walk overload
(511+). All match what the tests assert. Confirmed the test-local `childIndex`/`leafForKey` faithfully mirror
the tree's routing. Ran `npm run build` (tsc, **clean**) and the full `npm test` suite (**298 passing**, ~52s,
including these 13). No `.pre-existing-error.md` written — no unrelated failures surfaced.

- **Correctness / behavior pinning** — Sound. Every case asserts genuinely *current* behavior and passes. The
  ownership + base-immutability assertions (`assertOwnershipInvariant` + `snapshotBase`) are the real teeth,
  not the incidental `expect`s.
- **Efficacy (teeth) — VERIFIED, not assumed.** Per the handoff's suggested spot-check, temporarily broke
  `LeafNode.clone` owner-stamping (stamped the clone with the base owner instead of the child) and re-ran only
  the two new files: **10 passing / 3 failing** — the buildFrom-base, freeze:false-clone, and
  delete-while-iterating cases all failed on the ownership/base-immutability checks, exactly the regressions
  they exist to catch. Reverted the mutation immediately (`git diff` clean vs HEAD; the tree carries only the
  committed NOTE). These nets have teeth.
- **Contract-respecting oracle shape** — Correct call. The fork oracle drives the base only *before* the fork
  and the child only *after*, keeping the base frozen while a derived child is live. Driving the base
  post-fork would violate the documented base-immutability contract (a live child reads un-rewritten nodes
  straight from `base.root`) — the handoff is honest about this and the shape is right. Two
  independently-mutating views are already covered by `test/b-tree.cow-fork.test.ts`.
- **Test-logic false-pass audit** — None found. Spot-audited the risk-prone spots: `clear()`'s
  "shares no node" (fresh empty leaf vs former-base node set — meaningful, distinguishes `clear` from
  `clearBase`); the freeze:false mutability probe (relies on `get`/`at` returning the live stored entry, which
  is the documented non-aliasing-free path — valid); the randomized differential's fractional-key minting
  (unique per op via a monotonic counter, cannot collide within the op budget). No tautological assertions.
- **Docs** — No doc drift. This is a tests-only change; the one behavior it *touches on* (freeze being shallow,
  best-effort, non-transitive) is already documented in `readme.md` / `AGENTS.md`, and the tripwire is parked
  at its exact code site. Nothing to update.
- **Honest gaps (from the handoff, confirmed accurate, no action)** — buildFrom bases skew toward split-clones
  over borrow/merge-clones (heavy borrow/merge-under-COW coverage already lives in
  `test/b-tree.cow-fork.test.ts` / `test/b-tree.cow-mutation-ops.test.ts`); freeze:false × COW is pinned
  functionally, not stress-tested (standalone stress in `test/b-tree.options.test.ts`); op counts tuned for
  `yarn test` speed with env-var overrides (`COW_ORACLE_*`). All are reasonable scoping, not defects.
- **Major findings → new tickets** — **None.** Nothing rose to a new fix/plan/backlog ticket.

## Tripwire (parked — not a ticket)

`LeafNode.clone` (`src/nodes.ts`) uses `structuredClone`, which does **not** preserve `Object.freeze`. So for
a *freeze:true* COW child, entries it inherited-but-never-rewrote become **unfrozen** copies once their leaf is
cloned (the untouched neighbors in that leaf, not just the written entry). Base isolation is unaffected — the
base keeps its own frozen originals; only the child's shallow freeze *guard* is absent on those cloned
neighbors. This is within the documented latitude of the freeze feature (shallow, non-transitive, best-effort
per `readme.md`), so it is genuinely conditional — a real defect only *if* the child-side freeze guard is ever
required to survive cloning, at which point `clone` would re-freeze under the owner's freeze option.

Reviewer's assessment: agree this is a tripwire, not a `debt-`/`bug-` ticket. It is not "definitely wrong the
moment a dormant path runs" — freeze:true never promised durable/transitive freezing, so losing the guard on
cloned neighbors degrades a deterrent, it does not break a contract. Parked as a one-line `NOTE:` at the exact
site (the only non-test edit in the diff). Recorded here per the tripwire rule; index only — the analysis
lives at the code site.
