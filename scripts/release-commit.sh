#!/usr/bin/env bash
# Commits the built dist/ on a detached release commit whose parent is the checked-out commit,
# and tags it locally. Inputs (env): VERSION, TAG. Nothing is pushed.
set -euo pipefail

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
parent="$(git rev-parse HEAD)"
git checkout --detach
git add -f dist/
git commit -m "release: v$VERSION"
git tag -a "$TAG" -m "v$VERSION"
test "$(git rev-parse "$TAG^{commit}")" = "$(git rev-parse HEAD)"
test "$(git rev-parse HEAD^)" = "$parent"
# The release commit adds dist/ and changes nothing else.
others="$(git diff --name-only HEAD^ HEAD | grep -v '^dist/' || true)"
test -z "$others" || { echo "Release commit changes files outside dist/: $others"; exit 1; }
git ls-tree --name-only HEAD dist/ | grep -Fx dist/cli.cjs
git ls-tree --name-only HEAD dist/ | grep -Fx dist/action.cjs
