description: A derived tree now throws a clear error the next time you use it after its base tree was illegally modified, instead of silently returning corrupted data.
files: src/b-tree.ts, test/b-tree.base-immutability-guard.test.ts, test/b-tree.cow-clearbase.test.ts, test/helpers/invariants.ts, readme.md, AGENTS.md
difficulty: medium
----

## What shipped

A **detect-on-next-use** runtime guard turning the previously doc-only base-immutability contract into an
enforced one. When a `base` tree is mutated while a derived child is still live, the base op itself still
succeeds silently (a base has no back-reference to its children), but the child's **next** operation throws
the new `MutatedBaseError` instead of returning a corrupted view (or a silently-skewed O(1) count).

### Mechanism (src/b-tree.ts)

- **`MutatedBaseError`** — new exported error class (auto-exported via `src/index.ts`'s `export *`).
- **`private readonly baseVersion`** — snapshot of `base.chainVersion()` taken at construction (0 when no
  base).
- **`chainVersion()`** — `this._version + (base ? base.chainVersion() : 0)`; O(chain depth). A mutation
  anywhere up the base chain changes this total, so one comparison detects it at any level. The snapshot is
  `base.chainVersion()` (NOT including the child's own `_version`), so a child mutating *itself* never trips
  its own guard — only a change up the base chain does.
- **`checkBase()`** — throws `MutatedBaseError` if `base && base.chainVersion() !== baseVersion`; no-op when
  there is no base.

### The five guard chokepoints (the complete set)

`checkBase()` is called at:
1. **`get root()`** — covers every fresh op (find/get/first/last/insert/upsert/merge/range/entries/flatten).
2. **`validatePath()`** — covers every path op (at/moveNext/movePrior/updateAt/deleteAt/ascending/descending
   /getCount(from)). Deliberately **not** in `isValid()` (that stays a side-effect-free public predicate).
3. **`get size()`** — reads `_count` directly, bypassing 1 & 2.
4. **no-arg `getCount()`** — same direct `_count` read.
5. **top of `clearBase()`** — refuses to launder an already-mutated base into a detached tree; after
   `clearBase()` the guard is a permanent no-op (base is gone).

## Use cases for testing / validation / usage

### The behavior to exercise
- **Deferred detection:** `base.deleteAt(...)` returns normally; the very next `child.get(...)` throws
  `MutatedBaseError`. Both halves matter — assert the base op does NOT throw *and* the child op DOES.
- **Multi-level chains (base → c1 → c2):** mutating `base` (two levels up) OR `c1` (immediate base) both trip
  `c2`. Mutating `c1` does **not** trip `c1` itself.
- **Seeded-`_count` skew:** `child.size` and no-arg `child.getCount()` throw after a base mutation — these
  bypass root/validatePath, so they are the easy-to-miss pair. (Without their explicit guard these would
  silently return a stale count; the new tests are the regression anchor for exactly that.)
- **`clearBase()` laundering:** mutate base, then `child.clearBase()` throws (base pointer left intact); on an
  untouched base `clearBase()` succeeds and the now-detached child no longer guards.
- **No false positives:** a heavy self-mutation op stream on a child with an untouched base never throws;
  a standalone (base-less) tree never throws.

### Tests (the floor — treat as a starting point, not exhaustive)
- **New:** `test/b-tree.base-immutability-guard.test.ts` — 13 `it()`s across the five groups above, plus an
  enumeration test hitting all root-getter / count-read / clearBase entry points and a separate one for all
  validatePath-based ops. Bases are built at scale (`BASE_COUNT=400 > NodeCapacity`) so the child genuinely
  shares multi-level structure with its base — the exact case the guard protects. Helpers mirror
  `cow-clearbase.test.ts` (`makeBase`/`driveOps`).
- **Flipped (intended, visible behavioral diff):** in `test/b-tree.cow-clearbase.test.ts`, the pinned test
  *"mutating a base while a derived child is LIVE..."* now asserts the base op succeeds silently and the
  child's next op throws `MutatedBaseError` (was: silently returns `undefined`). Its group/section header
  comments and the top-of-file doc block #2 were updated to say hazard #1 is now enforced while the three
  post-`clearBase()` hazards stay doc-only-and-pinned (a detached child is unguardable). Those three hazard
  tests are **unchanged**.
- **Docs:** `readme.md` *Base immutability contract* rewritten from "documented, not enforced" to
  enforced-by-guard, spelling out the two limitations (detect-on-next-use; post-`clearBase()` unguardable →
  use `flatten()`); the *Help wanted* version-checking TODO removed. Doc comments on the constructor `base`
  param and `clearBase()` updated. `AGENTS.md` core-concepts note updated too.

### Build + test status
- `npm run build` — clean.
- `npm test` — **329 passing, 0 failing** (~37s). The only behavioral diff from before is the intended
  pinned-test flip.

## Reviewer: scrutinize these (honest gaps / scope notes)

- **Out-of-`files`-list change — `test/helpers/invariants.ts`.** Necessary and NOT anticipated by the plan.
  `assertOwnershipInvariant`/`snapshotBase` are white-box validators whose job is to detect base mutation via
  node-identity/key diffing. They read `child.root`, which now trips the new guard *before* their own
  detection runs — breaking three of their self-tests (they deliberately mutate a base then expect the
  helper's own `/Base mutation/` error). Fix: a new module-private `effectiveRootInternal(tree)` resolves the
  effective root through internal `_root`/`base` fields, bypassing the guard, so the helper's richer detection
  still runs. Applied to the `childRoot`/`baseRoot` reads and the check-3 node-identity read. **Please confirm
  this is the right call** vs. changing those three tests to expect `MutatedBaseError` (rejected here because
  that would leave the helper's own key/identity detection branches untested). No production code depends on
  this helper; it is test-only.
- **`clear()` is intentionally un-guarded.** It empties the tree and detaches the base without reading shared
  structure, so it can't surface corruption — but it is the one mutation method not in the chokepoint set.
  Confirm that's acceptable (the plan's five-site set omits it).
- **`isValid()` on a stale-base path still returns `true`.** By design (it compares the path's version to the
  child's own `_version`, which a base mutation doesn't change). The user's next *real* op throws. Documented,
  but worth a second look if any caller trusts `isValid()` as a corruption check.
- **Coarse detection.** The guard fires on ANY base mutation, even a no-op-looking one, because `_version`
  bumps unconditionally. That's the intended (safe) coarseness, consistent with the existing path-version
  model. Not a false positive in the harmful sense, but a caller who "just re-reads the base then the child"
  will see the throw.
- **Overhead is unbenchmarked.** No bench harness was run; the added cost is one branch + one add + one
  compare per guarded call in the single-level common case (`base` has no base). Reasoning-only per the plan.

## Tripwire (parked, not a ticket)

- `chainVersion()` is O(base-chain depth) and runs on every guarded op. Fine now — COW base chains are short
  in all current usage. Parked as the doc comment on `chainVersion()` in `src/b-tree.ts` ("O(chain depth);
  chains are short"): *if* deep base chains (many-level `base → c1 → c2 → …`) ever become common and the
  guard shows up as hot, cache/propagate a chain-version instead of recomputing per call.
