description: Moved the copy-on-write "base tree" argument out of its own constructor slot and into the options object, so the tree's constructor now looks the same as the upstream project we track; this is a breaking change shipped as the 1.0 release.
prereq:
files: src/b-tree.ts (BTreeOptions interface ~44-59; constructor ~151-175; buildFrom ~247-256; warnDeprecatedPositionalBase helper at end of file), readme.md (COW example ~97, migration note after ~113, options section ~180-197), package.json (version), test/b-tree.options-base.test.ts (new), plus ~14 migrated test files + bench/index.ts
difficulty: medium
----

## What was decided and built

The blocked decision picked **option (b)**: move the copy-on-write base tree from a dedicated positional
constructor argument into the options object, as a one-time breaking change timed to the **1.0** major bump
(owner's call, recorded in the source ticket). Implemented in full.

### The change, plainly

Before (pre-1.0): the third constructor argument was polymorphic — either a base tree OR a `BTreeOptions`
object, disambiguated at runtime by `instanceof`, with options pushed to a fourth argument when a base was
present.

After (1.0): the third argument is **only** `options`, and a base is one field on it:

```ts
// old:  new BTree(keyFromEntry, compare, baseTree)
// old:  new BTree(keyFromEntry, compare, baseTree, { freeze: false })
// new:  new BTree(keyFromEntry, compare, { base: baseTree })
// new:  new BTree(keyFromEntry, compare, { base: baseTree, freeze: false })
```

`BTreeOptions` became generic (`BTreeOptions<TKey = unknown, TEntry = unknown>`) so it can type the new
`base?: BTree<TKey, TEntry>` field. The two tuning flags (`freeze`, `checkComparator`) are unchanged and
still default safe.

### Why the positional form is now a hard TS error (important, and a mild surprise)

Adding a **public** `base` to `BTreeOptions` collides with `BTree`'s pre-existing **private** `base` field.
That collision means a bare `BTree` is no longer assignable to `BTreeOptions`, so the old positional call
`new BTree(kfe, cmp, baseTree)` is now a TypeScript **compile error** (TS2345: "Property 'base' is private in
type 'BTree' but not in type 'BTreeOptions'"). This is the intended clean break for a major bump — TS callers
must migrate — but the error text is generic and does not itself say "use `{ base }`". The readme migration
note and the constructor doc comment spell out the fix.

For **JavaScript / untyped** callers (who can still pass a `BTree` positionally), a runtime shim in the
constructor detects it (`options instanceof BTree`), forwards it as `{ base }`, and logs a **one-time**
`console.warn`. This fallback is documented as removable in a future release.

### base-immutability guard wiring

The guard reads the base from the same place the base now arrives from: `base = options?.base`, then
`this.base = base`, `this._count = base.getCount()`, `this.baseVersion = base.chainVersion()`. The
construct-off-a-corrupted-intermediate-base throw path (via `base.getCount()` → `checkBase`) is preserved and
still tested.

### buildFrom

`BTree.buildFrom` accepts `BTreeOptions<TKey, TEntry>` for signature parity but **deliberately ignores any
`base`** (forwards only `freeze`/`checkComparator`), because a bulk-loaded tree is always standalone. Noted in
code and readme.

## How to exercise / validate

- **Type + build + full suite (all run, all green):**
  - `npx tsc --noEmit -p tsconfig.json` → clean
  - `yarn build` → clean (exit 0)
  - `yarn test` → **347 passing**
- **New tests: `test/b-tree.options-base.test.ts`** — the focused surface for this change:
  - base via `{ base }` round-trips COW inheritance (child shares base, base untouched); multi-level chain.
  - base + `freeze:false` + `checkComparator` all applied from one options object; freeze defaults to true
    with base alone; base-absent/options-present; nothing-supplied standalone defaults.
  - **generic inference** from `options.base` with no explicit type args (compile-time, asserted via behavior).
  - `buildFrom` ignores a passed base (result is standalone and unguarded; still honors `freeze:false`).
  - **deprecation fallback**: positional base (via `as any`) still forwarded at runtime and warns **once**.
- **Migration coverage:** every pre-existing COW test (~14 files + `bench/index.ts`) was mechanically migrated
  from the positional base to `{ base }`, so the entire existing COW/base-immutability/clearbase/flatten/
  root-cache suite now exercises the new path.

## Reviewer starting points — known gaps & judgement calls (treat tests as a floor)

1. **Warn-once test is a deliberate canary.** `test/b-tree.options-base.test.ts`'s deprecation test asserts
   the warning fires **exactly once**, which holds only because this is the *sole* positional-base call site
   left in the suite (the module-level warn flag is process-global and not resettable — no test seam was
   added for it). If a future test adds another positional caller earlier in run order, this reads 0 and
   fails — intended as a nudge to migrate that call. Verify you're comfortable with that coupling; the
   alternative (warn every call, trivially testable but noisier) was considered and rejected for DX.
2. **Cryptic TS error for the break.** The TS2345 "base is private" message is the migration signal for TS
   users but doesn't name the `{ base }` fix. Couldn't improve the compiler text; mitigated via readme +
   doc comment. Judge whether that's an acceptable upgrade experience.
3. **buildFrom silently ignores `base`.** Chose silent-ignore (to honor "always standalone") over throwing on
   a stray base. A reviewer might prefer a throw/assert; low stakes, easy to change.
4. **Generated/historical docs still show the old union.** `docs/` (typedoc output, regenerated by `yarn doc`
   at prepublish) and `doc/review.html` (the historical review artifact that spawned this ticket) still
   mention `BTree | BTreeOptions`. Left untouched on purpose — not hand-editing generated output, and the
   review artifact is a point-in-time snapshot. `AGENTS.md`'s generic `BTreeOptions` mention stays accurate.
5. **Runtime behavior of the shim wasn't driven through a real JS entrypoint** — it's exercised via `as any`
   in TS tests, which reproduces the same runtime call shape. If you want belt-and-suspenders, a tiny compiled
   `.mjs` smoke test could confirm the JS path, but the code path is identical.

## Interactions confirmed
- Sibling `7-ownership-token` already landed (in `complete/`); this built on current `main`, no parallel
  base-handling rewrite.
- Type inference from `options.base` verified (test + clean tsc).
- readme parity done (COW example, options section, migration note, new `base` option bullet).
