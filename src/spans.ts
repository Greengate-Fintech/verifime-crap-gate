import type { AST, Rule, SourceCode } from 'eslint'
import { builtinRules } from 'eslint/use-at-your-own-risk'
import type { FunctionSpan, SourcePoint, SpanOrigin } from './types'

// A companion to ESLint's `complexity` rule that records, for every function it reports, the
// positions the coverage join needs (see FunctionSpan). It runs the built-in rule itself with a
// context whose `report` is intercepted, so each span carries exactly the position and text of
// the complexity message it belongs to, and it reports nothing of its own.
//
// It reads the rule from `eslint/use-at-your-own-risk`, which ESLint may change in any release,
// and it relies on `complexity` reporting with `node`, `loc`, `messageId` and `data`. A test pins
// the bundled ESLint version (test/spans.test.ts). If a change breaks the pairing, every
// complexity message becomes a measure problem: it fails closed.

type Loc = { line: number; column: number }

interface AstNode {
  type: string
  loc: { start: Loc; end: Loc }
  parent?: AstNode
  [key: string]: unknown
}

/** Fails at load, and so before any lint, if ESLint no longer has what the rule wraps. */
const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`ESLint has no ${what}: the function spans cannot be recorded`)
  return value
}

const complexityRule = required(builtinRules.get('complexity'), 'built-in complexity rule')

/** The text `complexity` reports, with `{{name}}`, `{{complexity}}` and `{{max}}` placeholders. */
const COMPLEX_MESSAGE = required(complexityRule.meta?.messages?.complex, '"complex" message in its complexity rule')

/** The parents whose range, modifiers and key belong to the function that is their value. */
const KEYED_PARENTS = new Set(['MethodDefinition', 'TSAbstractMethodDefinition', 'Property', 'PropertyDefinition', 'AccessorProperty'])

const EXPORTS = new Set(['ExportNamedDeclaration', 'ExportDefaultDeclaration'])

const ORIGINS: Readonly<Record<string, SpanOrigin>> = {
  'Class field initializer': 'field-initialiser',
  'Class static block': 'static-block',
}

const point = (p: Loc): SourcePoint => [p.line, p.column]

// Every node the rule reports, and every declaration above one, has a parent: the Program at least.
const parentOf = (node: AstNode): AstNode => node.parent as AstNode

const exportWrapped = (node: AstNode): AstNode => {
  const parent = parentOf(node)
  return EXPORTS.has(parent.type) && parent.declaration === node ? parent : node
}

/** The variable statement of `const f = () => ...`; the declarator alone when it declares several. */
const variableDecl = (declarator: AstNode): AstNode => {
  const statement = parentOf(declarator)
  return (statement.declarations as unknown[]).length === 1 ? exportWrapped(statement) : declarator
}

/** The node whose start is the function's declaration start (FunctionSpan.declStart). */
const functionDecl = (node: AstNode): AstNode => {
  const parent = parentOf(node)
  if (KEYED_PARENTS.has(parent.type) && parent.value === node) return parent
  if (parent.type === 'VariableDeclarator' && parent.init === node) return variableDecl(parent)
  return exportWrapped(node)
}

const declOf = (node: AstNode, origin: SpanOrigin): AstNode => {
  if (origin === 'static-block') return node
  // A field initialiser is reported on the value; its declaration is the field.
  return origin === 'field-initialiser' ? parentOf(node) : functionDecl(node)
}

const keyOf = (decl: AstNode): AstNode | null => (KEYED_PARENTS.has(decl.type) ? (decl.key as AstNode) : null)

const bodyOf = (node: AstNode, origin: SpanOrigin): AstNode | null => {
  if (origin === 'field-initialiser') return null
  // A static block's body is its list of statements, possibly none.
  return Array.isArray(node.body) ? ((node.body[0] as AstNode | undefined) ?? null) : (node.body as AstNode)
}

/**
 * The first token of a body after any opening parentheses. In `(e) => (e as Error).message` the
 * body node starts at the `(`, but a converter that drops parentheses starts the entry at `e`.
 */
const unparenthesisedStart = (body: AstNode, sourceCode: SourceCode): Loc => {
  let token = sourceCode.getFirstToken(body as unknown as Rule.Node) as AST.Token
  while (token.value === '(') token = sourceCode.getTokenAfter(token) as AST.Token
  return token.loc.start
}

const anchorsOf = (node: AstNode, decl: AstNode, head: Loc, body: AstNode | null, sourceCode: SourceCode): SourcePoint[] => {
  const key = keyOf(decl)
  const fromKey = key ? [key.loc.start] : []
  const fromBody = body ? [body.loc.start, unparenthesisedStart(body, sourceCode)] : []
  return [decl.loc.start, ...fromKey, node.loc.start, head, ...fromBody].map(point)
}

/** ESLint's own message interpolation: `{{ key }}` is replaced when `data` has the key. */
const interpolate = (text: string, data: Record<string, unknown>): string =>
  text.replace(/\{\{([^{}]+)\}\}/gu, (whole, term: string) => (term.trim() in data ? String(data[term.trim()]) : whole))

/** The reported position: a location's start, or the position itself. */
const reportedAt = (descriptor: Rule.ReportDescriptor): Loc => {
  const loc = (descriptor as { loc: Loc | { start: Loc } }).loc
  return 'start' in loc ? loc.start : loc
}

const spanOf = (descriptor: Rule.ReportDescriptor, node: AstNode, sourceCode: SourceCode): FunctionSpan => {
  const data = (descriptor.data ?? {}) as Record<string, unknown>
  const origin = ORIGINS[String(data.name)] ?? 'function'
  const head = reportedAt(descriptor)
  const decl = declOf(node, origin)
  const body = bodyOf(node, origin)
  return {
    line: head.line,
    column: head.column + 1,
    message: interpolate(COMPLEX_MESSAGE, data),
    origin,
    start: point(node.loc.start),
    end: point(node.loc.end),
    declStart: point(decl.loc.start),
    bodyStart: body ? point(body.loc.start) : null,
    anchors: anchorsOf(node, decl, head, body, sourceCode),
  }
}

/**
 * The companion rule. It takes the same options as `complexity` and passes every span it records
 * to `record`, with the file name ESLint lints the file under.
 */
export const makeSpanRule = (record: (filename: string, span: FunctionSpan) => void): Rule.RuleModule => ({
  meta: complexityRule.meta,
  create(context) {
    const report = (descriptor: Rule.ReportDescriptor): void => {
      const node = (descriptor as { node?: unknown }).node as AstNode | undefined
      if (node) record(context.filename, spanOf(descriptor, node, context.sourceCode))
    }
    return complexityRule.create(Object.create(context, { report: { value: report } }) as Rule.RuleContext)
  },
})
