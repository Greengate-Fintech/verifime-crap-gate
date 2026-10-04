# verifime-crap-gate

A CRAP ratchet gate for TypeScript repositories. It scores each function by complexity and test coverage, then fails a build when the set of high-scoring functions grows or a recorded score worsens.

## What the gate measures

CRAP is computed per function as:

    CRAP = cc^2 * (1 - cov)^3 + cc

where `cc` is cyclomatic complexity and `cov` is the function's coverage ratio (0 to 1). The result is rounded to 3 decimal places. Complexity comes from ESLint, which the gate runs itself, in-process; coverage comes from Istanbul-format `coverage-final.json` files.

The threshold is 8. A function scoring above 8 is an offender.

## The ratchet

Offenders are recorded in a baseline. The baseline only shrinks:

- A function above the threshold that is not in the baseline fails the check.
- A recorded function whose score rose fails the check. A rise is the current score minus the recorded score, rounded to 3 decimal places, above a tolerance of 0.05.
- A recorded function that now scores at or below the threshold, or that has gone (removed, renamed or merged, so fewer occurrences than recorded rows), is stale. `check` exits 1 until the baseline is regenerated.
- A recorded function that improves but stays above the threshold passes.
- Growth in the baseline needs `baseline --allow-growth`.

Keys carry no line number, so an unrelated edit above a function is not churn.

## Files

### `crap/baseline.tsv`

Tab-separated, one row per scored occurrence of an offender:

    file<TAB>symbol<TAB>score

Generated files write scores with 3 decimal places. The parser accepts any plain non-negative decimal. Lines that are empty or start with `#` are ignored. The file begins with a comment header. A malformed row is an error.

### `crap/unmatched.tsv`

Functions the coverage provider gives no entry for. Each is scored at coverage 0 and joins the ratchet. One row per occurrence:

    file<TAB>symbol

The list only shrinks. An unmatched function that is not listed fails the measure, and a listed entry that now matches is stale.

### Report

`coverage/crap-report.json` is written by `measure`. Its fields are `summary`, `functions`, `unmatched`, `listedUnmatched`, `staleUnmatched` and `acceptedUnmatched`.

`measure` deletes any earlier report first. It then writes a new report even when it exits 1 (problems, unmatched functions, stale entries, nothing measured). It writes no report only when it throws, for example on missing or unreadable input.

`check` and `baseline` read the report their own measure has just written. `check` also refuses a report made with `--accept-unmatched`, which guards a report that comes from outside the gate.

## CRAP gate

When `check` fails, read the message:

- `NEW OFFENDER` or `REGRESSION`: change the code so the function scores lower. Growth in the baseline needs `npm run crap:baseline -- --allow-growth`, and a reason in the pull request.
- `STALE ENTRY`: a recorded function improved below the threshold or has gone. Delete the line, or run `npm run crap:baseline`.
- `Unmatched function`: the coverage provider has no entry for it. Fix the coverage, or run `npm run crap:baseline` to list it.

`diff` fails when a head file has grown against its base, and leaves the decision to the reviewer.

## How complexity is measured

The gate runs ESLint through its Node API. It does not read your ESLint config and needs no ESLint report. It lints the `scope` directories that exist, with a built-in flat config:

- the typescript-eslint parser;
- the `complexity` rule at `max: 0`, so every function is reported with its cyclomatic complexity;
- inline directives off (`noInlineConfig`), and unused-directive reporting off;
- files matched by `extensions` only (`.ts` by default), so a compiled `.js` file beside its `.ts` source reports no function;
- ignored: files under `node_modules`, `dist`, `coverage` and `cdk.out` folders, and `*.d.ts` files.

A directory of the default scope that does not exist is skipped. A directory in a `scope` that your config sets must exist: a missing one, or one that is a file, exits 1 with `Invalid <config file>: key "scope" entry "<dir>" is not an existing directory`. When no scope directory exists, nothing is measured and the run exits 1 with `No functions were measured`.

## Commands

Each command runs from the repository root. Each lints and measures itself. Every command also takes `--config <path>`, the configuration file to read (see Configuration).

