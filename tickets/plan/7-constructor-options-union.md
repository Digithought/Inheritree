----
description: This project and the upstream project it tracks each expect a different kind of value in the same constructor slot, and the current code juggles both by inspecting what it was handed — decide whether to keep that juggling permanently or reshape the constructor so it matches upstream and future updates merge more cheaply.
prereq:
files: src/b-tree.ts (constructor), readme.md
difficulty: medium
----
Upstream placed a `BTreeOptions` argument in the constructor's third position. Inheritree's documented
API already had the **base tree** in that third position. The merge resolved the collision by
discriminating at runtime: it checks `instanceof BTree` and, when a base is present, accepts options as a
**fourth** argument. This is unambiguous — a base tree can never be mistaken for a plain options object —
and it preserves both call sites without breaking either. But a positional argument whose meaning depends
on its runtime type ages poorly: every future upstream change to the constructor lands on exactly this
seam, and `b-tree.ts` is already among the most merge-painful files in the fork.

## Decision for the fork's next major

**(a) Keep the union as the permanent contract.** Document the positional/`instanceof` discrimination
prominently as the intended, stable API. Pro: no breaking change, no migration. Con: the fork's
constructor signature stays permanently different from upstream's, so this seam re-conflicts on every
upstream constructor touch — the maintenance cost is paid forever.

**(b) Migrate to `options.base`.** Give `BTreeOptions` an optional `base` field and take the base there
instead of positionally; deprecate the positional base form. Pro: the fork's constructor signature
becomes **identical to upstream's**, shrinking the permanent merge surface of this painful file down to
just the `BTreeOptions` interface (a much smaller, more stable seam). Con: a breaking API change with a
deprecation path to manage, and existing callers passing a positional base must migrate.

## Tradeoff

(a) avoids a breaking change but keeps a recurring merge cost on the fork's worst file. (b) pays a
one-time migration to make future upstream merges of the constructor substantially cheaper — the payoff
is structural: identical signatures mean the constructor stops being a conflict site at all, leaving only
the options interface to reconcile. This is a decision — do not pre-decide; present both and let the call
be made for the next major.

## Edge cases & interactions

- **Both base and options supplied.** Under (a) that's the four-arg form; under (b) it's a single
  `options` object carrying `base`. Confirm each form round-trips every option field correctly.
- **Deprecation window (if b).** Decide whether the positional base form throws, warns, or silently
  forwards during the deprecation period, and how the readme documents the transition.
- **Interaction with base-immutability work.** The base is also central to the base-immutability guard
  decision; whichever way the base is passed, the version-stamping/guard logic must read it from the same
  place — coordinate so the guard isn't wired to a soon-to-move argument position.
- **Type inference.** Verify the key/value generic parameters still infer correctly from a base passed via
  `options.base` as they do from the positional base today.
- **readme parity.** The readme's constructor documentation and examples must match whichever form is
  chosen; today they describe the positional base.
