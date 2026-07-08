description: The BTree constructor accepts two different kinds of value in the same slot and figures out which one it got at runtime; this needs a human call on whether to keep that flexible-but-forked shape forever or change it to match the upstream project we track (a one-time breaking change that makes future updates merge more cheaply).
prereq:
files: src/b-tree.ts (constructor, lines 110-150; root getter 152-162), readme.md (lines 88-104 copy-on-write example, 180-195 options section)
----

## Why this is a human decision, not an implement ticket

The two paths below differ by a **breaking public-API change tied to a major-version bump** and a permanent
maintenance-cost tradeoff on the fork's worst merge file. There is no defensible default an implementer
could just pick — it's a release-strategy / API-contract call for the fork owner. Hence `blocked/` for
sign-off. Once decided, this becomes a normal implement ticket (skeleton TODOs are drafted at the bottom so
whoever picks it up has a head start).

## Background (plain language)

`inheritree` is a fork that tracks an upstream B-tree project. Both projects put a **different** thing in
the constructor's third argument:

- **Upstream** puts a `BTreeOptions` object there (tuning flags: `freeze`, `checkComparator`).
- **Inheritree** already documented the **base tree** (the tree this one copy-on-write-derives from) in that
  same third position.

The current merge resolved the collision by **inspecting the value at runtime**. Today's constructor
(`src/b-tree.ts:133-150`):

```ts
constructor(
    keyFromEntry = ...,
    compare = ...,
    baseOrOptions?: BTree<TKey, TEntry> | BTreeOptions,   // <-- base OR options, decided by instanceof
    options?: BTreeOptions,                               // <-- 4th arg: options WHEN a base is in slot 3
) {
    if (baseOrOptions instanceof BTree) { /* it's a base; options come from arg 4 */ }
    else { /* it's options (or undefined) */ }
}
```

This is unambiguous — a `BTree` instance can never be mistaken for a plain options object — and it keeps
both call styles working. But a positional argument whose meaning depends on its runtime type ages poorly:
every future upstream change to the constructor lands on exactly this seam, and `b-tree.ts` is already one
of the most merge-painful files in the fork.

## The decision

**Option (a) — Keep the union as the permanent contract.**
Document the positional / `instanceof` discrimination prominently as the intended, stable API.
- Pro: no breaking change, no migration for existing callers.
- Con: the fork's constructor signature stays permanently *different* from upstream's, so this seam
  re-conflicts on every upstream constructor touch. The maintenance cost is paid forever.

**Option (b) — Migrate the base into `options.base`.**
Add an optional `base?: BTree<TKey, TEntry>` field to `BTreeOptions`; take the base from there instead of
positionally. Deprecate the positional-base form.
- Pro: the fork's constructor signature becomes **identical to upstream's**. The permanent merge surface of
  this file shrinks to just the `BTreeOptions` interface — a much smaller, more stable seam. The constructor
  stops being a conflict site at all.
- Con: a breaking API change with a deprecation path to manage; existing callers passing a positional base
  must migrate (`new BTree(kfe, cmp, base)` → `new BTree(kfe, cmp, { base })`).

## Tradeoff, stated once

(a) avoids a breaking change but keeps a recurring merge cost on the fork's worst file, indefinitely.
(b) pays a one-time migration to make every future upstream merge of the constructor substantially cheaper.
The payoff of (b) is structural: identical signatures mean the constructor is no longer a conflict site,
leaving only the options interface to reconcile.

## Recommendation (non-binding — the call is the owner's)

Lean **(b)**, timed to the next major. The fork's stated reason for existence is tracking upstream cheaply;
(b) directly serves that by collapsing the worst recurring conflict to a single small interface. The
migration is mechanical and coverable by a deprecation window. Only prefer (a) if a hard no-breaking-changes
commitment to current callers outweighs the perpetual merge tax.

## Interactions to respect whichever way it goes

- **Base-immutability guard.** The base is also central to the base-immutability version-stamping guard
  (`baseVersion`/`checkBase`, `src/b-tree.ts:88-89, 139-146, 153`). Wherever the base arrives from, the
  guard must read it from that same place. If (b) is chosen, move the guard wiring to read `options.base`
  in the same change — don't leave it pointed at a soon-to-be-deprecated argument position.
- **Sibling ownership-token work.** There is a parallel plan ticket `7-ownership-token` touching the same
  constructor/base area. Coordinate so the two changes don't both rewrite the base-handling block
  independently. If both land, sequence them (`prereq:`) rather than merging in parallel.
- **Type inference.** The `TKey`/`TEntry` generics currently infer from the positional base. Under (b),
  confirm they still infer correctly from a base passed via `options.base`.
- **readme parity.** The readme documents the positional base today (copy-on-write example at
  `readme.md:97`, options section at `readme.md:182-188`). Both must be updated to match whichever form is
  chosen, including a migration note if (b).

## Edge cases the eventual implement ticket must cover

- **Both base and options supplied.** Under (a): the four-arg form. Under (b): a single `options` object
  carrying `base`. Round-trip every option field (`freeze`, `checkComparator`) *plus* the base correctly in
  each form.
- **Deprecation window (only if b).** Decide the positional-base behavior during deprecation: throw, warn
  (e.g. `console.warn` once), or silently forward. Document the transition in the readme.
- **Base absent, options present.** Must still work (today's `else` branch: `options = baseOrOptions`).
- **Nothing supplied.** Standalone empty tree, safe defaults (`freeze: true`, `checkComparator: false`).

## Draft TODOs (for after sign-off — do NOT act until the option is chosen)

If (a) is chosen:
- Promote the union / `instanceof` discrimination to documented stable API in the constructor doc comment
  and the readme; add an explicit "why the third argument is polymorphic" note.

If (b) is chosen:
- Add `base?: BTree<TKey, TEntry>` to `BTreeOptions`.
- Read the base from `options.base`; keep positional-base accepted during the deprecation window with the
  agreed throw/warn/forward behavior.
- Re-point the base-immutability guard wiring to the new base source.
- Update readme copy-on-write example and options section; add a migration note.
- Update/add tests: base via `options.base` round-trips; positional-base deprecation behavior; generic
  inference from `options.base`; both-supplied and neither-supplied paths.