- `measure [--coverage <path>]... [--accept-unmatched]`: lints, joins the result to coverage and writes `coverage/crap-report.json`. Without `--coverage`, it reads the `coverage` files from the config (see Configuration), which default to `coverage/coverage-final.json` and `cdk/coverage/coverage-final.json`.
- `check`: runs `measure`, then the ratchet check against `crap/baseline.tsv`. It stops with exit 1, without the ratchet check, when the measure fails.
- `baseline [--allow-growth] [--output-dir <dir>]`: runs `measure` with `--accept-unmatched`, then writes `crap/baseline.tsv` and `crap/unmatched.tsv`. It stops with exit 1 when the measure fails. With `--output-dir`, it writes `baseline.tsv` and `unmatched.tsv` into that directory instead, and leaves `crap/` alone. The growth check still reads `crap/baseline.tsv` and `crap/unmatched.tsv`.
- `diff [--base-ref <rev>]`: compares the working tree's `crap/baseline.tsv` and `crap/unmatched.tsv` with the same files at a git revision. The default revision is `HEAD^1`, the first parent of the checked-out commit (for a pull request check, the first parent of the merge commit). It reads the base with `git`, not from the working tree.
  - A path the revision does not have means the base is absent (the initial freeze), and the comparison passes for that file.
  - A revision that does not resolve, or any other `git` failure, exits 1.
  - A pull request check needs a checkout with `fetch-depth: 2`, so that `HEAD^1` exists.
- `diff --base <path> --base-unmatched <path> [--base-absent] [--base-unmatched-absent] [--head <path>] [--head-unmatched <path>]`: the same comparison with the base read from files. It cannot be combined with `--base-ref`.

`check` and `baseline` write `coverage/crap-report.json` as part of their measure. They never trust a report left by an earlier run.

A consumer adds npm scripts that call the gate, for example `crap:check` and `crap:baseline`. The messages tell a reader to run `npm run crap:baseline`.

## Configuration

