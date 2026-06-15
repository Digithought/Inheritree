description: COW coverage for upsert, merge, and updateAt (incl. key-change) at scale
prereq: test-infra-cow-invariants
files: test/b-tree.cow-mutation-ops.test.ts (new), src/b-tree.ts
difficulty: medium
----
`test/cow.test.ts` exercises only insert, same-key update, and delete — on a single-leaf base. The COW behavior of `upsert`, `merge`, and `updateAt`-with-key-change on a multi-level base has **zero coverage**, yet each routes through the COW clone machinery: `upsert` → `mutableLeaf`/`internalInsertAt` (`src/b-tree.ts:143`), `merge` → `updateAt`/`internalInsertAt` (`:161`), `updateAt` key-change → `internalInsert` + `internalDelete` (`:433`) which can both split and rebalance and therefore clone branches on both the insert and delete sides in one operation.

Use a multi-level immutable base + COW child; assert base pristine and `assertOwnershipInvariant` + `assertTreeInvariants` after each op.

TODO
- **COW upsert**: upsert a new key into a child region owned by base (clones leaf + ancestors), including one that splits; upsert an existing base-owned key (value replace) — base entry object unchanged, child sees new value.
- **COW merge**: insert-branch and update-branch on a base-owned key; a merge whose insert splits; a merge whose `getUpdated` returns an already-present key (conflict path).
- **COW updateAt, same key** deep in a base-owned leaf — clones only the touched spine.
- **COW updateAt, key change**: new key lands in a different base-owned leaf (forces split there) while removing the old entry forces a borrow/merge against a base-owned sibling — the heaviest single-op COW path; assert ownership spine connected and base untouched.
- A seeded mixed stream (upsert/merge/updateAt/delete/insert) on a COW child vs a shadow `Map`, sampling invariants + ownership + base-pristine.
