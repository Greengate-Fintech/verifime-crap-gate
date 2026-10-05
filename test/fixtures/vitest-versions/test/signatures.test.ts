import { expect, it } from 'vitest'
import { configure, withDefault, withUnusedDefault } from '../src/signatures'

it('calls the long signature and the default-parameter arrows', () => {
  const s = { alpha: 1, bravo: 1, charlie: 1, delta: 1, echo: 1, foxtrot: 1, golf: 1, hotel: 1, india: 1, juliet: 1, kilo: 1 }
  expect(configure(s)).toBe(11)
  expect(withDefault(2)).toBe(20)
  expect(withUnusedDefault(2, (v) => v)).toBe(2)
})
