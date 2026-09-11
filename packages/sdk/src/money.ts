import type { Money } from './types.js'

const formatters = new Map<string, Intl.NumberFormat>()

/**
 * Format minor units for display. Whole amounts drop the cents ($1,099), which
 * is how price tags read; partial amounts keep them ($1,099.50).
 */
export function formatMoney(money: Money, locale = 'en-US'): string {
  const currency = money.currency.toUpperCase()
  const whole = money.amount % 100 === 0
  const key = `${locale}|${currency}|${whole}`
  let fmt = formatters.get(key)
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2,
    })
    formatters.set(key, fmt)
  }
  return fmt.format(money.amount / 100)
}

export function money(amount: number, currency: string): Money {
  if (!Number.isInteger(amount)) {
    throw new Error(`Money amount must be integer minor units, got ${amount}`)
  }
  return { amount, currency }
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency.toUpperCase() !== b.currency.toUpperCase()) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency}`)
  }
  return { amount: a.amount + b.amount, currency: a.currency }
}

export function multiplyMoney(m: Money, qty: number): Money {
  return { amount: m.amount * qty, currency: m.currency }
}
