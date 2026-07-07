----
description: Stop repeated lookups on a tree derived from many past versions from getting slower the longer that version history grows.
prereq: enforce-base-immutability-guard
files: src/b-tree.ts (root getter)
difficulty: easy
----
This ticket caches the resolved base root on a derived tree (code review finding F11).

## Background

A derived tree resolves its effective root by walking its `base` chain. Every `find` / `first` / `last` on a derived tree calls `this.base.root` recursively, which is O(chain length) per operation. In the snapshot-per-version pattern that Inheritree targets, these chains grow linearly with history — so read cost degrades as history accumulates.

Under the base-immutability contract, a base's effective root cannot legitimately change after a child has derived from it. That makes caching sound:

```ts
this._baseRoot ??= this.base.root;
```

## Interaction with the immutability guard (F2)

If the version guard from ticket `enforce-base-immutability-guard` lands, use a cache-then-check pattern so mutation detection stays intact: return the cached root but still validate the base version so illegitimate mutation is still detected rather than masked by the cache.

The prereq is a SOFT ordering hint, not a hard dependency. The cache is sound under the documented base-immutability contract even without the guard; landing the guard first simply keeps mutation detection correct instead of having the cache hide a contract violation.

## Edge cases & interactions

- After `clearBase()` the base becomes `undefined`; the cache must be invalidated or made irrelevant so the tree resolves its own root, not a stale cached base root.
- Multi-level chains: the cache holds the fully-resolved effective root, and each level caches its own, so a deep chain collapses to O(1) after the first resolution.
- A plain (no-base) tree must be unaffected — the root getter's no-base path should not touch or depend on `_baseRoot`.
- Cache-then-check (when the F2 guard is present): the version comparison must still run on the cached path so a contract-violating mutation is detected rather than silently served from cache.

## TODO

- Add a `_baseRoot` cache field and populate it lazily in the root getter via `this._baseRoot ??= this.base.root`.
- Ensure `clearBase()` invalidates `_baseRoot` (or otherwise makes it irrelevant when `base` is undefined).
- If/when the F2 version guard is present, switch to cache-then-check so mutation detection still fires on the cached path.
- Confirm the plain (no-base) code path does not read or write `_baseRoot`.
- Add tests: deep chain read cost is constant after warm-up; `clearBase()` then read returns the correct root; base-mutation detection (with guard) still fires.
