declare const client: {
  interceptors: { response: { use: (fn: (r: unknown) => unknown) => void } }
}
declare function register(...fns: Array<(n: number) => number>): number

export function namedFunction(a: number): number {
  if (a > 1) {
    return a
  }
  return 0
}

export class Widget {
  run(flag: boolean): string {
    return flag ? 'yes' : 'no'
  }
}

export const handler = async (event: unknown) => {
  return event
}

client.interceptors.response.use((response) => {
  if (response) {
    return response
  }
  return null
})

export const wrapped = new Promise((resolve) => {
  resolve(undefined)
})

export const both = register((x: number) => x + 1, (y: number) => (y > 0 ? y : -y))
