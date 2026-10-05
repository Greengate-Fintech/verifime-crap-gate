export abstract class Shape {
  abstract area(): number

  describe(): string {
    return `area ${this.area()}`
  }
}

export class Square extends Shape {
  constructor(private side: number) {
    super()
  }

  area(): number {
    return this.side * this.side
  }
}

export function parse(input: string): number
export function parse(input: number): string
export function parse(input: string | number): number | string {
  return typeof input === 'string' ? Number(input) : String(input)
}

export const helpers = {
  add(a: number, b: number): number {
    return a + b
  },
  sub(a: number, b: number): number {
    return a - b
  },
  mul: (a: number, b: number): number => a * b,
}

export const config = (() => {
  return { ready: true }
})()

export async function loadValue(): Promise<number> {
  return 7
}

export function* counter(limit: number): Generator<number> {
  for (let i = 0; i < limit; i++) yield i
}

export async function* asyncCounter(): AsyncGenerator<number> {
  yield 1
}

export function level1(n: number): number {
  function level2(m: number): number {
    const level3 = (k: number): number => k + 1
    return level3(m) * 2
  }
  return level2(n)
}

export function deepUncalled(): number {
  function inner(): number {
    const innermost = (): number => 1
    return innermost()
  }
  return inner()
}
