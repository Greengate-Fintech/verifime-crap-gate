export function retryDelay(attempt: number): number {
  if (attempt > 5) return 30_000
  return 1_000 * 2 ** attempt
}

export function describeLevel(n: number): string {
  if (n > 0) {
    if (n > 10) return 'high'
  }
  if (n < -5) return 'low'
  return 'mid'
}

export function listOrEmpty(xs?: string[]): string[] {
  return xs ?? []
}

export function countOrEmpty(xs?: string[]): number {
  const items = xs ?? []
  return items.length
}

export function fallbackLabel(label?: string): string {
  return label || 'none'
}

export function signOf(n: number): string {
  return n >= 0 ? 'positive' : 'negative'
}

export function guardedConstructorLike(a: number, b?: number, c?: number): number {
  let total = a
  if (b !== undefined) total += b
  if (c !== undefined) total += c
  if (a < 0) throw new Error('negative')
  return total
}
