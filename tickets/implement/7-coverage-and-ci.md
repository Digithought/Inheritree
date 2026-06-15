description: Wire code-coverage measurement and a minimal CI workflow
files: package.json, .github/workflows/ci.yml (new), .c8rc.json (new), readme.md
difficulty: easy
----
No coverage measurement and no CI exist (`package.json:15` is bare mocha; no `.github/workflows`). The COW-delete bug shipped partly because untested paths were invisible. Mirror the DigiTree `coverage-and-ci` ticket here, with the COW suites included.

TODO
- Add `c8` devDependency and a `test:coverage` script wrapping the existing mocha command; emit text + lcov.
- Add `.c8rc.json` covering `src/**`, excluding `test/**` and `dist/**`; set initial thresholds at the measured baseline (record, don't fail yet) and note the target once the COW/test tickets land.
- Add `.github/workflows/ci.yml`: on push/PR, Node LTS matrix, install, `npm run build`, `npm test`, `npm run test:coverage` uploading lcov.
- Document the coverage command in `readme.md`.
- Verify the workflow is green on a scratch branch before closing.
