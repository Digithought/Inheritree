description: Moved the copy-on-write "base tree" argument out of its own constructor slot and into the options object, so the tree's constructor now matches the upstream project we track; shipped as the breaking 1.0 release.
prereq:
files: src/b-tree.ts (BTreeOptions interface; constructor; buildFrom; warnDeprecatedPositionalBase), readme.md, package.json, test/b-tree.options-base.test.ts, test/helpers/invariants.ts, ~14 migrated COW test files, bench/index.ts
difficulty: medium
----

## What shipped

The copy-on-write **base tree** moved from a dedicated positional third constructor argument into a
`base?` field on the options object, timed to the **1.0** major bump (owner's decision, from the source
`blocked/` ticket). `BTreeOptions` became generic (`BTreeOptions<TKey = unknown, TEntry = unknown>`) so it
can type `base`.

```ts
// old (pre-1.0):  new BTree(keyFromEntry, compare, baseTree)
// new (1.0):      new BTree(keyFromEntry, compare, { base: baseTree })
```

Because `BTreeOptions.base` is public while `BTree`'s own `base` field is private, a bare `BTree` is no
longer assignable to `BTreeOptions` — so the old positional call is a hard **TS2345** compile error, which
is the intended clean break. Untyped-JS callers who still pass a base positionally are caught by a runtime
`instanceof BTree` shim that forwards it as `{ base }` and logs a one-time `console.warn` (documented as
removable later). `buildFrom` accepts `BTreeOptions` for signature parity but deliberately ignores `base`
(bulk-loaded trees are always standalone).

## Review findings

Reviewed the implement diff (`4a4b63b`) with fresh eyes before the handoff, then scrutinized the full
constructor/`buildFrom`/options surface and every file the change touched (plus files it *should* have —
`test/helpers/invariants.ts`, `readme.md` options+COW sections, `AGENTS.md`).

**Validation (all green):**
- `npx tsc --noEmit -p tsconfig.json` → clean (exit 0).
- `yarn test` → **347 passing** (48s).
- **Independently verified the core premise** the whole break rests on: compiled a throwaway positional-base
  call and confirmed it errors with `TS2345: Property 'base' is private in type 'BTree' but not in type
  'BTreeOptions'`. The clean break is real, not assumed.
- Grepped the whole `test/`+`bench/` tree for positional-base constructions: the only one left is the
  deprecation canary in `b-tree.options-base.test.ts` (via `as any`). Confirms the warn-once test's
  "exactly one warning" assertion holds and the migration was complete.

**Checked — correctness / type-safety / API:** constructor base-wiring (`base = options?.base`, count seed,
`baseVersion` snapshot, `else` no-base guard path) preserved; deprecation shim can't misfire on the plain
options object `buildFrom` forwards (it's never a `BTree`); generic inference from `options.base`; readme COW
example, options section, and migration note all reflect `{ base }`. No defects found here.

**Found & fixed inline (minor):**
- `test/helpers/invariants.ts:221` — a doc comment still showed the removed positional form
  `new BTree(keyFn, cmp, base)`. Updated to `{ base }`. (File wasn't in the diff; it's exactly the kind of
  stale doc adjacent to the change.)

**Tripwires (recorded, not ticketed):**
- **`buildFrom` forwards tuning options by an explicit whitelist** (`{ freeze, checkComparator }`), so a
  future *new* non-base tuning flag added to `BTreeOptions` would be silently dropped from bulk loads. Fine
  now (only two flags exist); parked as a `// NOTE:` at the site in `src/b-tree.ts` (`buildFrom`) telling the
  next maintainer to add new tuning fields there. Whitelist chosen deliberately over `{ base, ...rest }`
  spread so a stray `base` can never leak in.
- **Warn-once flag is process-global and not test-resettable**, so the deprecation test's "exactly one
  warning" assertion is order-coupled to being the sole positional-base caller. Already documented in the
  test's own comments and the implementer's handoff; the assertion is a deliberate canary that fails loudly
  if another positional caller is introduced. No change — acknowledged as-is.

**Deliberately left (agreed with implementer's judgement calls):**
- The **TS2345 message doesn't name the `{ base }` fix** — can't edit compiler text; mitigated by the readme
  migration note + constructor doc comment. Acceptable upgrade experience for a major bump.
- **`buildFrom` silently ignores a stray `base`** rather than throwing — consistent with "always standalone",
  covered by a test, low stakes.
- **Generated/historical docs** (`docs/` typedoc output regenerated at prepublish; `doc/review.html` snapshot)
  still show the old `BTree | BTreeOptions` union — not hand-editing generated/point-in-time artifacts.
  `AGENTS.md`'s generic `BTreeOptions` mention stays accurate.

**No new tickets filed** — nothing rose to major. No pre-existing test failures surfaced.

## Interactions confirmed
- Built on current `main`; sibling `7-ownership-token` already in `complete/`, no parallel base-handling
  rewrite.
- Type inference from `options.base` verified (test + clean `tsc`).
