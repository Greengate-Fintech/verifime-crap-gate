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

`check` and `baseline` read the report their own measure has just written. `check` refuses a report made with `--accept-unmatched`.

## How complexity is measured

The gate runs ESLint through its Node API. It does not read your ESLint config and needs no ESLint report. It lints the `scope` directories that exist, with a built-in flat config:

- the typescript-eslint parser;
- the `complexity` rule at `max: 0`, so every function is reported with its cyclomatic complexity;
- inline directives off (`noInlineConfig`), and unused-directive reporting off;
- files matched by `extensions` only (`.ts` by default), so a compiled `.js` file beside its `.ts` source reports no function;
- ignored: `node_modules`, `dist`, `coverage`, `*.d.ts` and `cdk.out` folders.

A scope directory that does not exist is skipped. When none exists, nothing is measured and the run exits 1 with `No functions were measured`.

## Commands

Each command runs from the repository root. Each lints and measures itself.

- `measure [--coverage <path>]... [--accept-unmatched]`: lints, joins the result to coverage and writes `coverage/crap-report.json`. Without `--coverage`, it reads the `coverage` files from the config (see Configuration), which default to `coverage/coverage-final.json` and `cdk/coverage/coverage-final.json`.
- `check`: runs `measure`, then the ratchet check against `crap/baseline.tsv`. It stops with exit 1, without the ratchet check, when the measure fails.
- `baseline [--allow-growth]`: runs `measure` with `--accept-unmatched`, then writes `crap/baseline.tsv` and `crap/unmatched.tsv`. It stops with exit 1 when the measure fails.
- `diff [--base-ref <rev>]`: compares the working tree's `crap/baseline.tsv` and `crap/unmatched.tsv` with the same files at a git revision. The default revision is `HEAD^1`, the first parent of a pull request's merge commit. It reads the base with `git`, not from the working tree.
  - A path the revision does not have means the base is absent (the initial freeze), and the comparison passes for that file.
  - A revision that does not resolve, or any other `git` failure, exits 1.
  - A pull request check needs a checkout with `fetch-depth: 2`, so that `HEAD^1` exists.
- `diff --base <path> --base-unmatched <path> [--base-absent] [--base-unmatched-absent] [--head <path>] [--head-unmatched <path>]`: the same comparison with the base read from files. It cannot be combined with `--base-ref`.

`check` and `baseline` write `coverage/crap-report.json` as part of their measure. They never trust a report left by an earlier run.

A consumer adds npm scripts that call the gate, for example `crap:check` and `crap:baseline`. The messages tell a reader to run `npm run crap:baseline`.

## Configuration

The gate reads `crap/config.json` from the directory it runs in. The file is optional. Without it, every key has the default below. Every key is optional, and a file that sets none of them behaves like no file.

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
- The gate reads `crap/config.json` from the working directory only.
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

## Development

    npm ci
    npm run typecheck
    npm test

## The gate on this repository

This repository runs its own gate on `src`, with `crap/config.json`, `crap/baseline.tsv` and `crap/unmatched.tsv`. Two CI jobs run it from source with `tsx`:

- `CRAP ratchet gate` runs the tests with coverage (`npm run test:coverage`, which writes `coverage/coverage-final.json`), then `npm run crap:check`.
- `CRAP baseline diff` checks out with `fetch-depth: 2`, then runs `npm run crap:diff`.

Run the same locally with `npm run test:coverage && npm run crap:check`.

See `CLAUDE.md` for the rules this public repository follows.

## Licence

Apache-2.0. See `LICENSE`.
