description: Add scale tests and documentation for detaching a copy-on-write tree from its base, and for the rule that a base must not be changed while trees derived from it are still in use.
prereq:
files: test/b-tree.cow-clearbase.test.ts (new), test/helpers/invariants.ts, src/b-tree.ts, readme.md
difficulty: medium
----
Pins two correctness edges around the COW `base` relationship: `clearBase` at scale, and the
base-mutation-while-derived contract. All work is **test + documentation**; no production behavior was
changed. Full suite green: **167 passing** (8 new). `npm run build` clean.

## What landed

- **`test/b-tree.cow-clearbase.test.ts`** (new, 8 tests) — multi-level base (400 keys, stride 10, depth ≥ 1;
  `NodeCapacity` is 64) → COW child driven by a seeded, delete-biased, non-front-anchored op stream that
  forces real borrows/merges/splits, then `clearBase()`, then assertions. Two groups:
  - *clearBase at scale*: key set preserved across `clearBase`; `assertTreeInvariants(child)` holds; base
    pointer dropped; written child owns its pinned root; follow-up op batch on the detached tree stays
    correct vs a shadow map; the genuine isolation that DOES hold (base mutations to a region the child
    rewrote don't reach the child).
  - *the base-immutability contract (pinned hazards)*: the leaks that DO happen, pinned so a future
    guard/deep-copy is a visible, intentional diff.
- **`test/helpers/invariants.ts`** — added `reachableNodesOf(tree)` and `sharedReachableNodes(a, b)` (the
  ticket's "extend the ownership helper") to assert structural sharing between trees by node identity.
- **`src/b-tree.ts`** — doc comments on `clearBase` and on the `base` constructor param spelling out the
  immutability contract. (No code change.)
- **`readme.md`** — new "Base immutability contract" subsection under the COW usage example; the existing
  "Help wanted" version-checking TODO now points at it.

## ⚠️ Key finding — read before reviewing the assertions

The ticket *hoped* `clearBase` would make a child "genuinely independent" — "shares no node with the former
base" and "subsequent mutations to the former base do not affect the child." **At scale that is false, and
the tests assert the truth, not the hope.** Empirically (probed before writing tests):

`clearBase` is a cheap pointer drop, NOT a deep copy. Copy-on-write only clones the nodes a child actually
mutated, so after a multi-level child's writes:

- the flattened child **still shares untouched subtrees with its former base** by identity
  (`sharedReachableNodes(child, base).length > 0`);
- once detached, `base` is `undefined`, so **neither** tree copies-on-write anymore — a structural write to a
  shared node mutates it **in place for both**;
- therefore: mutating the former base in a region the child **rewrote** does NOT reach the child (isolated),
  but mutating it in an **untouched/shared** region DOES leak in; and a post-`clearBase` write by the child
  in a shared region corrupts the former base. An **unwritten** child shares the *entire* tree, so `clearBase`
  pins the base's own root and any later write to either side aliases the other completely.

This is exactly why the existing tiny-tree `clearBase` coverage (`test/cow.test.ts`) looked fully isolated:
the single-leaf tree is wholly cloned by the child's first write, so nothing is left shared. That coverage is
not wrong, just not representative.

The two `reachableNodesOf`/`sharedReachableNodes` helpers + `leafForKey` make each leak's mechanism explicit
in the assertions (which leaf is shared, which side mutates it).

## Decision note (ticket bullet 4): runtime guard vs doc-only

**Recommendation: doc-only, as implemented — do NOT add a guard inside this ticket.** Reasoning:

- A correct guard is **not trivial**. The base does not currently know it has derived children (children
  hold a reference to the base, not vice versa), so enforcing "don't mutate a base with live children" needs
  new state — child registration/refcount, or a base version stamped into derived children and checked on
  base mutation. That is a design change, not a one-liner, and it touches the hot mutation path.
- The bigger question this ticket surfaced — that `clearBase` does not yield genuine independence at scale —
  is a **behavior/design decision** (cheap detach vs deep-copy/"flatten"), not a guard. Changing it is out of
  scope for a "pin current behavior" ticket.
- The pinned tests mean any later guard OR deep-copying `clearBase` arrives as an intentional, visible diff.

**For the reviewer to decide:** if the team wants either (a) an *enforced* base-immutability guard, or (b) a
`clearBase` that truly isolates (deep-copy of still-shared nodes, or a "rebuild fresh" path), spawn a
follow-up `fix/` or `plan/` ticket. Both are real, defensible features; both would flip several pinned
assertions here (expected).

## How to validate

- `yarn test` (or `npm test`) — full suite, 167 passing. Targeted: `mocha test/b-tree.cow-clearbase.test.ts`.
- `npm run build` — clean type-check.
- Read the new test's header comment first; it states the honesty caveat up front.

## Known gaps / where to push (this is a floor, not a ceiling)

- **Tests pin CURRENT (unguarded) behavior, including the hazards.** If the reviewer judges the leaks to be
  bugs rather than a documented contract, that's a fix-ticket call; the pinned hazard tests will then need to
  flip (the intended visible diff). Don't "fix" them silently.
- **No runtime guard added** (see decision note).
- **`clearBase` on a deep chain (≥ 3 trees) is not directly tested** — e.g. `clearBase()` on `c2` whose base
  `c1` itself has a base. The base→child case tested is representative of the mechanism, but an intermediate
  `clearBase` in a chain is uncovered and worth a glance.
- The seeded op streams use fixed seeds (`0xC0FFEE`, `0x9E3779B1`, `0xBADF00D`); they exercise borrows/
  merges/splits but are not exhaustive. The adjacent `b-tree.cow-fork`/`cow-delete` suites carry the heavier
  randomized differential load.
- `sharedReachableNodes` walks the effective root of each tree on every call (O(nodes)); fine for tests, not
  meant for production use.
