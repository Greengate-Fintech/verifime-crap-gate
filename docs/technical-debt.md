# Technical Debt

This register records known costs that were accepted on purpose. Each entry states the gap, why it is safe to defer, and what would need to change to pick it up.

---

## Every toolchain bump adds about 2 MB to git history

**Gap:** `dist/cli.cjs` bundles ESLint, typescript-eslint and TypeScript, so the action and the CLI never resolve anything from a consumer's `node_modules`. Measured on 2 October 2026 at commit 4721d53, the file is 10,521,707 bytes raw and 2,112,740 bytes with `gzip -9`. Git stores objects zlib-compressed, so each rebuild of `dist/cli.cjs` after a bump of any of the three packages adds roughly the compressed size to the repository history, less whatever git delta compression saves (not measured). Dependabot bumps of those packages are the usual trigger, because CLAUDE.md requires `dist/` to be rebuilt and committed with every dependency bump.

**Why safe to defer:** The cost falls on people who clone this repository, not on consumers. A workflow that uses the action at a tag or SHA gets a snapshot of that ref, not the history. We expect toolchain bumps a few times a year. The design choice that causes the cost is deliberate: one self-contained JavaScript action that runs on Linux, macOS and Windows runners and on arm64, plus the same file run locally with `npx`.

**Options considered:**

- a. Keep as is.
- b. Commit `dist/` only on release commits. A release workflow builds `dist/`, commits it on a release commit and tags that commit, so `main` holds no bundle and history grows once per release, not once per bump. Consumers still pin an exact tag and `npx` still works. This costs one release workflow, and the check that the committed bundle equals a clean build moves to release time.
- c. Docker container action, with the toolchain in an image on a container registry, pinned by digest. This removes the bundle from git. The costs:
  - Container actions run on Linux runners only.
  - Developers need Docker to run the CLI locally.
  - It needs a multi-architecture image build and its own release pipeline.
  - Inside the container, git needs `safe.directory` for a bind-mounted repository, and written files may be owned by root unless the container runs as the caller's user.
  - Coverage files hold absolute host paths that differ from the container path. The anchor-suffix join probably tolerates this, but nobody has proven it.

Option b is the cheapest change that removes the per-bump cost without changing how consumers use the gate.

**Prerequisite to fix:** A decision to change how `dist/` is published (option b or c). For option c, also a trial that proves the coverage join across the container path, and confirmation that every developer machine runs Docker.
