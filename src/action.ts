import { appendFileSync, statSync } from 'fs'
import path from 'path'
import { escapeProperty, runCli } from './cli'
import type { Io } from './cli'

// The GitHub Action entry. It reads the action inputs from the environment, runs the CLI in the
// working directory, and records the summary line and a short job summary. It carries no gate
// logic: the exit code and the messages are the CLI's. The bundle requires the CLI bundle at run
// time (see build.mjs), so ESLint and TypeScript are bundled once.

const MODES = ['measure', 'check', 'baseline', 'diff'] as const
export type Mode = (typeof MODES)[number]

export interface ActionInputs {
  mode: Mode
  config: string
  base: string
  outputDir: string
  workingDirectory: string
}

export type ParsedInputs = { inputs: ActionInputs } | { error: string }

type Env = Record<string, string | undefined>

const MODE_LIST = MODES.join(', ')

/** The runner exposes input `name` as `INPUT_<NAME>`: upper case, spaces to underscores, hyphens kept. */
const inputOf = (env: Env, name: string, fallback = ''): string =>
  (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim() || fallback

const isMode = (value: string): value is Mode => (MODES as readonly string[]).includes(value)

/** Reads and validates the inputs. An empty input takes its default. */
export const parseInputs = (env: Env): ParsedInputs => {
  const mode = inputOf(env, 'mode')
  if (mode === '') return { error: `Input "mode" is required: one of ${MODE_LIST}` }
  if (!isMode(mode)) return { error: `Invalid mode "${mode}": use one of ${MODE_LIST}` }
  return {
    inputs: {
      mode,
      config: inputOf(env, 'config', 'crap/config.json'),
      base: inputOf(env, 'base', 'HEAD^1'),
      outputDir: inputOf(env, 'output-dir'),
      workingDirectory: inputOf(env, 'working-directory', '.'),
    },
  }
}

/** The CLI arguments for the inputs. `base` is for `diff` only and `output-dir` for `baseline` only. */
export const toArgv = (inputs: ActionInputs): string[] => {
  const argv: string[] = [inputs.mode, '--config', inputs.config]
  if (inputs.mode === 'diff') argv.push('--base-ref', inputs.base)
  if (inputs.mode === 'baseline' && inputs.outputDir !== '') argv.push('--output-dir', inputs.outputDir)
  return argv
}

export interface ActionResult {
  code: number
  /**
   * With exit code 0, the last standard output line; with any other code, the last standard error
   * line that is not a `::` annotation. Each falls back to the other stream when it has no line.
   */
  summary: string
}

const isAnnotation = (line: string): boolean => line.startsWith('::')

/** Why `dir` cannot be the working directory, or null when it can. `shown` is the input as given. */
const workingDirectoryProblem = (dir: string, shown: string): string | null => {
  try {
    return statSync(dir).isDirectory() ? null : `Working directory is not a directory: ${shown}`
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unknown error'
    return code === 'ENOENT' ? `Working directory not found: ${shown}` : `Cannot use working directory ${shown} (${code})`
  }
}

/**
 * The job summary lists at most this many failure lines. A failure with hundreds of lines would
 * bury the result, and GitHub caps a step summary in size; the job log keeps every line.
 */
export const MAX_SUMMARY_PROBLEMS = 50

const longestRun = (texts: readonly string[], char: string): number =>
  Math.max(0, ...texts.flatMap((t) => [...t.matchAll(new RegExp(`${char}+`, 'g'))].map((m) => m[0].length)))

/** An inline code span that survives backticks in the text. */
const inlineCode = (text: string): string => {
  if (!text.includes('`')) return `\`${text}\``
  const ticks = '`'.repeat(longestRun([text], '`') + 1)
  return `${ticks} ${text} ${ticks}`
}

/** The Markdown job summary: mode, result, the summary line and, on failure, the CLI's messages. */
export const jobSummary = (mode: string, result: ActionResult, errors: readonly string[]): string => {
  const head = `### CRAP gate: ${mode}\n\nResult: ${result.code === 0 ? 'pass' : 'fail'}\n\n${inlineCode(result.summary)}\n`
  // Annotation lines repeat a message in workflow-command form, so they stay out of the summary.
  const all = errors.filter((line) => !isAnnotation(line))
  const shown = all.slice(0, MAX_SUMMARY_PROBLEMS)
  if (shown.length === 0) return head
  const fence = '`'.repeat(Math.max(3, longestRun(shown, '`') + 1))
  const more = all.length > shown.length ? `\n(${all.length - shown.length} more lines are in the job log)\n` : ''
  return `${head}\n${fence}\n${shown.join('\n')}\n${fence}\n${more}`
}

const singleLine = (text: string): string => text.replace(/[\r\n]+/g, ' ')

const appendTo = (file: string, name: string, text: string): void => {
  try {
    appendFileSync(file, text)
  } catch (cause) {
    throw new Error(`Cannot write ${name} (${file}): ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

/** Appends to the runner's output and summary files, when it set them. A write failure names the file. */
const record = (env: Env, mode: string, result: ActionResult, errors: readonly string[]): void => {
  if (env.GITHUB_OUTPUT) appendTo(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT', `summary=${singleLine(result.summary)}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendTo(env.GITHUB_STEP_SUMMARY, 'GITHUB_STEP_SUMMARY', jobSummary(mode, result, errors))
}

interface Capture {
  io: Io
  lines: () => { logs: string[]; errors: string[] }
}

/** Forwards every line to `io` (an error line through `forward`), and keeps the lines as the CLI wrote them. */
const capture = (io: Io, forward: (line: string) => string): Capture => {
  const logs: string[] = []
  const errors: string[] = []
  return {
    io: {
      log: (s) => {
        logs.push(s)
        io.log(s)
      },
      error: (s) => {
        errors.push(s)
        io.error(forward(s))
      },
    },
    lines: () => ({ logs, errors }),
  }
}

const lastError = (errors: readonly string[]): string | undefined => errors.filter((line) => !isAnnotation(line)).at(-1)

const summaryOf = (code: number, logs: readonly string[], errors: readonly string[]): string =>
  (code === 0 ? (logs.at(-1) ?? lastError(errors)) : (lastError(errors) ?? logs.at(-1))) ?? ''

/**
 * The working directory as GitHub resolves an annotation path: relative to the workspace, with
 * forward slashes. Empty for the workspace itself and for a directory outside it.
 */
const annotationPrefix = (workspace: string, workDir: string): string => {
  const rel = path.relative(path.resolve(workspace), workDir)
  return rel === '' || rel.startsWith('..') || path.isAbsolute(rel) ? '' : `${rel.split(path.sep).join('/')}/`
}

/** The CLI names an annotation file from the working directory; GitHub reads it from the workspace root. */
const prefixAnnotation = (prefix: string): ((line: string) => string) => {
  const escaped = escapeProperty(prefix)
  return (line) => (prefix === '' ? line : line.replace(/^(::error file=)/, `$1${escaped}`))
}

const ignoredInputs = (env: Env, inputs: ActionInputs): string[] => {
  const ignored: string[] = []
  if (inputs.mode !== 'baseline' && inputs.outputDir !== '') ignored.push(`output-dir (it applies to mode baseline, not ${inputs.mode})`)
  if (inputs.mode !== 'diff' && inputOf(env, 'base') !== '') ignored.push(`base (it applies to mode diff, not ${inputs.mode})`)
  return ignored
}

/** Runs the CLI with the process working directory set to `cwd`, and restores it afterwards. */
const runIn = async (cwd: string, argv: string[], env: Env, io: Io): Promise<number> => {
  const original = process.cwd()
  process.chdir(cwd)
  try {
    return await runCli(argv, env, cwd, io)
  } finally {
    process.chdir(original)
  }
}

const failed = (error: string, io: Io): number => {
  io.error(error)
  return 1
}

const execute = async (inputs: ActionInputs, env: Env, cwd: string, io: Io): Promise<number> => {
  const workDir = path.resolve(cwd, inputs.workingDirectory)
  const problem = workingDirectoryProblem(workDir, inputs.workingDirectory)
  if (problem !== null) return failed(problem, io)
  return runIn(workDir, toArgv(inputs), env, io)
}

/**
 * Runs the action for the inputs in `env`. `cwd` is the directory a relative `working-directory`
 * resolves against (the workspace). Exit code and messages are the CLI's for the same mode.
 */
export const runAction = async (env: Env, cwd: string, io: Io): Promise<ActionResult> => {
  const parsed = parseInputs(env)
  const prefix = 'error' in parsed ? '' : annotationPrefix(cwd, path.resolve(cwd, parsed.inputs.workingDirectory))
  const seen = capture(io, prefixAnnotation(prefix))
  if ('inputs' in parsed) ignoredInputs(env, parsed.inputs).forEach((what) => io.log(`::warning::Input ${what} is ignored`))
  const code = 'error' in parsed ? failed(parsed.error, seen.io) : await execute(parsed.inputs, env, cwd, seen.io)
  const { logs, errors } = seen.lines()
  const result = { code, summary: summaryOf(code, logs, errors) }
  record(env, 'inputs' in parsed ? parsed.inputs.mode : 'unknown', result, errors)
  return result
}

if (require.main === module) {
  runAction(process.env, process.cwd(), console)
    .then(({ code }) => {
      process.exitCode = code
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exitCode = 1
    })
}
