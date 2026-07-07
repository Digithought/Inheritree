description: Make a derived tree throw a clear error the next time it is used after its base tree was illegally modified, instead of silently returning corrupted data.
prereq:
files: src/b-tree.ts, test/b-tree.cow-clearbase.test.ts, test/b-tree.base-immutability-guard.test.ts, readme.md
difficulty: hard
----

## Decision (resolved in plan)

**Build option (a): a runtime version guard.** Rationale:

- **(a) chosen.** The codebase already has the machinery to make it nearly free: every tree keeps a
  `_version`, and every public operation funnels through a small number of chokepoints. An O(1) guard on
  those chokepoints covers every entry point. It converts a currently-silent corruption into a loud,
  immediate error.
- **(b) already shipped.** "Truly-isolating `clearBase`" is `BTree.flatten()` (`src/b-tree.ts:160`,
  documented in `readme.md`). It rebuilds the tree's entries into a fresh, node-disjoint standalone tree in
  one O(n) pass. Nothing more to build for (b); the post-`clearBase()` shared-node hazard's escape hatch is
  therefore *already available* — this ticket only needs to point at it, not build it.
- **(c) rejected.** The merge that seeded a child's `_count` from its base (`src/b-tree.ts:113`) raised the
  stakes: a base-immutability violation now *also* silently skews the child's O(1) count even when the
  shared nodes survive structurally intact. A silent, data-dependent count drift is worth converting to a
  loud error.

## What the guard is (and is not)

**Is:** a *detect-on-next-use* guard. When a base is mutated while a derived child is live, the child does
not find out at the moment of mutation — the base has no back-reference to its children. Instead, the
child's **next operation** notices its base's version no longer matches the snapshot it took at construction
and throws `MutatedBaseError`.

**Is not:** a prevent-at-mutation guard. The base mutation itself still succeeds silently. And it cannot
cover a **detached** child: after `clearBase()` the child has `base === undefined`, so there is no base
version left to compare — the shared-subtree hazard from that point on stays unguardable (use `flatten()`
up front if you need true isolation).

## Design

Every tree already maintains a coarse `_version` (bumped once per mutation) and starts a derived child's
`_count` from its base at construction. Add three private members plus a small set of guard calls.

```ts
/** Thrown when a derived tree is used after its base was mutated (the base-immutability contract was
 *  violated).  Detect-on-next-use: surfaces on the child's next operation, not at the base's mutation. */
export class MutatedBaseError extends Error {
  constructor(message = "Base tree was mutated while a derived child was live (base-immutability contract violated)") {
    super(message); this.name = "MutatedBaseError";
  }
}
```

In `BTree`:

```ts
private readonly baseVersion: number;   // snapshot of base.chainVersion() taken at construction (0 if no base)

// constructor, in the `baseOrOptions instanceof BTree` branch, alongside the existing _count seeding:
this.baseVersion = this.base.chainVersion();
// ...and in the else branch / after: default it to 0 when there is no base.

/** This tree's version plus everything it inherits up the base chain.  O(chain depth); chains are short.
 *  A mutation ANYWHERE up the chain changes this total, so a single comparison detects it at any level. */
private chainVersion(): number {
  return this._version + (this.base ? this.base.chainVersion() : 0);
}

/** Throw if the base chain has been mutated since this tree snapshotted it at construction. */
private checkBase(): void {
  if (this.base && this.base.chainVersion() !== this.baseVersion) throw new MutatedBaseError();
}
```

**Note `chainVersion()` excludes vs. includes self correctly:** the snapshot is `this.base.chainVersion()`
(the base's total, *not* including this child's own `_version`), and `checkBase()` recomputes
`this.base.chainVersion()`. The child's own mutations bump only `this._version`, which is not part of that
comparison — so a child mutating *itself* never trips its own guard. Only a change up the *base* chain does.

### Guard call sites — the complete chokepoint set

The F2 sketch named the root getter and `isValid`. Auditing every public entry point turns up **two escape
routes the sketch missed** — the O(1) count reads — so the full set is:

