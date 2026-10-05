import { expect, it } from 'vitest'
import { doubled, filtered, registerHandler, tail } from '../src/callbacks'

it('runs some callbacks and leaves others', () => {
  expect(doubled([1, 2])).toEqual([2, 4])
  expect(filtered([1])).toEqual([1])
  registerHandler(() => undefined)
  expect(tail(1)).toBe(2)
})
