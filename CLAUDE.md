# Working in this repository

## Public repository (no internal detail)

- This repository is public. Tests use synthetic fixtures only.
- Put no internal repository names, account IDs, partner names, private paths, audit names or real consumer data in code, fixtures, docs, issues, commit messages or pull requests.
- Name only what a public reader needs. If unsure, leave it out.

## Release classification

- Every PR body and every release note states "Score impact: neutral" or "Score impact: changing".
- Every release has a CHANGELOG entry.
- "Score impact" classifies scores only. Neutral means no consumer's baseline or unmatched rows change. Changing means any of them can.

## Parity rule

- The file formats, the threshold of 8, and the existing messages and exit codes stay identical, in a neutral release and in a changing one, unless a decision records the change.
- New command-line surface text (a new usage line, a new error for a condition that had none) is allowed. List every such change, and any change to an existing message, in the PR body.
- A copied or refactored source file must keep its behaviour. Show the diff against the original in the PR body.

## Commits and pull requests

- Write the failing test first and paste its verbatim output into the PR body.
- Use merge commits. Never rebase, amend or force-push.
- Stage files by name.
- Use the PR template. Every PR passes CI before review.
