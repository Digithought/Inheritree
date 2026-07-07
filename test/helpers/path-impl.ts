import type { Path } from '../../src/index.js';
import { PathImpl } from '../../src/path.js';

/** White-box test cast: view a public {@link Path} (the insulated interface the package exports) as its
 * concrete {@link PathImpl} so a test can read the structural fields (branches / leafNode / leafIndex /
 * version) that the interface deliberately hides.  Production code cannot do this by accident; tests opt in
 * explicitly through this single helper so the casts stay greppable and reviewable. */
export const asImpl = <TKey, TEntry>(p: Path<TKey, TEntry>): PathImpl<TKey, TEntry> =>
	p as unknown as PathImpl<TKey, TEntry>;