The gate reads `crap/config.json` from the directory it runs in, or the file named by `--config <path>` (the action's `config` input), relative to that directory. The path `crap/config.json`, written exactly so, is optional even when named: a missing file means all defaults. Any other path that is missing is an error. Without it, every key has the default below. Every key is optional, and a file that sets none of them behaves like no file.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `scope` | array of strings | `["src", "lib", "bin", "cdk/src", "cdk/lib", "cdk/bin"]` | Repo-relative directories whose files are measured. A file is measured when it sits under one of them. |
| `anchors` | array of strings | `["src", "lib", "bin", "cdk"]` | Path segment names used to join a coverage path from another machine to a measured file. The join tries each anchor segment of the coverage path, last first. |
| `extensions` | array of strings | `[".ts"]` | File extensions measured, each with its leading dot. `.tsx` is measured only when listed. |
| `exclude` | array of strings | `[]` | Regular-expression sources matched against the repo-relative path. A match is not measured. They are added to the built-in exclude, which always applies (tests, mocks, fixtures, generated and build folders, declaration and config files). |
| `coverage` | array of strings | `["coverage/coverage-final.json", "cdk/coverage/coverage-final.json"]` | Istanbul coverage files that `measure` reads. |
| `threshold` | number | `8` | A function scoring above it is an offender. It applies to the `measure` summary and to `check` and `baseline`. It must be finite and greater than 0. |

Notes:

- Nested packages are not measured by the default `scope`. List each one, for example `packages/x/src`.
- When coverage paths were written on a different checkout root, the gate joins them to measured files on a path segment. Every segment that join should start on must be in `anchors`. A segment that is not listed drops that coverage, and the function is then reported as unmatched.
- The gate reads the configuration file from the working directory, and the `--config` path is relative to it.
- A key repeated in the file takes its last value.
- The summary fields `over5` and `sumOver5`, and the `over5=` text, keep those names whatever `threshold` is.

Coverage files, highest precedence first: the `--coverage` flag of `measure`, then `coverage` in the config, then the default.

The gate validates the file before it runs any command. It exits 1, naming `crap/config.json` and the key, when:

- the file is not valid JSON, or is not a JSON object;
- a key is not in the table above;
- a value has the wrong type;
- `scope`, `anchors`, `extensions` or `coverage` is an empty array;
- a `scope` entry is not a repo-relative directory, an `anchors` entry is not one path segment name, an `extensions` entry does not start with a dot, or an `exclude` entry is not a valid regular expression.

The baseline and unmatched files do not record the threshold. Changing `threshold` changes which functions are offenders, so regenerate both files after a change.

## Exit codes

- `0`: pass.
- `1`: any failure. This includes missing input, nothing measured, an unmatched function that is not listed, growth against the baseline, a malformed file, a failing `diff` and a usage error.

## Use as a GitHub Action

The action runs the bundled gate on the runner's Node 24. It needs no `npm install`, no ESLint and no TypeScript in your repository. Your coverage must exist before the action runs, as `coverage/coverage-final.json` (or the files in `coverage` of your config).

Pin the action to an exact release tag, written `@vX.Y.Z` below (replace it with a tag that exists). Never pin to a moving major tag, and never to a branch or to a commit on `main`: `main` does not contain `dist/`, so only a release tag (or the release commit it points to) runs.

### Inputs and output

| Input | Default | Meaning |
|---|---|---|
| `mode` (required) | none | `measure`, `check`, `baseline` or `diff`. |
| `config` | `crap/config.json` | The configuration file. |
| `base` | `HEAD^1` | `diff` only: the revision whose `crap/` files are the base. Other modes ignore it and print a `::warning::`. |
| `output-dir` | none | `baseline` only: write the regenerated files here instead of `crap/`. A relative path is relative to `working-directory`. Other modes ignore it and print a `::warning::`. |
| `working-directory` | `.` | The directory to run in, relative to the workspace. |

The `summary` output is one line. With exit code 0 it is the last standard output line. With any other exit code it is the last standard error line that is not a `::` annotation. Each falls back to the other stream when it has no line. The action also writes a short job summary. Its exit code and messages are the CLI's for the same mode. With `GITHUB_ACTIONS=true`, which the runner sets, a failing `check` or `diff` also writes `::error` annotations. Under a `working-directory` other than the workspace root, the action prefixes each annotation's file path with that directory, because GitHub reads it from the root.

### The two consumer jobs

```yaml
jobs:
  crap-ratchet-gate:
    name: CRAP ratchet gate
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm run test:coverage # writes coverage/coverage-final.json
      - uses: Greengate-Fintech/verifime-crap-gate@vX.Y.Z
        with:
          mode: check

  crap-baseline-diff:
    name: CRAP baseline diff
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 2 # mode diff reads HEAD^1
      - uses: Greengate-Fintech/verifime-crap-gate@vX.Y.Z
        with:
          mode: diff
```

When tests run in another job, upload `coverage/` there and download it before the gate:

```yaml
      - uses: actions/download-artifact@v8
        with:
          name: coverage
          path: coverage
```

Use `working-directory` for a package that is not at the repository root. The config, baseline and coverage paths are then relative to it.

### Regenerating the baseline in CI

`baseline` mode with `output-dir` writes the regenerated files for you to download. It never commits. It needs the same checkout, install and coverage steps as the `check` job above, so that the same coverage exists. Add them before this step:

```yaml
      - uses: Greengate-Fintech/verifime-crap-gate@vX.Y.Z
        with:
          mode: baseline
          output-dir: ${{ runner.temp }}/crap-baseline
      - uses: actions/upload-artifact@v7
        with:
          name: crap-baseline
          path: ${{ runner.temp }}/crap-baseline
```

Copy `baseline.tsv` and `unmatched.tsv` from the artefact into `crap/`. Growth is refused as in the CLI, and the action has no `allow-growth` input: a re-baseline that grows the baseline is run locally with `--allow-growth`, with a reason in the pull request.

### Keep the pin current

Dependabot can raise a pull request for each new tag:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

A tag that changes any score is released as "Score impact: changing" (see `CHANGELOG.md`). Read the note before you merge the bump.

## Use as a CLI

The bundled CLI runs through `npx` from a release tag, with nothing to install (the tag's tree contains `dist/`):

    npx --yes github:Greengate-Fintech/verifime-crap-gate#vX.Y.Z check

The gate's advice text tells a reader to run `npm run crap:baseline`, so add wrappers to the consumer's `package.json`:

```json
{
  "scripts": {
    "crap": "npx --yes github:Greengate-Fintech/verifime-crap-gate#vX.Y.Z check",
    "crap:baseline": "npx --yes github:Greengate-Fintech/verifime-crap-gate#vX.Y.Z baseline"
  }
}
```

`npm run crap:baseline -- --allow-growth` then forwards the flag. Keep the tag in the two scripts equal to the tag in your workflow.

The package's `bin` is `crap-gate`, which is `dist/cli.cjs`.

## The bundle

`dist/` is generated and is not committed on `main`. `npm run build` produces it, with esbuild, from `src/`. The release workflow commits it on the release commit that a release tag points to (see Releasing). The bundle has three files:

- `dist/cli.cjs` bundles the gate, ESLint, typescript-eslint and TypeScript. It has no static `require` of a module that is not a Node built-in. ESLint and TypeScript keep dynamic loading sites (`require`, `import()`, `createRequire`) in the bundle, and the gate's options never reach them: it does no config lookup and loads no plugins. So it never resolves a module from the project it measures. A project with a different TypeScript, its own ESLint or its own ESLint config gets the same result.
- `dist/action.cjs` is the action entry. It requires `./cli.cjs`, so the toolchain is bundled once.
- `dist/THIRD-PARTY-LICENSES.txt` lists every package bundled into the CLI, with its version and licence text.
- The cost of committing the bundle to git history, and why it is now paid once per release, is recorded in [`docs/technical-debt.md`](docs/technical-debt.md).

The build is reproducible: a pinned esbuild, no timestamps, no absolute paths, no source maps. CI builds twice on a clean runner and fails when the two outputs differ. A change to `src/` or to a dependency needs nothing extra: a Dependabot bump goes green on its own.

## Development

    npm ci
    npm run typecheck
    npm test
    npm run build

`npm test` builds `dist/` first (a Vitest global setup), so the bundle tests always run against the current source. Run `npm run build` yourself before using `dist/` directly, for example `node dist/cli.cjs measure` or `uses: ./` in a local action run. `dist/` is ignored by git.

## Releasing

A release is cut by the `Release` workflow, never by hand:

1. In a pull request, set the `version` in `package.json` and add a `## [X.Y.Z] - YYYY-MM-DD` section to `CHANGELOG.md`, starting with the `Score impact:` line. Merge it.
2. Run the `Release` workflow (Actions tab, Run workflow) on `main` with `version` set to `X.Y.Z`, without the `v`.

The workflow fails if the tag exists, if `package.json` differs from the input, or if the CHANGELOG section is missing. It then runs `npm ci`, `npm test` and `npm run build`, smoke tests the built CLI, commits `dist/` on a release commit whose parent is the `main` head, tags that commit `vX.Y.Z`, pushes only the tag, and creates the GitHub release with the CHANGELOG section as notes. No branch holds the release commit, and a tag is never moved.

A pull request that changes `release.yml`, `build.mjs` or `package.json` runs the same workflow as a dry run, which stops at a local tag and pushes nothing.

## The gate on this repository

This repository runs its own gate on `src`, with `crap/config.json`, `crap/baseline.tsv` and `crap/unmatched.tsv`. Two CI jobs run it from source with `tsx`:

- `CRAP ratchet gate` runs the tests with coverage (`npm run test:coverage`, which writes `coverage/coverage-final.json`), then `npm run crap:check`.
- `CRAP baseline diff` checks out with `fetch-depth: 2`, then runs `npm run crap:diff`.

Run the same locally with `npm run test:coverage && npm run crap:check`.

Three more CI jobs prove the bundle: `Build is reproducible` (two clean builds give identical hashes), `Action end to end` (on x64 and arm64: it builds `dist/`, then runs the action from this checkout, all four modes, against the synthetic project in `test/e2e/project`, with a negative case that must fail) and `npx from packed tarball` (`npm pack` of a fresh build, run through `npx` in a clean directory, which proves the `bin` and `files` wiring).

See `CLAUDE.md` for the rules this public repository follows.

## Licence

Apache-2.0. See `LICENSE`.
