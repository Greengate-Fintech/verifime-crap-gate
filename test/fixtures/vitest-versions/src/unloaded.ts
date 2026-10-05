export const notImported = (xs: number[]): number[] => xs.map((x) => x + 1)

export class Idle {
  ready = false
  static {
    Idle.name.toString()
  }

  run(): boolean {
    return this.ready
  }
}