- **`get root()`** (top of the getter) — covers every fresh operation: `find`/`get`/`first`/`last`/
  `insert`/`upsert`/`merge` all resolve through it.
- **`validatePath()`** (top, before the `isValid` check) — covers every path-based operation: `at`,
  `moveNext`/`movePrior`, `updateAt`, `deleteAt`, `ascending`/`descending`, `getCount(from)`. **Put the
  guard here, not in `isValid`:** `isValid(path)` is a *public boolean predicate* and must stay
  side-effect-free / total; `validatePath` is the throwing wrapper every path op already funnels through.
  (Consequence to accept and document: a user who calls `isValid()` directly on a stale-base path still
  gets `true` — their path version matches the child's own version — but their next *real* op throws.)
- **`get size()`** and **no-arg `getCount()`** — these return `this._count` **directly**, bypassing both the
  root getter and `validatePath` (`src/b-tree.ts:518`, `:527-530`). This is exactly the seeded-`_count`-skew
  path the guard most needs to catch, so add an explicit `checkBase()` at both. **Without this the headline
  count-skew scenario slips through the guard entirely.**
- **`clearBase()`** (top, before it pins `_root`) — so a base already mutated *before* `clearBase()` cannot
  be silently laundered into a detached tree. After `clearBase()` returns, `base === undefined` and the
  guard is a permanent no-op (correct — nothing left to compare).

`flatten()` needs no explicit call: it iterates via `entries()` → `ascending()` → root getter +
`validatePath`, so flattening a corrupted child already throws.

### Cost

Single-level common case: `checkBase()` is one truthiness test plus `base.chainVersion()` (one add, base has
no base) and one integer compare — effectively free. Multi-level: O(chain depth), and chains are short.

## Edge cases & interactions

- **Multi-level base chains** (base → c1 → c2): a mutation at *any* level must trip *every* descendant.
  `chainVersion()`'s recursive sum guarantees a change two levels up (base) alters c2's computed total.
  Test a mutation to `base` while `c2` is live, and separately a mutation to `c1` while `c2` is live.
- **Deferred-detection semantics:** the base mutation *itself* must succeed with no error; the
  `MutatedBaseError` surfaces only on the child's **next** operation. Assert both halves (base op returns
  normally; the very next child op throws) — this is the guard's defining, documented behavior.
- **Seeded-`_count` skew:** a violation that leaves shared nodes structurally intact but corrupts the
  child's inherited count. Cover it specifically through the O(1) reads — `child.size` and `child.getCount()`
  with no argument — since those are the members that bypass the other chokepoints. This test would PASS
  (silently return a wrong count) if the count-read guards were omitted, so it is the regression anchor for
  that easy-to-miss pair.
- **No false positives:** a child driven through a heavy op stream while its base stays untouched must never
  throw; a child mutating *itself* must never throw. Add a positive-path test (drive the existing
  `driveOps` mix, assert no `MutatedBaseError`).
- **Post-`clearBase()` is unguardable:** once detached the child has no base version to compare, so the
  three post-`clearBase()` pinned hazards in `test/b-tree.cow-clearbase.test.ts` (untouched-region leak,
  shared-region child write corrupting the former base, never-written full-alias) **stay pinned unchanged** —
  they are outside this guard's reach by construction. Do not "fix" them here.
- **`clearBase()` laundering:** mutating a base, then calling `clearBase()` on the live child, must throw at
  the `clearBase()` call (guard added there) rather than produce a detached-but-corrupt tree.
- **Existing suite interaction:** a scan (plan stage) confirms no existing test mutates a base while a
  derived child is live *except* the intended flip below. `cow-oracle-fork`, `cow-mutation-ops`,
  `cow-feature-matrix`, and `cow.test.ts`'s stress test all freeze the base after the fork point (explicit
  comments to that effect). Run the **full** suite; the only expected new failure-then-fix is the single
  live-mutation pinned test.
