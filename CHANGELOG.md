# Changelog

All notable changes are recorded here, in the Keep a Changelog style. Each release states its score impact.

## [Unreleased]

## [1.0.0] - 2026-10-02

Score impact: neutral

### Added

- Initial extraction of the TypeScript CRAP ratchet gate, with its tests and synthetic fixtures. Sources, messages, exit codes and the threshold are unchanged.
- Repository docs, pull request template, Dependabot configuration and CI (type-check, tests, and the repository's own gate).
- `crap/config.json`: optional configuration with `scope`, `anchors`, `extensions`, `exclude`, `coverage` and `threshold`. Unknown keys, wrong types and empty lists fail with exit 1. With no file, or a file of defaults, every output is unchanged.
- In-process ESLint. `measure` lints the configured scope with the ESLint Node API and a built-in flat config equal to the gate's original config, so no `eslint -f json` step and no `coverage/crap-eslint.json` are needed.
- `check` runs `measure` first, then the ratchet check. `baseline` runs `measure --accept-unmatched` first, then writes the baseline files. Each stops with exit 1 when the measure fails.
- `diff [--base-ref <rev>]` reads the base `crap/` files from a git revision (default `HEAD^1`). A path the revision lacks means the base is absent; any `git` failure exits 1. The file-path flags remain.
- The repository runs its own gate in CI (`CRAP ratchet gate` and `CRAP baseline diff`).
- A GitHub Action (`action.yml`, `runs.using: node24`, `dist/action.cjs`) with inputs `mode`, `config`, `base`, `output-dir` and `working-directory`, and a `summary` output. It writes a short job summary. Its exit code and messages are the CLI's.
- A bundled CLI, `dist/cli.cjs` (`bin` `crap-gate`), usable with `npx github:Greengate-Fintech/verifime-crap-gate#<tag>`. ESLint, typescript-eslint and TypeScript are bundled, so a consumer needs none of them. `dist/THIRD-PARTY-LICENSES.txt` lists the bundled packages and their licences.
- `--config <path>` on every command, and `baseline --output-dir <dir>` to write the regenerated files elsewhere than `crap/`. With neither flag, behaviour is unchanged.
- CI jobs `Rebuild dist`, `Action end to end` and `npx from git`.
- Lint results are sorted by file path, as the ESLint CLI sorts them, so the report and the failure lines follow the original order. A directory in an explicitly configured `scope` that does not exist is now an error (exit 1); absent directories of the default scope are still skipped.
- The action prefixes `::error` annotation paths with a non-root `working-directory`, and warns when `output-dir` or `base` is given to a mode that ignores it. Its `summary` output, for a non-zero exit, is the last error line that is not an annotation.
- The build fails on any esbuild warning or on a bundled package with no licence text, and writes `dist/` only after a full success. Licence texts for packages that ship none live in `licence-texts.mjs`.

### Changed

- The usage message lists `diff [--base-ref <rev>]`, `baseline [--allow-growth] [--output-dir <dir>]` and the `--config` flag.
- The `diff` pass note names the base file as `<rev>:crap/<file>` when the base comes from a revision.
