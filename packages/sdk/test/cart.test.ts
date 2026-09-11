import { describe, expect, it } from 'vitest'
import { addLine, cartCount, cartSubtotal, cartToCheckoutItems, emptyCart, parseCart, removeLine, serializeCart, setQuantity, MAX_CART_LINES } from '../src/cart.js'

const tacoma = { sku: 'VDCTOYTAC9504', name: 'Tacoma kit', unitPrice: { amount: 109900, currency: 'usd' }, url: '/p/tacoma/' }
const supra = { sku: 'VDCTOYSUP9302', name: 'Supra kit', unitPrice: { amount: 119900, currency: 'usd' } }

describe('cart', () => {
  it('adds, merges the same sku, clamps to maxQuantity', () => {
    let c = addLine(emptyCart(), tacoma, 1, 10)
    c = addLine(c, tacoma, 999, 10)
    expect(c.lines).toHaveLength(1)
    expect(c.lines[0]!.quantity).toBe(10)
    c = addLine(c, supra, -3, 10)
    expect(c.lines[1]!.quantity).toBe(1)
  })

  it('sets quantity and removes at zero', () => {
    let c = addLine(emptyCart(), tacoma, 2, 10)
    c = setQuantity(c, tacoma.sku, 5, 10)
    expect(c.lines[0]!.quantity).toBe(5)
    c = setQuantity(c, tacoma.sku, 0, 10)
    expect(c.lines).toHaveLength(0)
  })

  it('counts and totals from the snapshot', () => {
    let c = addLine(emptyCart(), tacoma, 2, 10)
    c = addLine(c, supra, 1, 10)
    expect(cartCount(c)).toBe(3)
    expect(cartSubtotal(c, 'usd')).toEqual({ amount: 109900 * 2 + 119900, currency: 'usd' })
    expect(cartToCheckoutItems(c)).toEqual([{ sku: tacoma.sku, quantity: 2 }, { sku: supra.sku, quantity: 1 }])
  })

  it('round-trips through JSON and survives garbage', () => {
    const c = addLine(addLine(emptyCart(), tacoma, 1, 10), supra, 2, 10)
    expect(parseCart(serializeCart(c)).lines).toEqual(c.lines)
    expect(parseCart('not json').lines).toEqual([])
    expect(parseCart(JSON.stringify({ lines: [{ sku: 'X', name: 'x', quantity: 1.5, unitPrice: { amount: 10, currency: 'usd' } }] })).lines).toEqual([])
    expect(parseCart(JSON.stringify({ lines: [{ sku: 'X', name: 'x', quantity: 1, unitPrice: { amount: 10.5, currency: 'usd' } }] })).lines).toEqual([])
    expect(parseCart(JSON.stringify({ lines: [{ sku: 'X', name: 'x', quantity: 1, unitPrice: { amount: 10, currency: 'usd' } }] })).lines).toHaveLength(1)
  })

  it('caps the number of lines', () => {
    let c = emptyCart()
    for (let i = 0; i < MAX_CART_LINES; i++) c = addLine(c, { ...supra, sku: `S${i}` }, 1, 10)
    expect(() => addLine(c, tacoma, 1, 10)).toThrow(/limited/)
    expect(removeLine(c, 'S0').lines).toHaveLength(MAX_CART_LINES - 1)
  })
})
