# Changelog

All notable changes are recorded here, in the Keep a Changelog style. Each release states its score impact.

## [Unreleased]

Score impact: neutral

### Added

- Initial extraction of the TypeScript CRAP ratchet gate, with its tests and synthetic fixtures. Sources, messages, exit codes and the threshold are unchanged.
- Repository docs, pull request template, Dependabot configuration and CI (type-check, tests, and the repository's own gate).
- `crap/config.json`: optional configuration with `scope`, `anchors`, `extensions`, `exclude`, `coverage` and `threshold`. Unknown keys, wrong types and empty lists fail with exit 1. With no file, or a file of defaults, every output is unchanged.
- In-process ESLint. `measure` lints the configured scope with the ESLint Node API and a built-in flat config equal to the gate's original config, so no `eslint -f json` step and no `coverage/crap-eslint.json` are needed.
- `check` runs `measure` first, then the ratchet check. `baseline` runs `measure --accept-unmatched` first, then writes the baseline files. Each stops with exit 1 when the measure fails.
- `diff [--base-ref <rev>]` reads the base `crap/` files from a git revision (default `HEAD^1`). A path the revision lacks means the base is absent; any `git` failure exits 1. The file-path flags remain.
- The repository runs its own gate in CI (`CRAP ratchet gate` and `CRAP baseline diff`).

### Changed

- The usage message lists `diff [--base-ref <rev>]`.
- The `diff` pass note names the base file as `<rev>:crap/<file>` when the base comes from a revision.
