import { expect, it } from 'vitest'
import { config, counter, helpers, level1, loadValue, parse, Square } from '../src/shapes'

it('uses part of the shapes module', async () => {
  expect(new Square(2).describe()).toBe('area 4')
  expect(parse('1')).toBe(1)
  expect(helpers.add(1, 2)).toBe(3)
  expect(helpers.mul(2, 3)).toBe(6)
  expect(config.ready).toBe(true)
  expect(await loadValue()).toBe(7)
  expect([...counter(2)]).toEqual([0, 1])
  expect(level1(1)).toBe(4)
})
