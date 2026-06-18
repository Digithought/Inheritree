import { expect } from 'chai';
import { BTree, NodeCapacity } from '../src/b-tree.js';
import { LeafNode } from '../src/nodes.js'; // For type checking if needed, or tree.first().on check
import { assertTreeInvariants, assertOwnershipInvariant, snapshotBase } from './helpers/invariants.js';
import { lcg, lcgInt } from './helpers/rng.js';

// Helper function to retrieve all entries from a tree in order
function getAllEntries<TKey, TEntry>(
    tree: BTree<TKey, TEntry>,
    keyFromEntry: (entry: TEntry) => TKey // Needed for sorting if direct array comparison is tricky
): TEntry[] {
    const entries: TEntry[] = [];
    const firstPath = tree.first();
    if (!firstPath.on) {
        return entries;
    }
    for (const path of tree.ascending(firstPath)) {
        const entry = tree.at(path);
        if (entry !== undefined) {
            entries.push(entry);
        }
    }
    // BTree iteration should be sorted by key.
    // If TEntry are objects, ensure consistent sort for deep equality checks if order can vary for identical keys.
    // For primitive entries or entries where key order implies full order, this direct push is fine.
    return entries;
}

// Helper to get all entries as key-value pairs if TEntry is {key, value}
interface KeyValue<K,V> { key: K; value: V; }
function getAllKeyValues<TKey, TValue>(
    tree: BTree<TKey, KeyValue<TKey, TValue>>
): KeyValue<TKey, TValue>[] {
    const entries: KeyValue<TKey, TValue>[] = [];
    const firstPath = tree.first();
    if (!firstPath.on) {
        return entries;
    }
    for (const path of tree.ascending(firstPath)) {
        const entry = tree.at(path);
        if (entry !== undefined) {
            entries.push(entry);
        }
    }
    return entries;
}


