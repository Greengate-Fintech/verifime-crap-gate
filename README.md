# verifime-crap-gate

A CRAP ratchet gate for TypeScript repositories. It scores each function by complexity and test coverage, then fails a build when the set of high-scoring functions grows or a recorded score worsens.

Status: the gate logic has been extracted and is tested here. Use as a GitHub Action or a local CLI arrives in a later release.

## What the gate measures

CRAP is computed per function as:

    CRAP = cc^2 * (1 - cov)^3 + cc

where `cc` is cyclomatic complexity and `cov` is the function's coverage ratio (0 to 1). The result is rounded to 3 decimal places. Complexity comes from an ESLint report; coverage comes from Istanbul-format `coverage-final.json` files.

The threshold is 8. A function scoring above 8 is an offender.

## The ratchet

Offenders are recorded in a baseline. The baseline only shrinks:

- A function that is new, or scores worse than its recorded score beyond a tolerance of 0.05, fails the check.
- A recorded function that improves or drops below the threshold can be cleared by regenerating the baseline.
- Growth in the baseline needs an explicit `--allow-growth`.

Keys carry no line number, so an unrelated edit above a function is not churn.

## Files

### `crap/baseline.tsv`

Tab-separated, one row per scored occurrence of an offender:

    file<TAB>symbol<TAB>score

Scores have 3 decimal places. Lines that are empty or start with `#` are ignored. The file begins with a comment header. A malformed row is an error.

### `crap/unmatched.tsv`

Functions the coverage provider gives no entry for. Each is scored at coverage 0 and joins the ratchet. One row per occurrence:

    file<TAB>symbol

The list only shrinks. An unmatched function that is not listed fails the measure, and a listed entry that now matches is stale.

### Report

`coverage/crap-report.json` holds the scored functions from `measure`. The `check` command reads it. A failed `measure` removes any earlier report.

## Exit codes

- `0`: pass.
- `1`: any failure, including missing input, nothing measured, an unmatched function that is not listed, growth against the baseline, or a malformed file.

## Commands

The code provides four commands: `measure`, `check`, `baseline` and `diff`. The copied entry point still expects the report at `coverage/crap-eslint.json` and the scripts named in its messages. Packaging and configuration come in later releases.

## Development

    npm ci
    npm run typecheck
    npm test

See `CLAUDE.md` for the rules this public repository follows.

## Licence

Apache-2.0. See `LICENSE`.
