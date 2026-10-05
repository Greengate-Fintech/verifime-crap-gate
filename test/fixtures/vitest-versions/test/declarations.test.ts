import { expect, it } from 'vitest'
import { Colour, Outer, pick, Units } from '../src/declarations'

it('uses enums and namespaces', () => {
  expect(pick(Colour.Red)).toBe(2)
  expect(Units.scale(2)).toBe(20)
  expect(Outer.Inner.depth).toBe(2)
})
