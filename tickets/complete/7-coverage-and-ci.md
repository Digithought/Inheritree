description: Measure test coverage and run the suite automatically on every push and pull request via CI.
files: package.json, .github/workflows/ci.yml, .c8rc.json, readme.md
----
## What was delivered

Coverage measurement and a GitHub Actions CI workflow for the library:

- **`package.json`** — `c8` added to devDependencies; `test:coverage` script wraps the mocha invocation in `c8` (with `--timeout 0` since coverage instrumentation slows execution).
- **`.c8rc.json`** — instruments `src/**/*.ts`, excludes `test/**`, `dist/**`, `node_modules/**`; emits `text` + `lcov` reporters; `check-coverage: true` with thresholds (see Review findings for the tightening applied this pass).
- **`.github/workflows/ci.yml`** — runs on push/PR to `master`, Node matrix 20.x/22.x, `corepack enable` → `yarn install --immutable` → `yarn build` → `yarn test` → `yarn test:coverage`, then uploads `coverage/lcov.info` as an artifact with `if-no-files-found: error`.
- **`readme.md`** — Coverage line added to the Environment/contribution section documenting `yarn test:coverage` / `npm run test:coverage`.

## Validation (this review pass)

- `yarn test:coverage` → **168 passing**, coverage **100% stmts / 99.62% branches / 100% funcs / 100% lines**. Passes against tightened thresholds (exit 0).
- `yarn build` → exit 0.
- `yarn install --immutable` → exit 0 — confirms the committed lockfile is consistent (resolves the implement-stage "lockfile must be committed" gap).
- `coverage/lcov.info` is produced at the path the CI artifact step uploads.

## Review findings

**Scrutinized:** correctness of all four artifacts, the coverage gate's effectiveness, the one uncovered branch, lockfile/`--immutable` consistency, build/test/coverage green status, lcov artifact path alignment, gitignore hygiene, lint wiring, and CI step redundancy.

- **Coverage gate too loose (minor — fixed inline).** Thresholds were lines/statements 98, branches 99, functions 97 while the actual waterline is 100/99.62/100/100. A gate set well below the waterline lets real coverage regressions pass silently, defeating its purpose (coverage is deterministic, not "flaky"). Tightened `.c8rc.json` to lines/statements/functions **100**, leaving branches at **99** to tolerate one unreachable defensive branch. Re-verified green.
- **Uncovered branch `b-tree.ts:538` (checked — confirmed unreachable, no change).** The `: 0` arm of `path.leafIndex = count > 0 ? count - 1 : 0` in `moveToLast`. `moveToLast` is only invoked while descending into a populated sibling subtree (from `internalPrior`, line 444) or recursively; an empty leaf would require an empty-tree root, but `internalPrior` short-circuits before calling `moveToLast` in that case. The branch is genuine dead defensive code, hence the branches threshold staying at 99 rather than forcing 100.
- **Lint not wired (minor — backlog ticket filed).** `eslint` and `@typescript-eslint/*` are in devDependencies, but there is no eslint config file anywhere and no `lint` script — linting cannot be run locally or in CI. Pre-existing (predates this ticket) and adjacent to but outside "coverage and CI" scope, since wiring it requires authoring a ruleset. Filed `tickets/backlog/lint-config-and-ci.md`.
- **CI runs the suite twice (checked — acceptable, no change).** The `Test` step (`yarn test`, default per-test timeouts) and `Coverage` step (`yarn test:coverage`, `--timeout 0`) both run the full suite. The redundancy is defensible: `Test` enforces per-test timeouts that catch performance regressions, which coverage deliberately disables. Documented as a considered tradeoff rather than removing the step.
- **Peer-dependency warning (checked — non-blocking).** `yarn install --immutable` emits `YN0002` (ts-node requests `@types/node`, not provided). It is a warning, exit 0; pre-existing and does not affect CI. Left as-is.
- **gitignore (checked — clean).** `/coverage` is gitignored; no coverage output is tracked.
- **No new tickets for majors:** none warranted — the only out-of-scope loose end (lint) is captured in backlog.
