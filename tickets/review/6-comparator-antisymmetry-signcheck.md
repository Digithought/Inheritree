description: Strengthened the antisymmetry self-check on user-supplied comparators so it catches more kinds of broken comparators, not just an easy-to-miss narrow case.
prereq:
files: src/b-tree.ts (compareKeys, ~line 590-601), test/b-tree.options.test.ts (new describe block "antisymmetry check is sign-based, not identical-value-based", ~line 133)
difficulty: easy
----
## What changed

`compareKeys` in `src/b-tree.ts` runs an antisymmetry self-check on user comparators: `compare(a,b)` and `compare(b,a)` must have opposite sign (or both be zero). The old check only threw when both directions returned the exact same nonzero value — so it missed:

- Same-sign, different-magnitude results (`1` vs `2`) — exactly what a broken subtraction comparator (`a - b` overflowing or clamping) produces.
- Zero-asymmetry (`compare(a,b) === 1` but `compare(b,a) === 0`).

Fix: replaced the identical-value test with a sign-based test:

```ts
if (Math.sign(this.compare(b, a)) !== -Math.sign(result)) {
    throw new InconsistentComparatorError();
}
```

One shared code path, so both the default-sampled mode (first `BTree.SampleCheckCount` = 32 comparisons) and `{ checkComparator: true }` (exhaustive, every comparison) get the stronger check for free — no branching added.

## Use cases / how to exercise

- `new BTree(undefined, (a,b) => a<b?1:a>b?2:0)`: same-sign different-magnitude → throws `InconsistentComparatorError` on the first real comparison.
- `new BTree(undefined, (a,b) => a<b?1:0)`: never returns negative → zero-asymmetry → throws.
- `new BTree(undefined, (a,b) => (a-b)*1_000_000)`: valid comparator, huge opposite-sign magnitudes → must NOT throw.
- Pre-existing tests in `test/b-tree.options.test.ts` (`checkComparator: true` describe block, and the perf-goal "invocation count" block) continue to pass unchanged, confirming: the exhaustive path still throws for the old () => 1 case, the ~2x-compares perf goal is untouched (no extra `this.compare` calls added — same call sites, just a different comparison of the two results), and legitimate wide-magnitude / repeated-equal-probe comparators still don't false-positive.

## Testing done

- Added 3 new tests under a new describe block `antisymmetry check is sign-based, not identical-value-based` in `test/b-tree.options.test.ts`, covering exactly the three TODO cases from the ticket (same-sign/different-magnitude throws, zero-asymmetry throws, large-magnitude opposite-sign does not throw).
- Full suite: `node --loader=ts-node/esm node_modules/mocha/bin/mocha.js "test/**/*.test.ts" --colors` → 307 passing, 0 failing.
- `npx tsc --noEmit -p .` → clean, no type errors.

## Known gaps / things the reviewer should double check

- Didn't touch the doc comment above `compareKeys` (lines ~578-589) — it already describes the sampled-vs-exhaustive behavior accurately and doesn't reference the old identical-value mechanism, so no update was needed. Worth a quick read to confirm it still reads correctly against the new code.
- The bounded-sample trade-off (a comparator that only misbehaves after the first 32 comparisons escapes detection by default) is unchanged and out of scope per the ticket — not re-verified beyond the existing "still detects an inconsistency deep in a large tree (beyond the sample window)" test which only exercises `checkComparator: true`.
- No new test explicitly re-confirms the `1_000_000`-magnitude case with the tree grown large enough to cross multiple leaf/branch levels — the existing `magnitude`/`wide` tests in the "does NOT false-positive" test already do that at scale (up to `C*C+1` keys), so I kept the new dedicated test small and fast; flagging in case the reviewer wants the new test itself to be multi-level rather than relying on the older test for that coverage.
