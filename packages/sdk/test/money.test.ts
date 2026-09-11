import { describe, expect, it } from 'vitest'
import { addMoney, formatMoney, money, multiplyMoney } from '../src/money.js'

describe('money', () => {
  it('drops cents on whole amounts and keeps them otherwise', () => {
    expect(formatMoney({ amount: 109900, currency: 'usd' })).toBe('$1,099')
    expect(formatMoney({ amount: 109950, currency: 'USD' })).toBe('$1,099.50')
    expect(formatMoney({ amount: 0, currency: 'usd' })).toBe('$0')
  })

  it('refuses float minor units', () => {
    expect(() => money(10.5, 'usd')).toThrow(/integer minor units/)
  })

  it('adds and multiplies without touching floats', () => {
    expect(addMoney(money(100, 'usd'), money(250, 'usd'))).toEqual({ amount: 350, currency: 'usd' })
    expect(multiplyMoney(money(109900, 'usd'), 3).amount).toBe(329700)
    expect(() => addMoney(money(1, 'usd'), money(1, 'eur'))).toThrow(/Cannot add/)
  })
})
