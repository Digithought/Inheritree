import { expect } from 'chai';
import { BTree } from '../src/b-tree.js';
import { LeafNode } from '../src/nodes.js'; // For type checking if needed, or tree.first().on check

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

    describe('Randomized Operations Stress Test', () => {
        const NUM_OPERATIONS = 2000; // Number of random operations
        const MAX_KEY_VALUE = 1000;   // Max value for keys
        const INITIAL_BASE_SIZE = 50;

        let base: BTree<number, Entry>;
        let derived: BTree<number, Entry>;
        let shadowMap: Map<number, Entry>; // Mirrors derived tree state
        let baseSnapshot: Array<Entry>; // To ensure base doesn't change

        const keyExtractor = (item: Entry) => item.id;

        beforeEach(() => {
            base = new BTree(keyExtractor);
            shadowMap = new Map();

            // Populate base tree and shadow map (for base state)
            for (let i = 0; i < INITIAL_BASE_SIZE; i++) {
                const id = Math.floor(Math.random() * MAX_KEY_VALUE);
                if (!base.get(id)) { // Avoid duplicate keys in initial setup for simplicity
                    const item = { id, value: `base_val_${id}`, origin: 'base' as 'base' };
                    base.insert(item);
                }
            }
            baseSnapshot = getAllEntries(base, keyExtractor).map(entry => ({...entry})); // Deep copy for later comparison

            derived = new BTree(keyExtractor, undefined, base);
            // Populate shadowMap with initial state from base for derived tree
            baseSnapshot.forEach(item => shadowMap.set(item.id, {...item}));
        });

        it(`should maintain B-tree properties and COW isolation over ${NUM_OPERATIONS} random operations`, () => {
            for (let i = 0; i < NUM_OPERATIONS; i++) {
                const operationType = Math.random();
                const randomId = Math.floor(Math.random() * MAX_KEY_VALUE);

                if (operationType < 0.4) { // INSERT (40% chance)
                    const newItem = { id: randomId, value: `val_${randomId}_op${i}`, origin: 'derived' as 'derived' };
                    const path = derived.find(randomId);
                    if (!path.on) { // Key doesn't exist
                        derived.insert(newItem);
                        shadowMap.set(randomId, newItem);
                    } else { // Key exists, treat as an implicit upsert for simplicity in this test
                        const existingItem = derived.at(path)!;
                        const updatedItem = { ...existingItem, value: `upsert_val_${randomId}_op${i}`, origin: 'derived' as 'derived' };
                        derived.updateAt(path, updatedItem);
                        shadowMap.set(randomId, updatedItem);
                    }
                } else if (operationType < 0.7 && shadowMap.size > 0) { // UPDATE (30% chance, if map not empty)
                    // Pick a random existing key from shadowMap to ensure we update something that *should* be in derived
                    const keys = Array.from(shadowMap.keys());
                    const idToUpdate = keys[Math.floor(Math.random() * keys.length)];
                    const currentItem = shadowMap.get(idToUpdate)!;
                    const updatedItem = {
                        ...currentItem,
                        value: `updated_val_${idToUpdate}_op${i}`,
                        // If it was from base, its origin changes to derived upon first update in derived tree
                        origin: 'derived' as 'derived'
                    };
                    const pathToUpdate = derived.find(idToUpdate);
                    if (pathToUpdate.on) {
                        derived.updateAt(pathToUpdate, updatedItem);
                        shadowMap.set(idToUpdate, updatedItem);
                    } else {
                        // This should ideally not happen if shadowMap is in sync
                        console.warn(`Stress test: Attempted to update non-existent key ${idToUpdate} in derived tree. Shadow map might be out of sync.`);
                    }
                } else if (shadowMap.size > 0) { // DELETE (30% chance, if map not empty)
                    const keys = Array.from(shadowMap.keys());
                    const idToDelete = keys[Math.floor(Math.random() * keys.length)];
                    const pathToDelete = derived.find(idToDelete);
                    if (pathToDelete.on) {
                        derived.deleteAt(pathToDelete);
                        shadowMap.delete(idToDelete);
                    } else {
                        // This should ideally not happen
                        console.warn(`Stress test: Attempted to delete non-existent key ${idToDelete} in derived tree. Shadow map might be out of sync.`);
                    }
                }

                // Periodically (or at the end) verify base tree integrity
                if (i % (NUM_OPERATIONS / 10) === 0 || i === NUM_OPERATIONS - 1) {
                     expect(getAllEntries(base, keyExtractor)).to.deep.equal(baseSnapshot, `Base tree changed at operation ${i}`);
                }
            }

            // Final verification
            const expectedDerivedEntries = Array.from(shadowMap.values()).sort((a, b) => keyExtractor(a) - keyExtractor(b));
            const actualDerivedEntries = getAllEntries(derived, keyExtractor);

            expect(actualDerivedEntries).to.deep.equal(expectedDerivedEntries, 'Derived tree does not match shadow map at the end');
            expect(getAllEntries(base, keyExtractor)).to.deep.equal(baseSnapshot, 'Base tree changed by the end of operations');
        });
    });
});
