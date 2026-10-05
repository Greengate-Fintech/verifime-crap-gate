import { expect, it } from 'vitest'
import {
  countOrEmpty,
  describeLevel,
  fallbackLabel,
  guardedConstructorLike,
  listOrEmpty,
  retryDelay,
  signOf,
} from '../src/guards'

it('runs each function down its default path only', () => {
  expect(retryDelay(1)).toBe(2000)
  expect(describeLevel(-1)).toBe('mid')
  expect(listOrEmpty()).toEqual([])
  expect(countOrEmpty()).toBe(0)
  expect(fallbackLabel('x')).toBe('x')
  expect(signOf(1)).toBe('positive')
  expect(guardedConstructorLike(1)).toBe(1)
})
