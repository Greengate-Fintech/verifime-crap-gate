import { appendFileSync, statSync } from 'fs'
import path from 'path'
import { runCli } from './cli'
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
  /** The last line the run wrote to standard output, else the last it wrote to standard error. */
  summary: string
}

const isDirectory = (dir: string): boolean => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const MAX_SUMMARY_PROBLEMS = 50

/** The Markdown job summary: mode, result, the summary line and, on failure, the CLI's messages. */
const jobSummary = (mode: string, result: ActionResult, errors: readonly string[]): string => {
  const head = `### CRAP gate: ${mode}\n\nResult: ${result.code === 0 ? 'pass' : 'fail'}\n\n\`${result.summary}\`\n`
  // Annotation lines repeat a message in workflow-command form, so they stay out of the summary.
  const problems = errors.filter((line) => !line.startsWith('::')).slice(0, MAX_SUMMARY_PROBLEMS)
  return problems.length === 0 ? head : `${head}\n\`\`\`\n${problems.join('\n')}\n\`\`\`\n`
}

const singleLine = (text: string): string => text.replace(/[\r\n]+/g, ' ')

/** Appends to the runner's output and summary files, when it set them. */
const record = (env: Env, mode: string, result: ActionResult, errors: readonly string[]): void => {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `summary=${singleLine(result.summary)}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, jobSummary(mode, result, errors))
}

interface Capture {
  io: Io
  lines: () => { logs: string[]; errors: string[] }
}

/** Forwards every line to `io`, and keeps them. */
const capture = (io: Io): Capture => {
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
        io.error(s)
      },
    },
    lines: () => ({ logs, errors }),
  }
}

const summaryOf = (logs: readonly string[], errors: readonly string[]): string =>
  logs.at(-1) ?? errors.filter((line) => !line.startsWith('::')).at(-1) ?? ''

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

const execute = async (inputs: ActionInputs, env: Env, cwd: string, io: Io): Promise<number> => {
  const workDir = path.resolve(cwd, inputs.workingDirectory)
  if (!isDirectory(workDir)) {
    io.error(`Working directory not found: ${inputs.workingDirectory}`)
    return 1
  }
  return runIn(workDir, toArgv(inputs), env, io)
}

const failed = (error: string, io: Io): number => {
  io.error(error)
  return 1
}

/**
 * Runs the action for the inputs in `env`. `cwd` is the directory a relative `working-directory`
 * resolves against (the workspace). Exit code and messages are the CLI's for the same mode.
 */
export const runAction = async (env: Env, cwd: string, io: Io): Promise<ActionResult> => {
  const seen = capture(io)
  const parsed = parseInputs(env)
  const code = 'error' in parsed ? failed(parsed.error, seen.io) : await execute(parsed.inputs, env, cwd, seen.io)
  const { logs, errors } = seen.lines()
  const result = { code, summary: summaryOf(logs, errors) }
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