- **Guard overhead on the hot path:** confirm the two-integer-op single-level cost does not regress the
  mutation/read benchmarks (if a bench harness exists; otherwise a reasoning note suffices — the added work
  is one branch + one add + one compare per guarded call).

## The one pinned test that must FLIP (intended, visible diff)

In `test/b-tree.cow-clearbase.test.ts`, the "pinned hazards" group, the test:

> `'mutating a base while a derived child is LIVE leaks into the child (why the base must be frozen)'`
> (`~line 323`)

currently asserts the leak is silent:

```ts
base.deleteAt(base.find(UNTOUCHED));
expect(child.get(UNTOUCHED), "...pinned hazard").to.equal(undefined);
```

With the guard this becomes the enforced behavior — the base op still succeeds, but the child's next op
throws:

```ts
base.deleteAt(base.find(UNTOUCHED));   // succeeds silently (detect-on-next-use)
expect(() => child.get(UNTOUCHED)).to.throw(MutatedBaseError);
```

Also revise that group's **header comment** (currently: "This is currently a doc-only contract ... the tests
below PIN the current (unguarded) behavior") to say hazard #1 (mutating a live base) is now enforced by the
version guard, while the post-`clearBase()` hazards remain doc-only-and-pinned because a detached child is
unguardable. The three post-`clearBase()` hazard tests keep their current assertions.

## Acceptance

- `MutatedBaseError` exported from `src/b-tree.ts`; `baseVersion` snapshot + `chainVersion()` + `checkBase()`
  added; guard called at all five chokepoints above (root getter, `validatePath`, `size`, no-arg
  `getCount()`, `clearBase()`).
- New `test/b-tree.base-immutability-guard.test.ts` covering: deferred detection (base op succeeds, next
  child op throws), multi-level chain detection (mutation to `base` and to `c1` both trip `c2`), the
  seeded-`_count` skew via `size` and no-arg `getCount()`, the `clearBase()`-laundering throw, and the
  no-false-positive positive path. Reuse the `makeBase`/`driveOps` scale helpers pattern from
  `test/b-tree.cow-clearbase.test.ts` (multi-level: `BASE_COUNT` > `NodeCapacity`).
- `test/b-tree.cow-clearbase.test.ts`: the single live-mutation pinned test flipped to expect
  `MutatedBaseError`; its group header comment updated; the three post-`clearBase()` hazard tests unchanged.
- `readme.md`: "Base immutability contract" section updated from "currently documented, not enforced" to
  enforced-by-guard, documenting the two limitations (detect-on-next-use, and post-`clearBase()`
  unguardable → use `flatten()`); the "Help wanted" version-checking TODO removed (it is now done).
- Doc comments updated to match: the constructor `base` param's `BASE-IMMUTABILITY CONTRACT` block ("This is
  currently a documented contract, not a runtime guard") and the `clearBase` doc comment.
- Build + full test suite pass (`npm run build`, `npm test` — stream output with `2>&1 | tee`), with only
  the intended pinned-test flip as the behavioral diff.

## TODO

- Add `MutatedBaseError` class + export in `src/b-tree.ts`.
- Add `baseVersion` field, snapshot it in the constructor's base branch (default 0 otherwise).
- Add `chainVersion()` and `checkBase()` private methods.
- Insert `checkBase()` at: `get root()`, `validatePath()`, `get size()`, no-arg branch of `getCount()`,
  top of `clearBase()`.
- Write `test/b-tree.base-immutability-guard.test.ts` (deferred detection, multi-level, count-skew via
  size + getCount, clearBase laundering, no-false-positive).
- Flip the one live-mutation pinned test + update the group header comment in
  `test/b-tree.cow-clearbase.test.ts`; leave the post-`clearBase()` hazard tests as-is.
- Update `readme.md` "Base immutability contract" + remove the "Help wanted" version-check TODO.
- Update the constructor `base`-param and `clearBase` doc comments.
- `npm run build` then `npm test` (stream with `tee`); confirm green.
