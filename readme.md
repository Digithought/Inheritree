# Inheritree

Lightweight and performant B+Tree with copy-on-write (COW) inheritance. [On GitHub](https://github.com/Digithought/Inheritree)  This is a fork of [Digitree](https://github.com/Digithought/Digitree); if you do not need inheritance, use that library instead.

### Overview

Welcome to Inheritree, a fast in-memory B+Tree[^1], written in Typescript using generics. Inheritree extends the capabilities of a traditional B+Tree by incorporating a copy-on-write inheritance mechanism. This allows new tree instances to be created as derivatives of a base tree. Modifications to the derived tree only affect its own structure, copying relevant nodes from the base as needed, leaving the base tree untouched. This is particularly useful for scenarios requiring versioning, snapshots, or isolated transactional workspaces.

A B+Tree is an efficient balanced tree structure, which provides the basis for most database engines, but also happens to be one of the efficient structures for storing sorted information in-memory. Worst case space efficiency is N*2, which matches that of "size doubling" list building methods. Unlike the latter, however, random insertion and deletion are far more efficient, which is important when maintaining total ordering.

This implementation takes two type arguments: `TKey` and `TEntry`.  The key must be obtainable from the entry, and a constructor callback extracts the key from an entry.  If TEntry and TKey are the same, the tree essentially acts like an ordered set.  To use the tree like a sorted dictionary, simply use an entry type like this: `{ key: 5, value: "five" }` with a callback like this: `e => e.key`.  Inserted entries are frozen to ensure that they don't mutate, and corrupt the tree.

Features:
* **Set or dictionary** behavior
* **Existing attribute** can be used as a key (without additional storage)
* **Custom sorting**
  * For performance, doesn't try to untangle idiosyncrasies of Ecmascript comparisons, but...
  * Implementation does ensure consistency of sorting function (by default, a bounded sample of comparisons — see [Performance](#performance))
* **Tunable safety costs** - optional constructor flags (`freeze`, `checkComparator`) let throughput-sensitive callers opt out of per-operation safety work; both default to the safe behavior
* **Light weight** - very little memory used, only important primitives
* **CRUD**: `insert`, `updateAt`, `deleteAt`, `find`, `first`, `last`
* **Bulk load** using the static `BTree.buildFrom(sorted, ...)` — builds the whole tree from already-sorted, duplicate-free input in one O(n) pass, packing nodes near capacity (throws `UnsortedInputError` on unsorted/duplicate input)
* **Upsert and Merge** for efficient hybrid mutation
* **Entry iteration** using `entries` and `keys`, or `for (const entry of tree)` / `[...tree]` — the safe default for reading (yields distinct values, no cursor aliasing)
* **Enumerations** using `ascending` and `descending` (from an optional starting path; no argument walks the whole tree)
* **Ranges** using `range`, ascending or descending, with optional inclusive/exclusive end-points
* **Path** navigation through `next` and `prior` or `moveNext` and `movePrior`
* **Find nearest**, using `next` on an unsuccessful path
* **Count** using `size` or the no-arg `getCount` — O(1), from a stored count; `getCount({ path, ascending })` walks for a partial count from a cursor
* **Clear** using `clear` to empty the tree in place (invalidates outstanding paths; reusable afterward)
* **Copy-on-Write Inheritance**: Create new tree versions from a base tree efficiently. Changes in the derived tree do not affect the base.
* **Flatten** using `flatten()` — an O(n) genuine-isolation copy that shares no node with a (former) base, for when `clearBase()`'s cheap pointer-drop isn't isolated enough (see the *Base immutability contract* below)

WARNING: by default this library freezes added entries to reduce the chance that keys are externally mutated, but this is not done transitively, so it is possible that an object's key can be mutated after adding, resulting in tree corruption.  Don't attempt to change a key value after it has been inserted.  Use updateAt, upsert, insdate, or deleteAt/insert to change the key value.

Freezing can be disabled with the `freeze: false` constructor option for trusted bulk loads of entries you will never mutate (see [Performance](#performance)) — but then the tree offers no protection at all, so only do this when you fully control the entries' lifetime.

[^1]: technically this is a hybrid B-Tree/B+Tree.  Data are stored in the leaves, but no leaf-level linked list is implemented, since that's largely for optimizing for minimal contention.

### Usage

#### Installing

Via npm:
```
  npm install inheritree
```

Via pnpm/yarn:
```
  pnpm add inheritree
  yarn add inheritree
```

#### As an ordered set

```ts
  import { BTree } from 'inheritree';
  ...
  const tree = new BTree<number, number>();
  tree.insert(3); tree.insert(1); tree.insert(2);
  for (const entry of tree) {       // the safe default: yields entries directly
    console.log(entry);             // 1, 2, 3
  }
  console.log([...tree.entries()]); // [1, 2, 3]
  const path = tree.find(1.5);  // result in "crack" between values
  console.log(path.on); // false (not on entry)
  console.log(tree.at(tree.next(path))); // 2
```

#### As an ordered dictionary

```ts
  import { BTree } from 'inheritree';
  ...
  interface Widget { id: number, shape: "square" | "circle" };
  const tree = new BTree<number, Widget>(e => e.id);
  tree.insert({ id: 3, shape: "square" });
  tree.insert({ id: 1, shape: "circle" });
  tree.insert({ id: 2, shape: "square" });
  for (const widget of tree.entries()) {  // entries in ascending key order
    console.log(widget);
  }
  console.log([...tree.keys()]);  // [1, 2, 3]
  console.log(tree.get(2));  // Equivalent to find then at
```

#### Using Copy-on-Write Inheritance

```ts
  import { BTree } from 'inheritree';
  ...
  const baseTree = new BTree<number, number>();
  baseTree.insert(10); baseTree.insert(20);

  // Create a derived tree. It initially shares all data with baseTree.
  const derivedTree = new BTree<number, number>((e) => e, undefined, baseTree);
  derivedTree.insert(15); // Modifies derivedTree, baseTree is unaffected
  derivedTree.deleteAt(derivedTree.find(10)); // Entry 10 deleted from derivedTree only

  console.log("Base tree items:");
  for (let path of baseTree.ascending(baseTree.first())) {
    console.log(baseTree.at(path)); // Will show 10, 20
  }

  console.log("Derived tree items:");
  for (let path of derivedTree.ascending(derivedTree.first())) {
    console.log(derivedTree.at(path)); // Will show 15, 20
  }

  // To detach the derived tree from its base (flattening its state):
  derivedTree.clearBase();
```

##### Base immutability contract

A derived tree reads any un-modified node **directly from its base** — copy-on-write only clones the nodes a child actually mutates. This has one important consequence:

> **Treat a base as immutable for the lifetime of its derived children.** Derive your children first, then do not insert/update/delete on the base while any derived child is still in use. Mutating the base can corrupt every child's view of the nodes it still shares with that base. If you need to keep mutating the original, mutate a *derived child* instead and leave the base frozen.

`clearBase()` detaches a child from its base cheaply — it drops the base pointer, it does **not** deep-copy. A flattened child can therefore still *share* untouched nodes with its former base (an unwritten child shares the entire tree), and once detached neither tree copies-on-write any longer. So the same rule outlives `clearBase()`: after calling it, treat the former base as frozen (in practice, discard it).

If you genuinely need a tree that is independent of its former base — sharing no node with it, by identity — call **`flatten()`** instead: it rebuilds the tree's current entries into a fresh, standalone tree in one O(n) pass (versus building a new tree and re-inserting every entry one by one, which costs O(n log n)). The result carries over this tree's `freeze` and `checkComparator` options and behaves identically to the original, just fully isolated:

```ts
  const isolated = derivedTree.flatten(); // Genuinely independent copy - shares no node with derivedTree's base
```

Use `clearBase()` when you just want to stop depending on the base object and don't mind lingering shared structure; use `flatten()` when true isolation matters.

This contract is currently documented, not enforced at runtime (see *Help wanted* below).


#### See [Reference Documentation](https://digithought.github.io/Inheritree/)

#### Paths

Many methods take and return Path objects.  A `Path` is an insulated cursor: it exposes `on` (is it sitting on an entry?), `isEqual`, and `clone`, and nothing else — its internal position (leaf, index, branches, version) is deliberately hidden so it can't be corrupted by accident.  All paths not returned from a mutation operation itself are invalid after mutation and any attempt to use them will throw an exception.  `moveNext` and `movePrior` mutate the path they are given, and `deleteAt` mutates the path passed to it (leaving it valid - see below).

The raw `ascending`/`descending` iterators yield **one live cursor, reused and mutated in place** at every step — they are a cursor-level tool, not a collection.  Spreading them (`[...tree.ascending()]`) or `.map`ping them gives you N references to the same path parked off the end, so reading them afterward is all-`undefined`; read `tree.at(path)` *inside* the loop, and `path.clone()` any cursor you need to keep.  When you just want the values, prefer `entries()` / `keys()` (or `for (const e of tree)`), which yield distinct entries/keys and sidestep the aliasing entirely.

```ts
  tree.updateAt(tree.last().prior(), 7);  // this is fine
  
  const path1 = tree.last();
  const ninePath = tree.updateAt(tree.find(5), 9);
  tree.updateAt(ninePath, 8);  // Fine, ninePath came from mutation
  //tree.updateAt(path1, 7);  // DON'T USE path1 - invalid after mutation
```

`deleteAt` is a special case: the path you pass it stays valid after the delete, positioned at the "crack" the deleted entry left behind (its `on` becomes false).  A following `moveNext` recovers onto the deleted entry's successor and `movePrior` onto its predecessor - so you can delete while iterating without re-`find`ing:

```ts
  let p = tree.find(startKey);
  while (p.on) {
    if (shouldDelete(tree.at(p))) tree.deleteAt(p);  // p now sits at the successor's crack
    tree.moveNext(p);  // after a delete: recovers onto the successor; otherwise: advances normally
  }
```

### Background

At one point, a colleague and I set about finding the fastest possible data structure for in-memory storage of datasets, small and large.  We experimented in C++ with various highly optimized data structures.  We inserted, deleted, and read from millions of data rows in various benchmarks.  We figured that structures like AVL trees or red-black trees would be the fastest due to simple design, but in the end, a B+Tree implementation, not dissimilar in design to this one (though much faster in C++) was the clear winner.  For some tests, they were about the same, but the other structures had terrible worst cases, whereas the B+Tree was reliably and consistently fast for a variety of workloads.  In studying this further, we realized that just as disk operations like to be performed in blocks, the same is true for memory and processor caches.

#### History

The B-Tree, and more specifically the B+Tree, is a type of self-balancing tree data structure that maintains sorted data in a way that allows for efficient insertion, deletion, and sequential access operations. The B+Tree is an extension of the B-Tree, designed to optimize the read and write operations of databases and file systems by reducing the amount of disk accesses required to find, insert, or delete entries.  Those same optimizations also apply to memory.

The B-Tree was first introduced by Rudolf Bayer and Edward M. McCreight in 1972 as a generalization of the binary search tree, in contexts where blocks of data could only be efficiently accessed in fixed-size chunks, such as disks or tapes (or memory blocks). The key innovation was its ability to maintain balance through tree operations that ensure all leaf nodes are at the same depth, significantly improving the efficiency of tree traversal and manipulation.

The B+Tree variant further modifies the B-Tree structure by storing all data in the leaf nodes and using the internal nodes purely for indexing. Traditionally, the leaf nodes are also linked across the bottom of the tree.  This implementation doesn't add that extra complexity, rather it maintains an open path structure for rapid traversal.  In a highly concurrent database context, the linked list avoids depending on high-traffic routing nodes, which is not an issue for this structure.

#### Performance

The best-case and worst-case time complexities for search, insertion, and deletion operations in a B+Tree are all O(log n), where n is the number of elements in the tree. This efficiency is maintained regardless of the tree's size, making B+Trees particularly well-suited for systems that manage large amounts of data.  For small datasets, this implementation has barely more overhead than an array, and should perform comparably to an ordered array.

##### Optional safety costs

The `BTree` constructor takes an optional third `options` argument for callers that want to trade a little safety for throughput.  Both options default to the safe behavior, so existing code is unaffected.

```ts
  const tree = new BTree<number, Widget>(e => e.id, undefined, {
    freeze: false,          // default true
    checkComparator: true,  // default false
  });
```

* **`freeze`** (default `true`) — when true, every inserted/updated entry is passed through `Object.freeze` to deter accidental key mutation.  Set it to `false` for trusted bulk loads of entries you will never mutate; the freeze cost disappears, but so does the protection (see the immutability WARNING above).
* **`checkComparator`** (default `false`) — governs how thoroughly the comparator is verified to be antisymmetric (that `compare(a, b)` and `compare(b, a)` disagree in sign).  A broken comparator silently corrupts the tree, so this check exists to surface the bug.
  * **Default (`false`)** — only the first 32 real comparisons are checked, then the check drops off the hot path entirely.  This catches an obviously-broken comparator on the first few operations at zero steady-state cost.  **Trade-off:** a comparator that is subtly inconsistent *only* for some values encountered deep in a large tree may no longer be caught, because those comparisons fall outside the sample window.
  * **`true`** — restores the historical behavior: *every* non-equal comparison is checked, at every level, for the life of the tree.  Use this when you want the exhaustive check and can afford roughly double the comparator calls on the hot path.

### Contributing

Bug fixes, architectural enhancements, and speed improvement suggestions are welcome.  Added "helper" features might be better as an add-on library since the goal of this is to remain minimalistic.

#### Help wanted

TODO: need version checking against base tree; right now, the base is assumed to be immutable while it has live derived children (see the *Base immutability contract* above). A runtime guard — e.g. a version/`hasChildren` check that throws when a base is mutated while derived — would turn that documented contract into an enforced one.

* Benchmark suite
* More tests
* AssemblyScript portability?

#### Bug Fixes

The best way to contribute a bug fix is to submit a Pull Request with the fix, as well as a unit test that only passes with the fix.  Second best is to submit just a unit test that is broken.  If either of those are too tall an order, submit an issue.

#### Performance Improvements

Try to be sure that the enhancement isn't only associated with a particular usage pattern.  Performance of a B+Tree is a very tricky matter, and it's easy to improve one pattern while regressing another.

#### Environment

* If using VSCode use the editorconfig plugin to honor the conventions in `.editorconfig`
* Build: `yarn build` or `npm run build`
* Test: `yarn test` or `npm test`
* Coverage: `yarn test:coverage` or `npm run test:coverage` — emits a text summary and `coverage/lcov.info`
