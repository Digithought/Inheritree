# Inheritree

Lightweight, fast in-memory B+Tree in TypeScript with copy-on-write (COW) inheritance — a fork of [Digitree](https://github.com/Digithought/Digitree) that adds derived trees sharing structure with a base. Generic over `TKey`/`TEntry`; behaves as an ordered set (key = entry) or sorted dictionary (key extracted from entry). See [readme.md](readme.md) for usage.

## Layout

- `src/b-tree.ts` — `BTree<TKey, TEntry>` class; all public API, balancing logic, and the COW layer (`root` getter, `clearBase`, `mutableLeaf`/`mutableBranch`/`replaceRootward`). `NodeCapacity = 64` (fixed, not configurable).
- `src/nodes.ts` — `LeafNode` (holds entries) and `BranchNode` (partitions + child nodes); each node carries an optional `owner` token (its owning tree's identity `Symbol`, not a back-reference to the `BTree`) and a `clone` method for COW. Carrying a token rather than the tree keeps a shared node from pinning the whole owning tree — and its base chain — alive. Data lives only in leaves; no leaf linked-list.
- `src/path.ts` — the cursor. `Path` is the public, insulated **interface** (only `on`, `isEqual`, `clone`); the concrete class `PathImpl` (`branches`, `leafNode`, `leafIndex`, `on`, `version`) and `PathBranch` stay module-internal. Only `Path` is re-exported from `index.ts`; `b-tree.ts` and white-box tests import `PathImpl` directly and cross the boundary with a `path as PathImpl` cast.
- `src/key-range.ts` — `KeyRange` for `range()`.
- `src/index.ts` — barrel export.
- `test/*.test.ts` — mocha + chai.

## Build & test

- Build: `yarn build` (or `npm run build`) — cleans then `tsc -p tsconfig.build.json`.
- Test: `yarn test` (or `npm test`) — mocha over `test/**/*.test.ts` via ts-node ESM loader.
- Docs: `yarn doc` (typedoc).
- Package manager is yarn 4; ESM (`"type": "module"`) — use `.js` extensions in imports.

## Core concepts (don't break these)

- **Paths are versioned cursors.** Any mutation bumps `_version` and invalidates all outstanding paths except the one a mutation method returns. Public methods validate the path version and throw on stale paths. Only `moveNext`/`movePrior` mutate a path in place; everything else returns a new one.
- **`on`** = cursor is on an entry vs. in a "crack" between/beyond entries. `find` returns the entry or the crack before it; `next`/`prior` move to the nearest match from a crack.
- **Entries are frozen on insert** (by default; opt out with the `freeze: false` constructor option — see `BTreeOptions`) to deter key mutation — but freezing is shallow and non-transitive. Never mutate a key after insert; use `updateAt`/`upsert`/`merge`/`deleteAt`.
- **Sort consistency over correctness.** The default compare uses `<`/`>`; a custom `compare` must be consistent, but the tree does not police Ecmascript comparison quirks.
- **Copy-on-write inheritance (Inheritree-specific).** A tree constructed with a `base` shares all of the base's nodes and lazily clones a node (plus its rootward path) on first write — see `mutableLeaf`/`mutableBranch`/`replaceRootward`. Ownership is upward-closed: a child-owned node never sits beneath a base-owned ancestor. The base must be treated as **immutable while derived children exist** — enforced at runtime by a detect-on-next-use version guard (`MutatedBaseError`): a child snapshots its base chain's version at construction and throws on its next op if the base was mutated (the base mutation itself still succeeds silently). `clearBase()` drops the base pointer cheaply but the flattened child may still share untouched nodes with the former base, and a **detached** child (`base === undefined`) is past the guard's reach — use `flatten()` up front for true isolation. Test helpers in `test/helpers/invariants.ts` (`assertOwnershipInvariant`, `snapshotBase`) encode these rules — pair them with `assertTreeInvariants` in COW tests.
- Public API: `BTree.buildFrom` (static bulk load from sorted input — O(n), packs nodes near capacity, throws `UnsortedInputError` on unsorted/duplicate input), `insert`, `updateAt`, `deleteAt`, `upsert`, `merge`, `find`, `get`, `at`, `first`, `last`, `next`/`prior`, `moveNext`/`movePrior`, `ascending`/`descending` (no-arg walks the whole tree), `range`, `entries`/`keys`/`[Symbol.iterator]` (aliasing-free entry/key iteration — the safe reading default), `clear` (empty in place), `getCount`, `size`, `isValid`. Most operations O(log n); `size` and the no-arg `getCount` are O(1) (a stored count); the partial `getCount({ path, ascending })` overload walks from the cursor (O(n/fill)).

## Conventions

- Follow `.editorconfig`: **tabs** (size 2), UTF-8, single quotes in `.ts`, final newline. (Markdown uses spaces.)
- Stay minimalistic — helper/convenience features belong in an add-on library, not core.
- Performance is workload-sensitive: an "improvement" for one access pattern often regresses another. Benchmark broadly before claiming a speedup; add a failing-without-the-fix test for bug fixes.

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.
