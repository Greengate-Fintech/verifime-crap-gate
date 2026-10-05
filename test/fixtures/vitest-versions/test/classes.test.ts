import { expect, it } from 'vitest'
import { Account } from '../src/classes'

it('uses part of the class', () => {
  const a = new Account(1)
  expect(a.onChange(1)).toBe(2)
  expect(a.doubled).toBe(2)
  expect(a.deposit(1)).toBe(2)
  expect(a.deposit(0)).toBe(2)
  expect(a.deposit(-1)).toBe(3)
})
