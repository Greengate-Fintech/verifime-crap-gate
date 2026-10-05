import { expect, it } from 'vitest'
import { add, logger, neverInner, tri } from '../src/curried'

it('calls curried arrows', () => {
  expect(add(1)(2)).toBe(3)
  expect(typeof neverInner(1)).toBe('function')
  expect(tri(2)(1)(5)).toBe(5)
  const store = { log: [] as string[] }
  expect(logger(store)((a) => a)({ type: 'go' })).toEqual({ type: 'go' })
  expect(store.log).toEqual(['go'])
})
