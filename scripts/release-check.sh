#!/usr/bin/env bash
# Resolves the version and tag, checks a release is allowed, and writes the release notes.
# Inputs (env): DRY_RUN (true or false), INPUT_VERSION (release only), RUNNER_TEMP, GITHUB_ENV.
# Outputs: VERSION and TAG in GITHUB_ENV, and the CHANGELOG section in $RUNNER_TEMP/notes.md.
set -euo pipefail

package_version="$(node -p "require('./package.json').version")"
if [ "$DRY_RUN" = true ]; then
  version="$package_version"
  tag="dryrun/v$version"
else
  version="$INPUT_VERSION"
  tag="v$version"
fi

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version '$version' is not X.Y.Z"; exit 1; }

if [ "$DRY_RUN" != true ] && git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  echo "Tag $tag already exists. Tags are never moved."; exit 1
fi

test "$package_version" = "$version" || { echo "package.json is $package_version, not $version"; exit 1; }

# The notes are the CHANGELOG section for this version, up to the next section heading.
notes="$RUNNER_TEMP/notes.md"
awk -v v="$version" '
  index($0, "## [" v "] - ") == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found { print }
' CHANGELOG.md > "$notes"
heading="^## \[${version//./\\.}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}\$"
grep -Eq "$heading" CHANGELOG.md || { echo "CHANGELOG.md has no '## [$version] - YYYY-MM-DD' section"; exit 1; }
first_line="$(grep -m1 -v '^[[:space:]]*$' "$notes" || true)"
[[ $first_line == 'Score impact: '* ]] || { echo "The CHANGELOG section for $version must start with a 'Score impact: ' line"; exit 1; }

{ echo "VERSION=$version"; echo "TAG=$tag"; } >> "$GITHUB_ENV"
