import { expect, it } from 'vitest'
import { add, neverInner } from '../src/curried'

it('calls curried arrows', () => {
  expect(add(1)(2)).toBe(3)
  expect(typeof neverInner(1)).toBe('function')
})
