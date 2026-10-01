# verifime-crap-gate

A CRAP ratchet gate for TypeScript repositories. It scores each function by complexity and test coverage, then fails a build when the set of high-scoring functions grows or a recorded score worsens.

## What the gate measures

CRAP is computed per function as:

    CRAP = cc^2 * (1 - cov)^3 + cc

where `cc` is cyclomatic complexity and `cov` is the function's coverage ratio (0 to 1). The result is rounded to 3 decimal places. Complexity comes from an ESLint report; coverage comes from Istanbul-format `coverage-final.json` files.

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

`check` refuses a report made with `--accept-unmatched`.

## Commands

The entry point has four commands. Flags as in its usage string:

- `measure [--coverage <path>]... [--accept-unmatched]`. Without `--coverage`, it reads `coverage/coverage-final.json` and `cdk/coverage/coverage-final.json`.
- `check`
- `baseline [--allow-growth]`
- `diff --base <path> --base-unmatched <path> [--base-absent] [--base-unmatched-absent] [--head <path>] [--head-unmatched <path>]`

The entry point reads the ESLint report from `coverage/crap-eslint.json`.

## Exit codes

- `0`: pass.
- `1`: any failure. This includes missing input, nothing measured, an unmatched function that is not listed, growth against the baseline, a malformed file, a failing `diff` and a usage error.

## Development

    npm ci
    npm run typecheck
    npm test

See `CLAUDE.md` for the rules this public repository follows.

## Licence

Apache-2.0. See `LICENSE`.
