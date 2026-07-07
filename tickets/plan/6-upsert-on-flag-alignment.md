----
description: Two sibling operations that both add-or-update an item disagree about how they report the item's position afterward, so one of them returns a position that looks empty right after a successful add — decide whether to keep that quirk or align the two.
prereq:
files: src/b-tree.ts (upsert, merge)
difficulty: medium
----
The tree has two hybrid add-or-update operations that resolve the same positional flag in opposite ways:

- `merge` sets `path.on = true` after inserting, so the returned path points *at* the entry.
- `upsert` leaves `on = false` when it freshly inserts, so `tree.at(tree.upsert(x))` returns `undefined`
  exactly when `x` was newly added (it returns the entry only when `x` updated an existing one).

`path.on` is fundamentally a *positional* flag — whether the path sits on an entry or in the crack
between entries. `upsert` overloads it as a *semantic result* (was-this-an-insert), which is a footgun,
and the two closely-related sibling operations resolving it opposite ways compounds the surprise. The
behavior is documented, but "documented" does not make it ergonomic.

Upstream's v1.5.0 "operation-result-contract" pass tightened the neighboring `updateAt` (it now throws
`PathNotOnEntryError` when handed a crack path) but deliberately **left the `upsert` asymmetry in place**.
So the asymmetry is now a considered upstream position, not an oversight — which is what makes this a
real fork decision rather than a bug.

## Decision to make

**(a) Adopt upstream's asymmetry as final.** Keep `upsert` returning an `on = false` crack path on
insert. Pro: zero drift from upstream — future merges of `b-tree.ts` stay clean, and this is upstream's
deliberate contract. Con: the footgun stays; `tree.at(tree.upsert(x))` remains a live trap that returns
`undefined` on the success-by-insert case, and the two siblings stay inconsistent.

**(b) Fix it — align `upsert` with `merge`.** Make `upsert` always return `on = true` and surface the
insert-vs-update distinction explicitly, e.g. a `[path, wasUpdate]` result so callers get the position
*and* the semantic answer without overloading `on`. Pro: consistent siblings, no positional-flag
overloading, `at(upsert(x))` always resolves to the entry. Con: it diverges from a deliberate upstream
contract; to avoid perpetual merge friction the change should be made **upstream-first** and pulled back
down, rather than carried as a fork-local patch on a file that already merges painfully.

## Tradeoff

This is the drift-vs-ergonomics axis. (a) minimizes maintenance cost of tracking upstream on a
merge-heavy file; (b) buys a cleaner, less surprising API at the cost of either upstream coordination or
ongoing local divergence. Weigh how often the fork actually calls `upsert` and relies on its result, and
whether upstream would accept the symmetric contract.

## Edge cases & interactions

- **`at()` on the returned path.** Under (a), document loudly that `at(upsert(x))` is `undefined` on
  insert; under (b), ensure it always resolves and that the second tuple element is the source of truth
  for insert-vs-update.
- **Relationship to `updateAt`'s new `PathNotOnEntryError`.** Whatever path `upsert` returns must remain
  valid to feed into the other operations a caller would chain next; check that an `on = true` upsert
  result does not now trip a different guard than before.
- **`merge` parity.** If (b), confirm `merge` and `upsert` end up with genuinely matching path/flag
  semantics so the "two siblings" inconsistency is actually gone, not merely moved.
- **Backward compatibility.** (b) changes `upsert`'s return shape — enumerate existing call sites in the
  fork and how each reads the result today.