describe('BTree Copy-on-Write (COW) Functionality', () => {
    const keyFromNumber = (n: number) => n;
    const keyFromObject = (obj: { id: number }) => obj.id;

    interface TestObject {
        id: number;
        data: string;
    }

    let baseTree: BTree<number, TestObject>;
    let derivedTree: BTree<number, TestObject>;

    beforeEach(() => {
        baseTree = new BTree<number, TestObject>(keyFromObject);
        // Populate baseTree
        baseTree.insert({ id: 10, data: 'base ten' });
        baseTree.insert({ id: 20, data: 'base twenty' });
        baseTree.insert({ id: 30, data: 'base thirty' });
        baseTree.insert({ id: 5, data: 'base five' });

        // Create derived tree from baseTree
        derivedTree = new BTree<number, TestObject>(keyFromObject, undefined, baseTree);
    });

    describe('Basic Isolation', () => {
        it('should allow derived tree to see base tree data initially', () => {
            expect(derivedTree.get(10)).to.deep.equal({ id: 10, data: 'base ten' });
            expect(derivedTree.get(20)).to.deep.equal({ id: 20, data: 'base twenty' });
            const expectedBaseEntries = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'base twenty' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedBaseEntries);
        });

        it('insert into derived tree should not affect base tree', () => {
            derivedTree.insert({ id: 15, data: 'derived fifteen' });

            expect(derivedTree.get(15)).to.deep.equal({ id: 15, data: 'derived fifteen' });
            expect(baseTree.get(15)).to.be.undefined;

            const expectedDerived = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 15, data: 'derived fifteen' },
                { id: 20, data: 'base twenty' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedDerived);

            const expectedBase = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'base twenty' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(baseTree, keyFromObject)).to.deep.equal(expectedBase);
        });

        it('update in derived tree should not affect base tree', () => {
            // Update an entry that originated from base
            const path = derivedTree.find(20);
            expect(path.on).to.be.true;
            const [updatedPath, wasUpdate] = derivedTree.updateAt(path, { id: 20, data: 'derived twenty updated' });

            expect(wasUpdate).to.be.true;
            expect(updatedPath.on).to.be.true;
            expect(derivedTree.get(20)).to.deep.equal({ id: 20, data: 'derived twenty updated' });
            expect(baseTree.get(20)).to.deep.equal({ id: 20, data: 'base twenty' }); // Base unchanged

            // Update an entry unique to derived (after an insert)
            derivedTree.insert({ id: 25, data: 'derived twenty-five' });
            const path25 = derivedTree.find(25);
            derivedTree.updateAt(path25, {id: 25, data: 'derived twenty-five updated'});

            expect(derivedTree.get(25)).to.deep.equal({ id: 25, data: 'derived twenty-five updated' });
            expect(baseTree.get(25)).to.be.undefined;


            const expectedDerived = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'derived twenty updated' },
                { id: 25, data: 'derived twenty-five updated'},
                { id: 30, data: 'base thirty' },
            ];
            // Sort expectedDerived by ID for comparison if getAllEntries doesn't guarantee exact order for complex objects
            // For this simple ID case, it should be fine.
             expect(getAllEntries(derivedTree, keyFromObject).sort((a,b) => a.id - b.id)).to.deep.equal(expectedDerived);


            const expectedBase = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'base twenty' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(baseTree, keyFromObject)).to.deep.equal(expectedBase);
        });

        it('delete from derived tree should not affect base tree', () => {
            // Delete an entry that originated from base
            const path20 = derivedTree.find(20);
            expect(path20.on).to.be.true;
            const deleteResult1 = derivedTree.deleteAt(path20);
            expect(deleteResult1).to.be.true;

            expect(derivedTree.get(20)).to.be.undefined;
            expect(baseTree.get(20)).to.deep.equal({ id: 20, data: 'base twenty' }); // Base unchanged

            // Insert and then delete an entry unique to derived
            derivedTree.insert({ id: 15, data: 'derived fifteen' });
            expect(derivedTree.get(15)).to.exist;
            const path15 = derivedTree.find(15);
            const deleteResult2 = derivedTree.deleteAt(path15);
            expect(deleteResult2).to.be.true;

            expect(derivedTree.get(15)).to.be.undefined;
            expect(baseTree.get(15)).to.be.undefined;

            const expectedDerived = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedDerived);

            const expectedBase = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'base twenty' }, // Still here
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(baseTree, keyFromObject)).to.deep.equal(expectedBase);
        });
    });

    describe('Data Integrity and Iteration after mixed COW operations', () => {
        it('should maintain correct order and data after various operations', () => {
            // Initial: 5 (base), 10 (base), 20 (base), 30 (base)

            // 1. Insert in derived
            derivedTree.insert({ id: 15, data: 'derived fifteen' });
            // Derived: 5, 10, 15, 20, 30

            // 2. Delete from derived (originally from base)
            derivedTree.deleteAt(derivedTree.find(10));
            // Derived: 5, 15, 20, 30

            // 3. Update in derived (originally from base)
            derivedTree.updateAt(derivedTree.find(30), { id: 30, data: 'derived thirty updated' });
            // Derived: 5, 15, 20, (30, updated)

            // 4. Insert another in derived
            derivedTree.insert({ id: 25, data: 'derived twenty-five' });
            // Derived: 5, 15, 20, 25, (30, updated)

            const expectedDerivedEntries = [
                { id: 5, data: 'base five' },
                { id: 15, data: 'derived fifteen' },
                { id: 20, data: 'base twenty' },
                { id: 25, data: 'derived twenty-five' },
                { id: 30, data: 'derived thirty updated' },
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedDerivedEntries);

            // Verify base tree is still pristine
            const expectedBaseEntries = [
                { id: 5, data: 'base five' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'base twenty' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(baseTree, keyFromObject)).to.deep.equal(expectedBaseEntries);

            // Test find/get for various cases
            expect(derivedTree.get(5)).to.deep.equal({ id: 5, data: 'base five' }); // From base, untouched
            expect(derivedTree.get(10)).to.be.undefined; // Deleted from derived
            expect(baseTree.get(10)).to.deep.equal({ id: 10, data: 'base ten' }); // Still in base
            expect(derivedTree.get(15)).to.deep.equal({ id: 15, data: 'derived fifteen' }); // Inserted in derived
            expect(derivedTree.get(20)).to.deep.equal({ id: 20, data: 'base twenty' }); // From base, untouched by these ops in derived
            expect(derivedTree.get(25)).to.deep.equal({ id: 25, data: 'derived twenty-five' }); // Inserted in derived
            expect(derivedTree.get(30)).to.deep.equal({ id: 30, data: 'derived thirty updated' }); // From base, updated in derived
        });
    });

    describe('clearBase() Functionality', () => {
        beforeEach(() => {
            // Operations on derivedTree before clearBase
            derivedTree.insert({ id: 1, data: 'derived one' });
            derivedTree.updateAt(derivedTree.find(20), { id: 20, data: 'derived twenty updated' });
            derivedTree.deleteAt(derivedTree.find(5));
            // Derived state: 1(D), 10(B), 20(D_upd), 30(B)
        });

        it('derived tree should retain its state after clearBase', () => {
            derivedTree.clearBase();

            const expectedDerivedState = [
                { id: 1, data: 'derived one' },
                { id: 10, data: 'base ten' },
                { id: 20, data: 'derived twenty updated' },
                { id: 30, data: 'base thirty' },
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedDerivedState);
            expect(derivedTree.get(5)).to.be.undefined; // Was deleted from derived
        });

        it('changes to original base tree should not affect derived tree after clearBase', () => {
            derivedTree.clearBase();

            // Now modify baseTree
            baseTree.insert({ id: 100, data: 'base one hundred' });
            baseTree.deleteAt(baseTree.find(10));
            baseTree.updateAt(baseTree.find(30), {id: 30, data: 'base thirty heavily updated'});

            const expectedDerivedState = [ // Same as before baseTree modification
                { id: 1, data: 'derived one' },
                { id: 10, data: 'base ten' }, // Should still have 10 from pre-clearBase state
                { id: 20, data: 'derived twenty updated' },
                { id: 30, data: 'base thirty' }, // Should have the 'base thirty' from pre-clearBase, not 'heavily updated'
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedDerivedState);

            // Check specific values
            expect(derivedTree.get(100)).to.be.undefined;
            expect(derivedTree.get(10)).to.deep.equal({ id: 10, data: 'base ten' });
            expect(derivedTree.get(30)).to.deep.equal({ id: 30, data: 'base thirty' });


            const expectedBaseState = [
                // 5 was in original base, still there
                { id: 20, data: 'base twenty' },
                { id: 30, data: 'base thirty heavily updated' },
                { id: 100, data: 'base one hundred' },
            ];
             // Original base had: 5, 10, 20, 30. We deleted 10, updated 30, added 100. So: 5, 20, 30-updated, 100
            const actualBaseEntries = getAllEntries(baseTree, keyFromObject);
            expect(actualBaseEntries).to.deep.include.members([
                 { id: 5, data: 'base five' }, // Was in original base, not touched by these specific ops
                 { id: 20, data: 'base twenty' },
                 { id: 30, data: 'base thirty heavily updated' },
                 { id: 100, data: 'base one hundred' }
            ]);
            expect(actualBaseEntries.find(e => e.id === 10)).to.be.undefined;
            expect(actualBaseEntries.length).to.equal(4);
        });

        it('derived tree should function correctly for new operations after clearBase', () => {
            derivedTree.clearBase();
            // Derived state: 1(D), 10(B_orig), 20(D_upd), 30(B_orig)

            derivedTree.insert({ id: 50, data: 'derived fifty after clear' });
            derivedTree.deleteAt(derivedTree.find(1));
            derivedTree.updateAt(derivedTree.find(10), { id: 10, data: 'derived ten updated after clear' });

            const expectedDerivedState = [
                { id: 10, data: 'derived ten updated after clear' },
                { id: 20, data: 'derived twenty updated' },
                { id: 30, data: 'base thirty' },
                { id: 50, data: 'derived fifty after clear' },
            ];
            expect(getAllEntries(derivedTree, keyFromObject)).to.deep.equal(expectedDerivedState);
            expect(derivedTree.get(1)).to.be.undefined;
        });
    });

    // TODO: Add tests for multi-level inheritance
    // TODO: Add tests for random operations (stress tests)

    interface Entry {
        id: number;
        value: string;
        origin: 'base' | 'derived';
    }

    // ---------------------------------------------------------------------------------------------
    // Hardened randomized COW stress test.
    //
    // The prior version of this block was structurally unable to exercise the COW delete-rebalance bug
    // (the one fixed in `Fix COW delete rebalancing: link clones into owned ancestors`):
    //   - INITIAL_BASE_SIZE (50) was BELOW NodeCapacity (64), so `base` was a single leaf that never
    //     rebalanced. The bug only occurs in a MULTI-LEVEL tree, where a borrowed/merged sibling is
    //     still owned by `base` while the deleted leaf has already been cloned into the child.
    //   - it used unseeded `Math.random()`, so a failure could not be reproduced.
    //   - it verified ascending-only and only diffed the shadow `Map` at the very end, so a
    //     phantom-repeat / dropped key on the reverse direction could slip through.
    //
    // This version builds a genuinely multi-level base of object entries, drives a SEEDED,
    // DELETE-BIASED op stream whose deletes hit INTERIOR (non-front-anchored) keys, and after every
    // op (sampled at a tight interval) asserts the structural + ownership invariants and bidirectional
    // set-equality vs the shadow `Map` — with `base` proven pristine throughout, not just at the end.
    // See test/b-tree.cow-delete.test.ts's header for why front-anchored deletes dodge the bug.
    describe('Randomized Operations Stress Test', () => {
        const keyExtractor = (item: Entry) => item.id;

        const INITIAL_BASE_SIZE = 400;                     // well above NodeCapacity (64) => a multi-level base
        const MAX_KEY_VALUE = INITIAL_BASE_SIZE * 2;       // leave room for inserts to interleave with the base keys
        const NUM_OPERATIONS = 1500;
        const CHECK_INTERVAL = 20;                         // sample the O(n) invariant assertions (per-op is too slow)
        const MULTI_LEVEL_FLOOR = NodeCapacity * 3;        // keep the tree comfortably multi-level: force inserts below this
        // Fixed seeds => deterministic & reproducible. The seed is embedded in the test title and every
        // assertion message, so a CI failure names the exact stream that produced it.
        const SEEDS = [0xC0FFEE, 0x9E3779B1, 0xBADF00D];

        /** A deterministic, genuinely multi-level base of object entries (odd ids 1..2N-1). */
        function makeBase(): BTree<number, Entry> {
            const base = new BTree<number, Entry>(keyExtractor);
            for (let i = 0; i < INITIAL_BASE_SIZE; i++) {
                const id = i * 2 + 1;
                const item: Entry = { id, value: `base_val_${id}`, origin: 'base' };
                base.insert(item);
            }
            return base;
        }

        /** Whether the COW child owns a local root yet (false while it still defers entirely to its base). */
        function hasLocalRoot(tree: BTree<number, Entry>): boolean {
            return Boolean((tree as any)['_root']);
        }

        /** Collect entries via descending iteration, returned ascending so it can be compared to the ascending walk. */
        function collectDescending(tree: BTree<number, Entry>): Entry[] {
            const out: Entry[] = [];
            for (const path of tree.descending(tree.last())) {
                const entry = tree.at(path);
                if (entry !== undefined) out.push(entry);
            }
            return out.reverse();
        }

        /** Both iteration directions must agree on the exact same ordered set (an ascending-only walk would
         * miss a phantom-repeat / drop that only shows on the reverse). Returns the ascending entry list. */
        function liveSetBidirectional(tree: BTree<number, Entry>, ctx: string): Entry[] {
            const asc = getAllEntries(tree, keyExtractor);
            const desc = collectDescending(tree);
            expect(desc, `descending iteration agrees with ascending ${ctx}`).to.deep.equal(asc);
            return asc;
        }

        for (const seed of SEEDS) {
            it(`maintains COW structure & isolation over ${NUM_OPERATIONS} delete-biased ops [seed 0x${seed.toString(16)}]`, function () {
                this.timeout(20000);

                const tag = `[seed 0x${seed.toString(16)}]`;
                const rng = lcg(seed);

                const base = makeBase();
                expect(base.getCount(), `${tag} base must be multi-level`).to.be.greaterThan(NodeCapacity);
                assertTreeInvariants(base);
                const baseEntries = getAllEntries(base, keyExtractor).map(e => ({ ...e })); // deep copy for value-level pristine checks

                const derived = new BTree<number, Entry>(keyExtractor, undefined, base);
                const snap = snapshotBase(base);  // capture base BEFORE any COW write, for the ownership invariant

                // Shadow Map mirrors the expected derived state; seed it with the base's entries.
                const shadow = new Map<number, Entry>();
                baseEntries.forEach(e => shadow.set(e.id, { ...e }));

                const verify = (op: number) => {
                    const ctx = `${tag} @op${op}`;
                    // Derived child: structural well-formedness + connected, base-disjoint mutable spine.
                    if (hasLocalRoot(derived)) assertTreeInvariants(derived);
                    // Ownership also re-validates the base's structure & proves its keys/node-identities match the snapshot.
                    assertOwnershipInvariant(derived, base, snap);

                    // Bidirectional set-equality vs the shadow Map.
                    const actual = liveSetBidirectional(derived, ctx);
                    const expected = Array.from(shadow.values()).sort((a, b) => keyExtractor(a) - keyExtractor(b));
                    expect(actual, `derived matches shadow ${ctx}`).to.deep.equal(expected);

                    // Base stays pristine throughout (value-level), not just at the end.
                    expect(getAllEntries(base, keyExtractor), `base unchanged ${ctx}`).to.deep.equal(baseEntries);
                };

                for (let i = 0; i < NUM_OPERATIONS; i++) {
                    let roll = lcgInt(rng, 0, 100);
                    // Keep the tree comfortably multi-level so deletes keep provoking real multi-level rebalance.
                    if (shadow.size <= MULTI_LEVEL_FLOOR) roll = 99; // force an INSERT

                    if (roll < 50 && shadow.size >= 2) {
                        // DELETE (delete-biased: the path the COW bug lived in). Hit an INTERIOR key — never the
                        // current minimum — because a front-anchored delete only ever borrows/merges with its
                        // RIGHT sibling and dodges the bug (see test/b-tree.cow-delete.test.ts header).
                        const sortedKeys = Array.from(shadow.keys()).sort((a, b) => a - b);
                        const idToDelete = sortedKeys[lcgInt(rng, 1, sortedKeys.length)]; // index >= 1 => non-front-anchored
                        const path = derived.find(idToDelete);
                        expect(path.on, `${tag} key ${idToDelete} present before delete @op${i}`).to.equal(true);
                        expect(derived.deleteAt(path), `${tag} deleteAt ${idToDelete} @op${i}`).to.equal(true);
                        shadow.delete(idToDelete);
                    } else if (roll < 65 && shadow.size > 0) {
                        // UPDATE: re-value an existing key. A base-origin entry becomes derived-owned on first write.
                        const keys = Array.from(shadow.keys());
                        const idToUpdate = keys[lcgInt(rng, 0, keys.length)];
                        const updated: Entry = { id: idToUpdate, value: `upd_${idToUpdate}_op${i}`, origin: 'derived' };
                        const path = derived.find(idToUpdate);
                        expect(path.on, `${tag} key ${idToUpdate} present before update @op${i}`).to.equal(true);
                        derived.updateAt(path, updated);
                        shadow.set(idToUpdate, updated);
                    } else {
                        // INSERT a key not currently present.
                        let id = lcgInt(rng, 0, MAX_KEY_VALUE);
                        for (let tries = 0; tries < 16 && shadow.has(id); tries++) {
                            id = lcgInt(rng, 0, MAX_KEY_VALUE);
                        }
                        if (!shadow.has(id)) {
                            const item: Entry = { id, value: `ins_${id}_op${i}`, origin: 'derived' };
                            const path = derived.find(id);
                            expect(path.on, `${tag} key ${id} absent before insert @op${i}`).to.equal(false);
                            derived.insert(item);
                            shadow.set(id, item);
                        }
                    }

                    if (i % CHECK_INTERVAL === 0 || i === NUM_OPERATIONS - 1) verify(i);
                }

                // Final full verification.
                const finalExpected = Array.from(shadow.values()).sort((a, b) => keyExtractor(a) - keyExtractor(b));
                expect(liveSetBidirectional(derived, `${tag} final`), `${tag} final derived matches shadow`).to.deep.equal(finalExpected);
                expect(derived.getCount(), `${tag} derived count matches shadow`).to.equal(shadow.size);
                expect(getAllEntries(base, keyExtractor), `${tag} base pristine at end`).to.deep.equal(baseEntries);
            });
        }
    });
});
