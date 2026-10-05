export const doubled = (xs: number[]): number[] => xs.map((x) => x * 2)

export const filtered = (xs: number[]): number[] => {
  if (xs.length > 100) {
    return xs.filter((x) => x > 0)
  }
  return xs
}

export const neverCalledOuter = (xs: number[]): number => {
  return xs.reduce((acc, x) => acc + x, 0)
}

export function registerHandler(register: (cb: () => string) => void): void {
  register(() => 'registered')
}

export const tail = (n: number): number => n + 1
