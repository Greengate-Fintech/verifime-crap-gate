import { execFileSync } from 'child_process'

// Reads a file as committed at a revision. The diff mode compares the head's files with the base's.

const MAX_BYTES = 64 * 1024 * 1024

const git = (cwd: string, args: string[]): string => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (cause) {
    const stderr = (cause as { stderr?: string }).stderr?.trim()
    const detail = stderr || (cause instanceof Error ? cause.message : String(cause))
    throw new Error(`git ${args[0]} failed: ${detail}`, { cause })
  }
}

/** The commit a revision names. `--end-of-options` stops a revision from being read as an option. */
const resolveCommit = (cwd: string, rev: string): string => {
  try {
    return git(cwd, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).trim()
  } catch (cause) {
    throw new Error(
      `Cannot resolve base revision ${rev}: ${cause instanceof Error ? cause.message : String(cause)} (if the checkout is shallow, use fetch-depth: 2 so that HEAD^1 exists)`,
      { cause },
    )
  }
}

/**
 * The text of `relPath` at `rev`, or null when the revision has no such path. `relPath` is
 * relative to `repoRoot`, which may be a subdirectory of the git root. The two outcomes are
 * told apart by listing the tree first, so a git failure is never read as "absent".
 */
export const readBaseFile = (repoRoot: string, rev: string, relPath: string): string | null => {
  const commit = resolveCommit(repoRoot, rev)
  const listed = git(repoRoot, ['ls-tree', '--name-only', commit, '--', relPath])
  if (listed.trim() === '') return null
  // `./` makes the path relative to the working directory, as the `ls-tree` pathspec is, so a
  // nested package (a subdirectory of the git root) reads the right file.
  return git(repoRoot, ['show', `${commit}:./${relPath}`])
}
