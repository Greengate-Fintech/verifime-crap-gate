export const add = (a: number) => (b: number) => a + b

export const neverInner = (a: number) => (b: number) => a - b

export const tri = (a: number) => (b: number) => (c: number) => (a > b ? c : a)

export interface Action {
  type: string
}
export interface Store {
  log: string[]
}

export const logger =
  (store: Store) =>
  (next: (action: Action) => Action) =>
  (action: Action): Action => {
    store.log.push(action.type)
    return next(action)
  }
