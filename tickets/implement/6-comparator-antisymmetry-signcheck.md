----
description: Make the built-in check that catches a broken sort-order function reliably detect more of the ways such a function can be wrong.
prereq:
files: src/b-tree.ts (compareKeys), BTreeOptions.checkComparator
difficulty: easy
----
This ticket strengthens the comparator self-check (code review finding F8). The cost half of that finding was already resolved upstream; this addresses the completeness half.

## Background

A user-supplied comparator must be antisymmetric: `sign(compare(a, b))` must equal `-sign(compare(b, a))`. A broken comparator (a classic being subtraction-based `a - b` that overflows or returns arbitrary magnitudes) silently corrupts tree ordering, producing bugs that are very hard to trace back to their cause.

v1.5.0 already samples only the first 32 comparisons by default and drops the check off the hot path, with `{ checkComparator: true }` restoring exhaustive mode. So the check now runs either on a bounded sample or by explicit opt-in — there is no longer a performance argument against making it stricter.

## The gap

The current antisymmetry check only fires when both directions return the IDENTICAL nonzero value. It therefore misses:

- Zero-asymmetry: `compare(a, b) === 1` but `compare(b, a) === 0`.
- Same-sign results of different magnitude: `1` vs `2` — exactly what broken subtraction comparators produce.

## Fix

Use a sign-based comparison, which catches the whole class at the same cost:

```ts
if (Math.sign(this.compare(b, a)) !== -Math.sign(result)) {
    throw ...;
}
```

Apply it in `compareKeys` so BOTH the default-sampled path and the `checkComparator: true` exhaustive path use the strengthened check.

## Edge cases & interactions

- Valid comparators returning any magnitude (e.g. `-5` / `+5`) must NOT trip the check — only sign mismatch matters.
- Equal keys where both directions return `0` are fine (`sign(0) === -sign(0)`).
- Both the default-sampled and `checkComparator: true` paths must route through the strengthened check; do not leave one on the old identical-value logic.
- The bounded sample means a broken comparator that only misbehaves after the first 32 comparisons still escapes by default — that is the documented trade-off, unchanged here.

## TODO

- Replace the identical-value antisymmetry test in `compareKeys` with the sign-based test.
- Ensure the strengthened check is shared by the default-sampled path and the `checkComparator: true` exhaustive path.
- Add a test with a subtraction comparator returning magnitudes `1` vs `2` (must throw).
- Add a test with a comparator exhibiting `1` / `0` asymmetry (must throw).
- Add a test confirming a valid comparator returning large-magnitude opposite signs does NOT throw.
