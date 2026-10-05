export enum Colour {
  Red = 'red',
  Green = 'green',
}

enum Size {
  Small,
  Large,
}

export namespace Units {
  export const base = 10
  export function scale(n: number): number {
    return n * base
  }
}

namespace Local {
  export const twice = (n: number): number => n * 2
}

export namespace Outer.Inner {
  export const depth = 2
}

export namespace Shell {
  export namespace Core {
    export function size(): Size {
      return Size.Large
    }
  }
}

export const pick = (c: Colour): number => (c === Colour.Red ? Local.twice(1) : Shell.Core.size())
