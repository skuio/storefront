import { describe, expect, it } from 'vitest'
import { defineStorefront, flatRate, freeShipping } from '../src'
import { applyPaymentEvents } from '../src/payments'
import { bitcoinPayments, deriveAddress } from '../src/payments/bitcoin'
import { placeOrder, rig, seed } from './helpers'

// BIP84 test vector (mnemonic "abandon … about", account 0).
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs'
const A0 = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'
const A1 = 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g'

const config = defineStorefront({
  name: 'Test Store',
  url: 'https://store.test',
  currency: 'usd',
  shipping: [freeShipping('us', 'Free shipping', { countries: ['US'] }), flatRate('intl', 'International', { amount: 4000, currency: 'usd' })],
  shipToCountries: ['US', 'CA'],
})

function explorer() {
  const state = { price: 100_000, tip: 900_000, txs: {} as Record<string, unknown[]>, calls: 0 }
  const fake = (async (input: RequestInfo | URL) => {
    state.calls++
    const url = String(input)
    const json = (b: unknown) => new Response(typeof b === 'number' ? String(b) : JSON.stringify(b))
    if (url.endsWith('/v1/prices')) return json({ time: 1, USD: state.price })
    if (url.endsWith('/blocks/tip/height')) return json(state.tip)
    const m = url.match(/\/address\/([^/]+)\/txs$/)
    if (m) return json(state.txs[m[1]!] ?? [])
    return new Response('nope', { status: 404 })
  }) as typeof globalThis.fetch
  return { state, fetch: fake }
}

const pay = (address: string, sats: number, height?: number) => ({
  txid: `tx-${address.slice(-6)}-${sats}`,
  status: height ? { confirmed: true, block_height: height } : { confirmed: false },
  vout: [{ scriptpubkey_address: address, value: sats }, { scriptpubkey_address: 'bc1qchange', value: 5000 }],
})

describe('bitcoin on-chain adapter', () => {
  it('derives the BIP84 test-vector addresses from a zpub, and refuses a private key', () => {
    expect(deriveAddress(ZPUB, 0)).toBe(A0)
    expect(deriveAddress(ZPUB, 1)).toBe(A1)
    expect(() => bitcoinPayments({ xpub: 'zprvAWgYBBk7JR8Gj…' })).toThrow(/PRIVATE/)
  })

  it('quotes a fresh address at the live price, then marks the order paid after a confirmation', async () => {
    const { store } = rig({}, config)
    await seed(store)
    const ctx = { store, siteUrl: 'https://store.test' }
    const { state, fetch } = explorer()
    const btc = bitcoinPayments({ xpub: ZPUB, fetch })

    const order = await placeOrder(store) // 1099.00 USD
    const start = await btc.start(order, ctx)
    expect(start).toEqual({ kind: 'redirect', url: `https://store.test/checkout/bitcoin/?order=${order.id}&key=${order.accessKey}` })
    const q = await btc.quote(order, ctx)
    expect(q).toMatchObject({ address: A0, amountSats: 1_099_000, amountBtc: '0.01099000', status: 'awaiting' })
    expect(q.uri).toBe(`bitcoin:${A0}?amount=0.01099000&label=${encodeURIComponent('Test Store 1001')}`)

    // A second order gets the next address.
    const other = await placeOrder(store)
    expect((await btc.quote(other, ctx)).address).toBe(A1)

    // Seen in the mempool: not paid yet.
    state.txs[A0] = [pay(A0, 1_099_000)]
    expect((await btc.quote(order, ctx)).status).toBe('seen')
    expect(await btc.sweep(ctx)).toEqual([])

    // One confirmation: the sweep pays it, with the txid as the reference.
    state.txs[A0] = [pay(A0, 1_099_000, 900_000)]
    const events = await btc.sweep(ctx)
    expect(events).toMatchObject([{ type: 'paid', orderId: order.id, provider: 'bitcoin', reference: `tx-${A0.slice(-6)}-1099000`, amount: { amount: 109900 } }])
    const [paid] = await applyPaymentEvents(store, events)
    expect(paid).toMatchObject({ status: 'paid', payment: { provider: 'bitcoin', methodLabel: 'Bitcoin' } })
    expect(await btc.sweep(ctx)).toEqual([])
  })

  it('flags an underpayment and does not pay it', async () => {
    const { store } = rig({}, config)
    await seed(store)
    const ctx = { store, siteUrl: '' }
    const { state, fetch } = explorer()
    const btc = bitcoinPayments({ xpub: ZPUB, fetch })
    const order = await placeOrder(store)
    await btc.start(order, ctx)
    state.txs[A0] = [pay(A0, 900_000, 900_000)]
    expect((await btc.quote(order, ctx)).status).toBe('underpaid')
    expect(await btc.sweep(ctx)).toEqual([])
  })

  it('re-quotes an expired, untouched quote at the new price, keeps a quote with money in flight, and recycles abandoned addresses', async () => {
    const { store, clock } = rig({}, config)
    await seed(store)
    const ctx = { store, siteUrl: '' }
    const { state, fetch } = explorer()
    const btc = bitcoinPayments({ xpub: ZPUB, fetch, quoteMinutes: 30 })
    const order = await placeOrder(store)
    expect((await btc.quote(order, ctx)).amountSats).toBe(1_099_000)
    state.price = 110_000
    clock.tick(31 * 60_000)
    const requoted = await btc.quote(order, ctx)
    expect(requoted.address).toBe(A0)
    expect(requoted.amountSats).toBe(Math.ceil((1099 / 110_000) * 1e8))

    // Abandoned for a day with nothing sent: the next order reuses A0 rather than deriving A1.
    clock.tick(25 * 3600_000)
    const next = await placeOrder(store)
    expect((await btc.quote(next, ctx)).address).toBe(A0)
  })
})
