description: The project lists linting tools as dependencies but they aren't actually set up, so no linting ever runs — neither for developers nor in automated checks.
files: package.json, .github/workflows/ci.yml, eslint.config.js (to be created)
----
## Background

`eslint`, `@typescript-eslint/eslint-plugin`, and `@typescript-eslint/parser` are declared in `package.json` devDependencies, but:

- there is **no** eslint configuration file (`eslint.config.js` / `.eslintrc*`) anywhere in the repo,
- there is **no** `lint` script in `package.json`,
- the CI workflow (`.github/workflows/ci.yml`) does not run lint.

As a result the linting toolchain is installed but inert — it cannot be invoked and enforces nothing.

## Why this is a backlog item

This surfaced during review of the `coverage-and-ci` ticket. It is adjacent to CI but out of scope there, because wiring lint requires a design decision: which ruleset to adopt (recommended TS-ESLint config vs a curated set), how strict to be, and whether the existing source passes cleanly or needs fixes first.

## Desired outcome

- A flat eslint config (`eslint.config.js`) appropriate for an ESM TypeScript library, using `@typescript-eslint`.
- A `lint` (and optionally `lint:fix`) script in `package.json`.
- A `Lint` step added to the CI workflow so PRs are gated on it.
- The existing `src/**` and `test/**` either pass the chosen rules or are brought into compliance (decide scope: source only vs source + tests).

## Open questions for whoever picks this up

- Adopt `typescript-eslint` recommended (type-checked) rules, or a lighter non-type-checked baseline to keep CI fast?
- Should lint failures block CI, or warn-only initially while the codebase is brought into compliance?
