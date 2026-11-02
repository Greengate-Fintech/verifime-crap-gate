import { statSync } from 'fs'
import path from 'path'
import type { CrapConfig } from './config'

// The scope check both measures share: a `scope` the consumer set must name existing directories.

export const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** A scope the consumer set must exist: a typo must not shrink the measure silently. */
export const assertScopeExists = (repoRoot: string, config: CrapConfig): void => {
  if (config.scopeFrom === undefined) return
  const missing = config.scope.find((dir) => !isDirectory(path.join(repoRoot, dir)))
  if (missing !== undefined) {
    throw new Error(`Invalid ${config.scopeFrom}: key "scope" entry ${JSON.stringify(missing)} is not an existing directory`)
  }
}
