# Changelog

All notable changes are recorded here, in the Keep a Changelog style. Each release states its score impact.

## [Unreleased]

Score impact: neutral

### Added

- Initial extraction of the TypeScript CRAP ratchet gate, with its tests and synthetic fixtures. Sources, messages, exit codes and the threshold are unchanged.
- Repository docs, pull request template, Dependabot configuration and CI (type-check and tests).
- `crap/config.json`: optional configuration with `scope`, `anchors`, `extensions`, `exclude`, `coverage` and `threshold`. Unknown keys, wrong types and empty lists fail with exit 1. With no file, or a file of defaults, every output is unchanged.
