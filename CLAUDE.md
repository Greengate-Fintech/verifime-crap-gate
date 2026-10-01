# Working in this repository

## Public repository (no internal detail)

- This repository is public. Tests use synthetic fixtures only.
- Put no internal repository names, account IDs, partner names, private paths, audit names or real consumer data in code, fixtures, docs, issues, commit messages or pull requests.
- Name only what a public reader needs. If unsure, leave it out.

## Release classification

- Every PR body and every release note states "Score impact: neutral" or "Score impact: changing".
- Every release has a CHANGELOG entry.
- Neutral means no consumer score, message, exit code or file format changes.

## Parity rule

- The file formats, messages, exit codes and the threshold of 8 change only in a release classified "Score impact: changing".
- A copied or refactored source file must keep its behaviour. Show the diff against the original in the PR body.

## Commits and pull requests

- Write the failing test first and paste its verbatim output into the PR body.
- Use merge commits. Never rebase, amend or force-push.
- Stage files by name.
- Use the PR template. Every PR passes CI before review.
