import { afterEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { handleStoreApi } from '../src/api'
import { manualPayments } from '../src/payments/manual'
import { paypalLineCategory, paypalPayments, type PayPalPaymentOptions } from '../src/payments/paypal'
import { stripeLineCategory, stripePayments } from '../src/payments/stripe'
import type { PaymentAdapter } from '../src/payments'
import type { Store } from '../src/store'
import { placeOrder, rig, seed } from './helpers'

const KEY = 'k'.repeat(64)
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000)

function client(store: Store, payments: PaymentAdapter[]) {
  return async (path: string) => {
    const request = new Request(`https://store.test/api/skuio/v1${path}`, { headers: { authorization: `Bearer ${KEY}` } })
    const response = await handleStoreApi(request, { store, apiKey: KEY, payments: () => payments })
    return { status: response.status, body: (await response.json()) as any }
  }
}

const sumNet = (lines: { net: { amount: number } }[]) => lines.reduce((s, l) => s + l.net.amount, 0)

// ── Stripe ──────────────────────────────────────────────────────────────────────────────────

type Txn = Record<string, unknown> & { id: string; type: string }
type FakeStripeData = {
  payouts: (Record<string, unknown> & { id: string; created: number })[]
  /** Per payout, newest first as Stripe returns them, including the payout's own row. */
  txns: Record<string, Txn[]>
  charges?: Record<string, Record<string, unknown>>
  fail?: { payouts?: unknown; balance?: unknown }
}

function page<T extends { id: string }>(rows: T[], params: { starting_after?: string; limit?: number }) {
  const from = params.starting_after ? rows.findIndex((r) => r.id === params.starting_after) + 1 : 0
  const limit = params.limit ?? 10
  return { object: 'list', data: rows.slice(from, from + limit), has_more: from + limit < rows.length, url: '' }
}

function fakeStripe(d: FakeStripeData) {
  const chargesRetrieve = vi.fn(async (id: string) => {
    const c = d.charges?.[id]
    if (!c) throw Object.assign(new Error('No such charge'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 })
    return c
  })
  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ id: 'acct_1ExAmPlE00000000' })) },
    payouts: {
      list: vi.fn(async (params: { created?: { gte?: number }; starting_after?: string; limit?: number }) => {
        if (d.fail?.payouts) throw d.fail.payouts
        const rows = d.payouts.filter((p) => p.created >= (params.created?.gte ?? 0)).sort((a, b) => b.created - a.created)
        return page(rows, params)
      }),
      retrieve: vi.fn(async (id: string) => {
        const p = d.payouts.find((x) => x.id === id)
        if (!p) throw Object.assign(new Error('No such payout'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 })
        return p
      }),
    },
    balanceTransactions: {
      list: vi.fn(async (params: { payout: string; starting_after?: string; limit?: number; expand?: string[] }) => {
        if (d.fail?.balance) throw d.fail.balance
        const rows = d.txns[params.payout]
        if (!rows) throw Object.assign(new Error('No such payout'), { type: 'StripeInvalidRequestError', statusCode: 400 })
        const result = page(rows, params)
        if (!params.expand?.includes('data.source.charge')) return result
        // Stripe expands a refund's or dispute's charge inline.
        const expand = (source: unknown) => {
          const s = source as { charge?: unknown } | null
          return s && typeof s === 'object' && typeof s.charge === 'string' && d.charges?.[s.charge] ? { ...s, charge: d.charges[s.charge] } : source
        }
        return { ...result, data: result.data.map((row) => ({ ...row, source: expand(row.source) })) }
      }),
    },
    charges: { retrieve: chargesRetrieve },
  }
  return { stripe: stripe as unknown as Stripe, raw: stripe }
}

const bank = { object: 'bank_account', id: 'ba_test', bank_name: 'Bank', last4: '6789' }

/** A real Stripe payout with every id replaced by a synthetic one; names and addresses left out. */
const realPayout = {
  id: 'po_1ExAmPlE0000000000Payout',
  object: 'payout',
  amount: 49688,
  currency: 'usd',
  status: 'paid',
  automatic: true,
  method: 'standard',
  created: unix('2026-11-03T00:08:09Z'),
  arrival_date: unix('2026-11-03T00:00:00Z'),
  destination: bank,
}
const realCharge = (id: string, orderId: string, number: string) => ({
  id,
  object: 'charge',
  payment_intent: `pi_test_${number}`,
  metadata: { order_id: orderId, order_number: number },
})
const realTxns: Txn[] = [
  {
    id: 'txn_1ExAmPlE000000000Payout',
    type: 'payout',
    reporting_category: 'payout',
    amount: -49688,
    fee: 0,
    net: -49688,
    currency: 'usd',
    created: unix('2026-11-03T00:08:09Z'),
    available_on: unix('2026-11-03T00:00:00Z'),
    description: 'STRIPE PAYOUT',
    source: 'po_1ExAmPlE0000000000Payout',
    fee_details: [],
  },
  {
    id: 'txn_1ExAmPlE000000000Charge2',
    type: 'charge',
    reporting_category: 'charge',
    amount: 34155,
    fee: 1020,
    net: 33135,
    currency: 'usd',
    created: unix('2026-10-28T20:42:32Z'),
    available_on: unix('2026-11-03T00:00:00Z'),
    description: 'Example Store order EX15001',
    source: realCharge('ch_1ExAmPlE00000000000Charge2', 'ord_example0000000000002', '15001'),
    fee_details: [{ type: 'stripe_fee', amount: 1020, currency: 'usd', description: 'Stripe processing fees', application: null }],
  },
  {
    id: 'txn_1ExAmPlE000000000Charge1',
    type: 'charge',
    reporting_category: 'charge',
    amount: 17078,
    fee: 525,
    net: 16553,
    currency: 'usd',
    created: unix('2026-10-27T12:53:15Z'),
    available_on: unix('2026-11-03T00:00:00Z'),
    description: 'Example Store order EX15000',
    source: realCharge('ch_1ExAmPlE00000000000Charge1', 'ord_example0000000000001', '15000'),
    fee_details: [{ type: 'stripe_fee', amount: 525, currency: 'usd', description: 'Stripe processing fees', application: null }],
  },
]

const bt = (id: string, type: string, amount: number, fee: number, created: string, source: unknown, reporting_category = type): Txn => ({
  id,
  type,
  reporting_category,
  amount,
  fee,
  net: amount - fee,
  currency: 'usd',
  created: unix(created),
  available_on: unix(created) + 2 * 86400,
  description: null,
  source,
  fee_details: fee > 0 ? [{ type: 'stripe_fee', amount: fee, currency: 'usd', description: 'Stripe processing fees', application: null }] : [],
})
const synthPayout = (id: string, amount: number, created: string, extra: Record<string, unknown> = {}) => ({
  id, object: 'payout', amount, currency: 'usd', status: 'paid', automatic: true, method: 'standard', created: unix(created), arrival_date: unix(created) + 86400, destination: 'ba_test', ...extra,
})
const chargeA = { id: 'ch_A', object: 'charge', payment_intent: 'pi_A', metadata: { order_id: 'ord_A', order_number: '101' } }
const chargeB = { id: 'ch_B', object: 'charge', payment_intent: 'pi_B', metadata: { order_id: 'ord_B', order_number: '102' } }
const chargeC = { id: 'ch_C', object: 'charge', payment_intent: 'pi_C', metadata: { order_id: 'ord_C', order_number: '103' } }

const stripeData = (): FakeStripeData => ({
  payouts: [
    realPayout,
    // A refund of an order paid out earlier.
    synthPayout('po_refund', 6680, '2026-10-05T00:00:00Z'),
    // A dispute lost then won, plus a standalone Stripe billing fee.
    synthPayout('po_dispute', 4625, '2026-10-12T00:00:00Z'),
    // Negative balance: Stripe pulls money from the bank.
    synthPayout('po_debit', -1500, '2026-10-20T00:00:00Z'),
    // Sent from the Dashboard: Stripe itemises nothing.
    synthPayout('po_manual', 1000, '2026-10-21T00:00:00Z', { automatic: false }),
  ],
  txns: {
    po_1ExAmPlE0000000000Payout: realTxns,
    po_refund: [
      bt('txn_po_refund', 'payout', -6680, 0, '2026-10-05T00:00:00Z', 'po_refund', 'payout'),
      bt('txn_refund', 'refund', -3000, 0, '2026-10-03T00:00:00Z', { id: 're_1', object: 'refund', charge: 'ch_A' }),
      bt('txn_charge_a', 'charge', 10000, 320, '2026-10-02T00:00:00Z', chargeA),
    ],
    po_dispute: [
      bt('txn_po_dispute', 'payout', -4625, 0, '2026-10-12T00:00:00Z', 'po_dispute', 'payout'),
      bt('txn_billing', 'stripe_fee', -200, 0, '2026-10-11T00:00:00Z', null, 'fee'),
      bt('txn_dispute_won', 'adjustment', 5000, -1500, '2026-10-10T00:00:00Z', { id: 'du_1', object: 'dispute', charge: 'ch_B' }, 'dispute_reversal'),
      bt('txn_dispute', 'adjustment', -5000, 1500, '2026-10-09T00:00:00Z', { id: 'du_1', object: 'dispute', charge: 'ch_B' }, 'dispute'),
      bt('txn_charge_b', 'charge', 5000, 175, '2026-10-08T00:00:00Z', chargeB),
    ],
    po_debit: [
      bt('txn_po_debit', 'payout', 1500, 0, '2026-10-20T00:00:00Z', 'po_debit', 'payout'),
      bt('txn_charge_small', 'charge', 520, 20, '2026-10-19T00:00:00Z', { id: 'ch_D', object: 'charge', payment_intent: 'pi_D', metadata: {} }),
      bt('txn_refund_c', 'refund', -2000, 0, '2026-10-18T00:00:00Z', { id: 're_2', object: 'refund', charge: 'ch_C' }),
    ],
  },
  charges: { ch_A: chargeA, ch_B: chargeB, ch_C: chargeC },
})

function stripeRig(data: FakeStripeData = stripeData()) {
  const { store } = rig()
  const fake = fakeStripe(data)
  const adapter = stripePayments({ stripe: fake.stripe, webhookSecret: 'whsec' })
  return { store, fake, adapter, api: client(store, [adapter, manualPayments()]) }
}

describe('stripe payouts', () => {
  it('serves the real-shaped payout exactly: two charge lines whose net sums to the payout', async () => {
    const { api } = stripeRig()
    const list = await api('/payouts?provider=stripe&created_since=2026-11-01T00:00:00Z')
    expect(list.status).toBe(200)
    expect(list.body).toEqual({
      data: [
        {
          id: 'po_1ExAmPlE0000000000Payout', provider: 'stripe', account_id: 'acct_1ExAmPlE00000000', status: 'paid',
          amount: { amount: 49688, currency: 'usd' }, arrival_date: '2026-11-03', created_at: '2026-11-03T00:08:09Z',
          method: 'standard', destination_label: 'Bank ••6789', line_count: null,
        },
      ],
      next_cursor: null,
      providers: ['stripe'],
      accounts: [{ provider: 'stripe', account_id: 'acct_1ExAmPlE00000000' }],
    })

    const one = await api('/payouts/stripe/po_1ExAmPlE0000000000Payout')
    expect(one.body.data).toMatchObject({ id: 'po_1ExAmPlE0000000000Payout', line_count: 2 })

    const lines = await api('/payouts/stripe/po_1ExAmPlE0000000000Payout/lines')
    expect(lines.status).toBe(200)
    expect(lines.body.next_cursor).toBeNull()
    expect(lines.body.data).toHaveLength(2)
    expect(lines.body.data.find((l: any) => l.id === 'txn_1ExAmPlE000000000Charge1')).toEqual({
      id: 'txn_1ExAmPlE000000000Charge1', type: 'charge', category: 'charge',
      source_id: 'ch_1ExAmPlE00000000000Charge1', order_id: 'ord_example0000000000001', order_number: '15000', payment_reference: 'pi_test_15000',
      gross: { amount: 17078, currency: 'usd' }, fee: { amount: 525, currency: 'usd' }, net: { amount: 16553, currency: 'usd' },
      fee_details: [{ type: 'stripe_fee', amount: 525, description: 'Stripe processing fees' }],
      created_at: '2026-10-27T12:53:15Z', available_on: '2026-11-03', description: 'Example Store order EX15000',
    })
    expect(lines.body.data.find((l: any) => l.id === 'txn_1ExAmPlE000000000Charge2')).toMatchObject({
      source_id: 'ch_1ExAmPlE00000000000Charge2', order_id: 'ord_example0000000000002', order_number: '15001',
      gross: { amount: 34155 }, fee: { amount: 1020 }, net: { amount: 33135 }, created_at: '2026-10-28T20:42:32Z',
    })
    expect(lines.body.data.some((l: any) => l.type === 'payout')).toBe(false)
    expect(sumNet(lines.body.data)).toBe(49688)
  })

  it('itemises refunds, disputes, billing fees and debit payouts with Stripe signs, every payout balancing', async () => {
    const { api, fake } = stripeRig()
    for (const [id, amount] of [['po_refund', 6680], ['po_dispute', 4625], ['po_debit', -1500]] as const) {
      const res = await api(`/payouts/stripe/${id}/lines`)
      for (const l of res.body.data) expect(l.gross.amount - l.fee.amount).toBe(l.net.amount)
      expect(sumNet(res.body.data)).toBe(amount)
      expect((await api(`/payouts/stripe/${id}`)).body.data.amount.amount).toBe(amount)
    }

    const refund = (await api('/payouts/stripe/po_refund/lines')).body.data
    expect(refund.find((l: any) => l.id === 'txn_refund')).toMatchObject({
      type: 'refund', category: 'refund', source_id: 're_1', order_id: 'ord_A', order_number: '101', payment_reference: 'pi_A',
      gross: { amount: -3000 }, fee: { amount: 0 }, net: { amount: -3000 }, fee_details: [],
    })

    fake.raw.charges.retrieve.mockClear()
    const dispute = (await api('/payouts/stripe/po_dispute/lines')).body.data
    const byId = Object.fromEntries(dispute.map((l: any) => [l.id, l]))
    expect(byId.txn_dispute).toMatchObject({ type: 'adjustment', category: 'dispute', source_id: 'du_1', order_id: 'ord_B', gross: { amount: -5000 }, fee: { amount: 1500 }, net: { amount: -6500 } })
    expect(byId.txn_dispute_won).toMatchObject({ category: 'dispute_reversal', order_id: 'ord_B', gross: { amount: 5000 }, fee: { amount: -1500 }, net: { amount: 6500 } })
    expect(byId.txn_billing).toMatchObject({ type: 'stripe_fee', category: 'fee', source_id: null, order_id: null, order_number: null, net: { amount: -200 } })
    // The disputed charge is on the same page: no extra read.
    expect(fake.raw.charges.retrieve).not.toHaveBeenCalled()

    fake.raw.balanceTransactions.list.mockClear()
    const debit = (await api('/payouts/stripe/po_debit/lines')).body.data
    // A refund of a charge paid out earlier gets that charge expanded inline: one Stripe call, no charge reads.
    expect(fake.raw.charges.retrieve).not.toHaveBeenCalled()
    expect(fake.raw.balanceTransactions.list).toHaveBeenCalledTimes(1)
    expect(fake.raw.balanceTransactions.list.mock.calls[0]![0]).toMatchObject({ payout: 'po_debit', expand: ['data.source', 'data.source.charge'] })
    expect(debit.find((l: any) => l.id === 'txn_refund_c')).toMatchObject({ category: 'refund', order_id: 'ord_C', net: { amount: -2000 } })
    expect(debit.find((l: any) => l.id === 'txn_charge_small')).toMatchObject({ order_id: null, payment_reference: 'pi_D' })
  })

  it('a manual payout has no lines; an unknown payout is 404', async () => {
    const { api } = stripeRig()
    expect((await api('/payouts/stripe/po_manual')).body.data).toMatchObject({ line_count: 0 })
    expect((await api('/payouts/stripe/po_manual/lines')).body).toEqual({ data: [], next_cursor: null })
    expect((await api('/payouts/stripe/po_nope')).status).toBe(404)
    expect((await api('/payouts/stripe/po_nope/lines')).status).toBe(404)
  })

  it('lists oldest first and pages with an opaque cursor; lines page too', async () => {
    const { api } = stripeRig()
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const res: any = await api(`/payouts?created_since=2026-10-01T00:00:00Z&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.status).toBe(200)
      seen.push(...res.body.data.map((p: any) => p.id))
      cursor = res.body.next_cursor
    } while (cursor)
    expect(seen).toEqual(['po_refund', 'po_dispute', 'po_debit', 'po_manual', 'po_1ExAmPlE0000000000Payout'])

    const first = await api('/payouts/stripe/po_dispute/lines?limit=2')
    expect(first.body.data).toHaveLength(1) // the payout's own row is on this page and is left out
    expect(first.body.next_cursor).toEqual(expect.any(String))
    const rest = await api(`/payouts/stripe/po_dispute/lines?limit=100&cursor=${encodeURIComponent(first.body.next_cursor)}`)
    expect(sumNet([...first.body.data, ...rest.body.data])).toBe(4625)
    expect((await api('/payouts/stripe/po_dispute/lines?cursor=bogus')).status).toBe(422)
    expect((await api('/payouts?cursor=bogus')).status).toBe(422)
    expect((await api('/payouts?limit=0')).status).toBe(422)
    expect((await api('/payouts?created_since=yesterday')).status).toBe(422)
  })

  it('maps reporting_category first, then type', () => {
    expect(stripeLineCategory({ reporting_category: 'charge', type: 'payment' })).toBe('charge')
    expect(stripeLineCategory({ reporting_category: 'refund', type: 'payment_refund' })).toBe('refund')
    expect(stripeLineCategory({ reporting_category: 'dispute', type: 'adjustment' })).toBe('dispute')
    expect(stripeLineCategory({ reporting_category: 'fee', type: 'stripe_fee' })).toBe('fee')
    expect(stripeLineCategory({ reporting_category: 'tax', type: 'tax' })).toBe('fee')
    expect(stripeLineCategory({ reporting_category: 'risk_reserved_funds', type: 'reserve_transaction' })).toBe('reserve')
    expect(stripeLineCategory({ reporting_category: 'other_adjustment', type: 'adjustment' })).toBe('adjustment')
    expect(stripeLineCategory({ reporting_category: 'topup', type: 'topup' })).toBe('transfer')
    expect(stripeLineCategory({ reporting_category: null, type: 'stripe_fee' })).toBe('fee')
    expect(stripeLineCategory({ reporting_category: 'climate_order_purchase', type: 'climate_order_purchase' })).toBe('other')
  })

  it('a key without Payouts: Read or Balance: Read answers 424 naming the permission', async () => {
    const denied = Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError', statusCode: 403 })
    const noPayouts = stripeRig({ ...stripeData(), fail: { payouts: denied } })
    const res = await noPayouts.api('/payouts?provider=stripe')
    expect(res.status).toBe(424)
    expect(res.body).toEqual({
      error: { code: 'processor_permission_missing', message: expect.stringContaining('Payouts: Read'), details: { provider: 'stripe', permission: 'Payouts: Read' } },
    })

    const noBalance = stripeRig({ ...stripeData(), fail: { balance: denied } })
    const lines = await noBalance.api('/payouts/stripe/po_refund/lines')
    expect(lines.status).toBe(424)
    expect(lines.body.error.details).toEqual({ provider: 'stripe', permission: 'Balance: Read' })
  })

  it('a page of refunds of earlier charges costs one Stripe call, every line keeping its order', async () => {
    const charges: Record<string, Record<string, unknown>> = {}
    const rows: Txn[] = [bt('txn_po_refunds', 'payout', 100 * 500, 0, '2026-10-30T00:00:00Z', 'po_refunds', 'payout')]
    for (let i = 0; i < 100; i++) {
      charges[`ch_r${i}`] = { id: `ch_r${i}`, object: 'charge', payment_intent: `pi_r${i}`, metadata: { order_id: `ord_r${i}`, order_number: String(2000 + i) } }
      rows.push(bt(`txn_r${i}`, 'refund', -500, 0, '2026-10-29T00:00:00Z', { id: `re_r${i}`, object: 'refund', charge: `ch_r${i}` }))
    }
    // A debit: Stripe pulls from the bank exactly what the refunds took.
    const { api, fake } = stripeRig({ payouts: [synthPayout('po_refunds', -100 * 500, '2026-10-30T00:00:00Z')], txns: { po_refunds: rows }, charges })
    const res = await api('/payouts/stripe/po_refunds/lines?limit=100')
    expect(res.status).toBe(200)
    expect(fake.raw.balanceTransactions.list).toHaveBeenCalledTimes(1)
    expect(fake.raw.charges.retrieve).not.toHaveBeenCalled()
    const lines = [...res.body.data]
    if (res.body.next_cursor) lines.push(...(await api(`/payouts/stripe/po_refunds/lines?limit=100&cursor=${encodeURIComponent(res.body.next_cursor)}`)).body.data)
    expect(lines).toHaveLength(100)
    expect(lines.every((l: any) => l.order_id === `ord_${l.source_id.slice(3)}` && l.payment_reference === `pi_${l.source_id.slice(3)}`)).toBe(true)
    expect(sumNet(lines)).toBe(-100 * 500)
  })

  it('a key that may not expand the charge falls back once to the sources alone', async () => {
    const { api, fake } = stripeRig()
    const original = fake.raw.balanceTransactions.list.getMockImplementation()!
    fake.raw.balanceTransactions.list.mockImplementation(async (params: any) => {
      if (params.expand?.includes('data.source.charge')) throw Object.assign(new Error('The provided key does not have the required permissions for this endpoint'), { type: 'StripePermissionError', statusCode: 403 })
      return original(params)
    })
    const res = await api('/payouts/stripe/po_debit/lines')
    expect(res.status).toBe(200)
    expect(fake.raw.balanceTransactions.list).toHaveBeenCalledTimes(2)
    expect(fake.raw.charges.retrieve).not.toHaveBeenCalled()
    // The refunded charge is not on this page: the line posts without its order.
    expect(res.body.data.find((l: any) => l.id === 'txn_refund_c')).toMatchObject({ category: 'refund', order_id: null, net: { amount: -2000 } })
    expect(sumNet(res.body.data)).toBe(-1500)
  })

  it('names "Balance transaction sources: Read" when Stripe says the key may not read the sources', async () => {
    const denied = Object.assign(
      new Error("The provided key 'rk_live_…' does not have the required permissions for this endpoint on account 'acct_1ExAmPlE00000000'. Having the 'rak_balance_transaction_source_read' permission would allow this request to continue."),
      { type: 'StripePermissionError', statusCode: 403 }
    )
    const { api } = stripeRig({ ...stripeData(), fail: { balance: denied } })
    const res = await api('/payouts/stripe/po_refund/lines')
    expect(res.status).toBe(424)
    expect(res.body.error.details).toEqual({ provider: 'stripe', permission: 'Balance transaction sources: Read' })
    expect(res.body.error.message).toContain('Grant "Balance transaction sources: Read"')
  })

  it('counts at most 1,000 lines for GET; a bigger payout has line_count null but all its lines', async () => {
    const rows = (id: string, n: number): Txn[] => [
      bt(`txn_${id}`, 'payout', -n * 100, 0, '2026-10-30T00:00:00Z', id, 'payout'),
      ...Array.from({ length: n }, (_, i) => bt(`txn_${id}_${String(i).padStart(4, '0')}`, 'charge', 100, 0, '2026-10-29T00:00:00Z', null)),
    ]
    const { api, fake } = stripeRig({
      payouts: [synthPayout('po_ok', 999 * 100, '2026-10-30T00:00:00Z'), synthPayout('po_big', 1000 * 100, '2026-10-30T00:00:00Z')],
      txns: { po_ok: rows('po_ok', 999), po_big: rows('po_big', 1000) },
    })
    expect((await api('/payouts/stripe/po_ok')).body.data.line_count).toBe(999)
    fake.raw.balanceTransactions.list.mockClear()
    expect((await api('/payouts/stripe/po_big')).body.data.line_count).toBeNull()
    expect(fake.raw.balanceTransactions.list).toHaveBeenCalledTimes(10)

    let count = 0
    let cursor: string | null = null
    do {
      const res: any = await api(`/payouts/stripe/po_big/lines?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      count += res.body.data.length
      cursor = res.body.next_cursor
    } while (cursor)
    expect(count).toBe(1000)
  })

  it('caches the account id and falls back to no destination label when the key cannot expand it', async () => {
    const data = stripeData()
    const { api, fake } = stripeRig(data)
    const original = fake.raw.payouts.list.getMockImplementation()!
    fake.raw.payouts.list.mockImplementation(async (params: any) => {
      if (params.expand) throw Object.assign(new Error('no external accounts'), { type: 'StripePermissionError', statusCode: 403 })
      return original({ ...params, created: params.created })
    })
    const res = await api('/payouts?provider=stripe&created_since=2026-10-01T00:00:00Z')
    expect(res.status).toBe(200)
    await api('/payouts?provider=stripe&created_since=2026-10-01T00:00:00Z')
    expect(fake.raw.accounts.retrieve).toHaveBeenCalledTimes(1)
  })
})

// ── PayPal ──────────────────────────────────────────────────────────────────────────────────

type PPTxn = { transaction_info: Record<string, unknown> & { transaction_id: string; transaction_initiation_date: string } }
type PPOpts = {
  fee?: string; currency?: string; status?: string; custom?: string; ref?: string
  /** transaction_info.ending_balance: the balance in this currency after the transaction. */
  balance?: string
  /** transaction_info.transaction_updated_date. */
  updated?: string
  instrument?: string
  subInstrument?: string
}
const pp = (id: string, code: string, date: string, value: string, opts: PPOpts = {}): PPTxn => ({
  transaction_info: {
    transaction_id: id,
    transaction_event_code: code,
    transaction_initiation_date: date.replace('Z', '+0000'),
    ...(opts.updated ? { transaction_updated_date: opts.updated.replace('Z', '+0000') } : {}),
    transaction_amount: { currency_code: opts.currency ?? 'USD', value },
    ...(opts.fee ? { fee_amount: { currency_code: opts.currency ?? 'USD', value: opts.fee } } : {}),
    transaction_status: opts.status ?? 'S',
    ...(opts.custom ? { custom_field: opts.custom } : {}),
    ...(opts.ref ? { paypal_reference_id: opts.ref } : {}),
    ...(opts.balance !== undefined ? { ending_balance: { currency_code: opts.currency ?? 'USD', value: opts.balance } } : {}),
    ...(opts.instrument ? { instrument_type: opts.instrument } : {}),
    ...(opts.subInstrument ? { instrument_sub_type: opts.subInstrument } : {}),
  },
})

/** Two withdrawals (W1, W2) with payments, a refund and a CAD→USD conversion between them. */
const paypalTxns = (orderId: string): PPTxn[] => [
  pp('PAY0', 'T0006', '2026-08-30T10:00:00Z', '51.75', { fee: '-1.75', custom: 'ord_0' }),
  pp('W0', 'T0400', '2026-09-01T09:00:00Z', '-50.00'),
  pp('PAY1', 'T0006', '2026-09-20T10:00:00Z', '100.00', { fee: '-3.20', custom: 'ord_A' }),
  pp('W1', 'T0400', '2026-09-21T09:00:00Z', '-96.80'),
  pp('PAY2', 'T0006', '2026-10-01T10:00:00Z', '200.00', { fee: '-6.10', custom: orderId }),
  pp('PAY3', 'T0006', '2026-10-02T10:00:00Z', '50.00', { fee: '-1.75', currency: 'CAD', custom: 'ord_C' }),
  pp('FX-CAD', 'T0200', '2026-10-03T10:00:00Z', '-48.25', { currency: 'CAD' }),
  pp('FX-USD', 'T0200', '2026-10-03T10:00:00Z', '35.00'),
  pp('REF1', 'T1107', '2026-10-05T10:00:00Z', '-40.00', { fee: '1.00', ref: 'PAY2' }),
  pp('PEND', 'T0006', '2026-10-06T10:00:00Z', '30.00', { fee: '-1.00', status: 'P', custom: 'ord_P' }),
  pp('W2', 'T0400', '2026-10-10T09:00:00Z', '-189.90'),
  pp('PAY4', 'T0006', '2026-10-20T10:00:00Z', '75.00', { fee: '-2.50', custom: 'ord_D' }),
  pp('W3', 'T0400', '2026-10-25T09:00:00Z', '-72.50', { status: 'D' }),
]

type FakePayPalOptions = {
  userinfo?: number
  search?: number
  pageSize?: number
  /** The token endpoint's status (401: a wrong client id or secret). */
  token?: number
  /** More rows than this in one window is RESULTSET_TOO_LARGE. */
  maxResults?: number
}

function fakePayPal(txns: PPTxn[], opts: FakePayPalOptions = {}) {
  const calls: string[] = []
  /** Every [start, end] a range search (no transaction_id) answered, page 1 only. */
  const windows: [number, number][] = []
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    if (url.pathname === '/v1/oauth2/token') {
      if (opts.token) return new Response('{"error":"invalid_client","error_description":"Client Authentication failed"}', { status: opts.token })
      return Response.json({ access_token: 'T', expires_in: 3600 })
    }
    if (url.pathname === '/v1/identity/oauth2/userinfo') {
      if (opts.userinfo) return new Response('{"name":"NOT_AUTHORIZED"}', { status: opts.userinfo })
      return Response.json({ payer_id: 'MERCHANTPAYER1' })
    }
    if (url.pathname === '/v1/reporting/transactions') {
      if (opts.search) return new Response('{"name":"NOT_AUTHORIZED","message":"Authorization failed due to insufficient permissions."}', { status: opts.search })
      const q = url.searchParams
      const start = Date.parse(q.get('start_date')!)
      const end = Date.parse(q.get('end_date')!)
      if (end - start > 31 * 86_400_000) return new Response('{"name":"INVALID_REQUEST"}', { status: 400 })
      const id = q.get('transaction_id')
      const rows = txns.filter((t) => {
        const at = Date.parse(t.transaction_info.transaction_initiation_date.replace('+0000', 'Z'))
        return at >= start && at <= end && (!id || t.transaction_info.transaction_id === id)
      })
      if (opts.maxResults !== undefined && rows.length > opts.maxResults) {
        return new Response('{"name":"RESULTSET_TOO_LARGE","message":"Result set size is greater than the maximum limit. Change the filter criteria and try again."}', { status: 400 })
      }
      const size = opts.pageSize ?? Number(q.get('page_size'))
      const n = Number(q.get('page'))
      if (!id && n === 1) windows.push([start, end])
      return Response.json({
        account_number: 'MERCHANTPAYER1',
        transaction_details: rows.slice((n - 1) * size, n * size),
        page: n,
        total_pages: Math.max(1, Math.ceil(rows.length / size)),
      })
    }
    return new Response('no route', { status: 599 })
  })
  return { fetch: impl as unknown as typeof fetch, calls, windows }
}

const PAYPAL_NOW = '2026-11-02T12:00:00Z'

async function paypalRig(opts: FakePayPalOptions & { txns?: PPTxn[]; adapter?: Partial<PayPalPaymentOptions> } = {}) {
  const { store } = rig()
  await seed(store)
  const order = await placeOrder(store)
  const fake = fakePayPal(opts.txns ?? paypalTxns(order.id), { pageSize: 3, ...opts })
  const adapter = paypalPayments({ clientId: 'CLIENT_ID', clientSecret: 's', webhookId: 'W', environment: 'live', fetch: fake.fetch, now: () => new Date(PAYPAL_NOW), ...opts.adapter })
  return { store, order, fake, adapter, api: client(store, [adapter]) }
}

describe('paypal payouts', () => {
  it('lists each withdrawal as a payout, in ≤31-day windows', async () => {
    const { api, fake } = await paypalRig()
    const res = await api('/payouts?provider=paypal&created_since=2026-09-15T00:00:00Z')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual([
      {
        id: 'W1', provider: 'paypal', account_id: 'MERCHANTPAYER1', status: 'paid', amount: { amount: 9680, currency: 'usd' },
        arrival_date: '2026-09-21', created_at: '2026-09-21T09:00:00Z', method: 'withdrawal', destination_label: null,
        // W0 (its previous withdrawal) is before created_since: counted only by GET /payouts/paypal/W1.
        line_count: null,
      },
      expect.objectContaining({ id: 'W2', amount: { amount: 18990, currency: 'usd' }, status: 'paid', line_count: 3 }),
      expect.objectContaining({ id: 'W3', status: 'failed', line_count: 0 }),
    ])
    for (const call of fake.calls.filter((c) => c.startsWith('/v1/reporting/transactions'))) {
      const q = new URLSearchParams(call.split('?')[1])
      expect(Date.parse(q.get('end_date')!) - Date.parse(q.get('start_date')!)).toBeLessThanOrEqual(31 * 86_400_000)
      expect(q.get('fields')).toBe('all')
    }
  })

  it('itemises the balance movements since the previous withdrawal; net sums to the withdrawal', async () => {
    const { api, order } = await paypalRig()
    const w2 = await api('/payouts/paypal/W2')
    expect(w2.body.data).toMatchObject({ id: 'W2', line_count: 3, amount: { amount: 18990, currency: 'usd' } })

    const lines = (await api('/payouts/paypal/W2/lines')).body
    expect(lines.next_cursor).toBeNull()
    expect(lines.data.map((l: any) => l.id)).toEqual(['PAY2', 'FX-USD', 'REF1'])
    expect(sumNet(lines.data)).toBe(18990)
    for (const l of lines.data) expect(l.gross.amount - l.fee.amount).toBe(l.net.amount)
    expect(lines.data[0]).toEqual({
      id: 'PAY2', type: 'T0006', category: 'charge', source_id: 'PAY2', order_id: order.id, order_number: order.number, payment_reference: 'PAY2',
      gross: { amount: 20000, currency: 'usd' }, fee: { amount: 610, currency: 'usd' }, net: { amount: 19390, currency: 'usd' },
      fee_details: [{ type: 'paypal_fee', amount: 610, description: 'PayPal fee' }],
      created_at: '2026-10-01T10:00:00Z', available_on: null, description: null,
    })
    expect(lines.data[1]).toMatchObject({ type: 'T0200', category: 'adjustment', order_id: null, net: { amount: 3500 } })
    // The refund carries no custom id: its order comes from the payment it refunds.
    expect(lines.data[2]).toMatchObject({ type: 'T1107', category: 'refund', order_id: order.id, order_number: order.number, payment_reference: 'PAY2', gross: { amount: -4000 }, fee: { amount: -100 }, net: { amount: -3900 } })

    const w1 = (await api('/payouts/paypal/W1/lines')).body.data
    expect(w1.map((l: any) => l.id)).toEqual(['PAY1'])
    expect(sumNet(w1)).toBe(9680)
    expect((await api('/payouts/paypal/W1')).body.data.line_count).toBe(1)
  })

  it('pages lines, lists a failed withdrawal with no lines, and 404s what is not a withdrawal', async () => {
    const { api } = await paypalRig()
    const first = await api('/payouts/paypal/W2/lines?limit=2')
    expect(first.body.data).toHaveLength(2)
    const rest = await api(`/payouts/paypal/W2/lines?cursor=${encodeURIComponent(first.body.next_cursor)}`)
    expect(rest.body).toMatchObject({ data: [{ id: 'REF1' }], next_cursor: null })
    expect((await api('/payouts/paypal/W3/lines')).body.data).toEqual([])
    expect((await api('/payouts/paypal/PAY2')).status).toBe(404)
    expect((await api('/payouts/paypal/NOPE/lines')).status).toBe(404)
  })

  it('maps T-codes to categories per PayPal\'s T-code reference', () => {
    expect(paypalLineCategory('T0006')).toBe('charge')
    expect(paypalLineCategory('T0700')).toBe('charge')
    expect(paypalLineCategory('T1107')).toBe('refund')
    expect(paypalLineCategory('T1106')).toBe('dispute')
    expect(paypalLineCategory('T1201')).toBe('dispute') // chargeback
    expect(paypalLineCategory('T1202')).toBe('dispute_reversal') // chargeback reversal
    expect(paypalLineCategory('T1108')).toBe('fee') // fee reversal
    expect(paypalLineCategory('T1109')).toBe('fee') // fee refund
    expect(paypalLineCategory('T1105')).toBe('reserve') // reversal of a general account hold
    expect(paypalLineCategory('T0106')).toBe('fee')
    expect(paypalLineCategory('T1501')).toBe('reserve')
    expect(paypalLineCategory('T0200')).toBe('adjustment')
    expect(paypalLineCategory('T0300')).toBe('transfer')
    expect(paypalLineCategory('T1101')).toBe('transfer') // withdrawal reversed
    expect(paypalLineCategory('T0400')).toBe('payout')
    expect(paypalLineCategory('T9900')).toBe('other')
  })

  it('without Transaction search answers 424; without identity read the account id falls back', async () => {
    const denied = await paypalRig({ search: 403 })
    const res = await denied.api('/payouts?provider=paypal&created_since=2026-10-01T00:00:00Z')
    expect(res.status).toBe(424)
    expect(res.body.error).toMatchObject({ code: 'processor_permission_missing', details: { provider: 'paypal', permission: 'Transaction search' } })
    expect(res.body.error.message).toContain('NOT_AUTHORIZED')

    const noIdentity = await paypalRig({ userinfo: 403 })
    const list = await noIdentity.api('/payouts?provider=paypal&created_since=2026-10-01T00:00:00Z')
    expect(list.body.data[0].account_id).toBe('MERCHANTPAYER1')
  })

  it('refused client credentials (OAuth 401) answer 424 naming "API credentials"', async () => {
    const { api } = await paypalRig({ token: 401 })
    for (const path of ['/payouts?provider=paypal&created_since=2026-10-01T00:00:00Z', '/payouts/paypal/W2', '/payouts/paypal/W2/lines']) {
      const res = await api(path)
      expect(res.status).toBe(424)
      expect(res.body.error).toMatchObject({ code: 'processor_permission_missing', details: { provider: 'paypal', permission: 'API credentials' } })
    }
  })

  it('keeps a payment refunded later (status V) beside its refund; leaves out pending, denied and authorizations; orders by date then id', async () => {
    const { api } = await paypalRig({
      txns: [
        pp('WA', 'T0400', '2026-10-01T09:00:00Z', '-10.00'),
        // Completed, then reversed by the refund below: PayPal marks the original V.
        pp('PAYV', 'T0006', '2026-10-02T10:00:00Z', '100.00', { fee: '-3.20', status: 'V', custom: 'ord_V' }),
        pp('REFV', 'T1107', '2026-10-03T10:00:00Z', '-100.00', { fee: '2.90', ref: 'PAYV' }),
        // Same second, answered out of id order.
        pp('PAYB', 'T0006', '2026-10-04T10:00:00Z', '30.00', { fee: '-1.00', custom: 'ord_B' }),
        pp('PAYA', 'T0006', '2026-10-04T10:00:00Z', '20.00', { fee: '-0.75', custom: 'ord_A' }),
        pp('PEND', 'T0006', '2026-10-04T12:00:00Z', '20.00', { fee: '-0.70', status: 'P' }),
        pp('DENY', 'T0006', '2026-10-04T13:00:00Z', '15.00', { status: 'D' }),
        pp('AUTH', 'T1300', '2026-10-05T10:00:00Z', '40.00'),
        pp('WB', 'T0400', '2026-10-06T09:00:00Z', '-47.95'),
      ],
    })
    const lines = (await api('/payouts/paypal/WB/lines')).body.data
    expect(lines.map((l: any) => l.id)).toEqual(['PAYV', 'REFV', 'PAYA', 'PAYB'])
    expect(lines[0]).toMatchObject({ category: 'charge', gross: { amount: 10000 }, fee: { amount: 320 }, net: { amount: 9680 } })
    expect(lines[1]).toMatchObject({ category: 'refund', payment_reference: 'PAYV', order_id: 'ord_V', gross: { amount: -10000 }, fee: { amount: -290 }, net: { amount: -9710 } })
    expect(sumNet(lines)).toBe(4795)
    expect((await api('/payouts/paypal/WB')).body.data).toMatchObject({ amount: { amount: 4795 }, line_count: 4 })
  })

  it('reads only data older than the reporting lag: a withdrawal from the last three hours is not listed yet', async () => {
    const txns = [
      pp('WOLD', 'T0400', '2026-10-30T09:00:00Z', '-10.00'),
      pp('PAYNEW', 'T0006', '2026-11-02T09:30:00Z', '10.00'),
      pp('WNEW', 'T0400', '2026-11-02T10:00:00Z', '-10.00'),
    ]
    const lagged = await paypalRig({ txns })
    const list = await lagged.api('/payouts?provider=paypal&created_since=2026-10-25T00:00:00Z')
    expect(list.body.data.map((p: any) => p.id)).toEqual(['WOLD'])
    expect((await lagged.api('/payouts/paypal/WNEW')).status).toBe(404)
    const watermark = Date.parse(PAYPAL_NOW) - 3 * 3_600_000
    for (const call of lagged.fake.calls.filter((c) => c.startsWith('/v1/reporting/transactions'))) {
      expect(Date.parse(new URLSearchParams(call.split('?')[1]).get('end_date')!)).toBeLessThanOrEqual(watermark)
    }

    // The lag is configurable; with none, the withdrawal and its payment are there.
    const live = await paypalRig({ txns, adapter: { reportingLagMs: 0 } })
    expect((await live.api('/payouts?provider=paypal&created_since=2026-10-25T00:00:00Z')).body.data.map((p: any) => p.id)).toEqual(['WOLD', 'WNEW'])
    expect((await live.api('/payouts/paypal/WNEW/lines')).body.data.map((l: any) => l.id)).toEqual(['PAYNEW'])
  })

  it('puts a payment in the same second as a withdrawal in that withdrawal, whatever the ids', async () => {
    const { api } = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
        pp('ZPAY', 'T0006', '2026-10-05T09:00:00Z', '100.00'),
        pp('AW', 'T0400', '2026-10-05T09:00:00Z', '-100.00'),
      ],
    })
    const lines = (await api('/payouts/paypal/AW/lines')).body.data
    expect(lines.map((l: any) => l.id)).toEqual(['ZPAY'])
    expect(sumNet(lines)).toBe(10000)
  })

  it('a transaction a fraction of a second after a 31-day window boundary is still found', async () => {
    // The read starts 14 days (the settlement delay) before created_since; 31 days − 1 s later the first window
    // ends and the second starts: 2026-08-31T00:00:00Z + 31 d − 1 s = 2026-10-01T23:59:59Z.
    const { api } = await paypalRig({ txns: [pp('WFRAC', 'T0400', '2026-10-01T23:59:59.500Z', '-5.00')] })
    const res = await api('/payouts?provider=paypal&created_since=2026-09-14T00:00:00Z')
    expect(res.body.data.map((p: any) => [p.id, p.created_at])).toEqual([['WFRAC', '2026-10-01T23:59:59Z']])
  })

  it('a reversed withdrawal and its reversal in one interval are both transfer lines that cancel out', async () => {
    const { api } = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
        pp('PAY', 'T0006', '2026-10-02T09:00:00Z', '100.00'),
        pp('WREV', 'T0400', '2026-10-03T09:00:00Z', '-100.00', { status: 'V' }),
        pp('BACK', 'T1101', '2026-10-04T09:00:00Z', '100.00', { ref: 'WREV' }),
        pp('W2', 'T0400', '2026-10-05T09:00:00Z', '-100.00'),
      ],
    })
    const lines = (await api('/payouts/paypal/W2/lines')).body.data
    expect(lines.map((l: any) => [l.id, l.category, l.net.amount])).toEqual([['PAY', 'charge', 10000], ['WREV', 'transfer', -10000], ['BACK', 'transfer', 10000]])
    expect(sumNet(lines)).toBe(10000)
    expect((await api('/payouts/paypal/WREV')).body.data).toMatchObject({ status: 'canceled', line_count: 0 })
    expect((await api('/payouts/paypal/WREV/lines')).body.data).toEqual([])
  })

  it('a reversed withdrawal and its reversal in different intervals each balance their own payout', async () => {
    const { api } = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
        pp('PAY1', 'T0006', '2026-10-02T09:00:00Z', '100.00'),
        pp('WV', 'T0400', '2026-10-03T09:00:00Z', '-100.00', { status: 'V' }),
        pp('PAY2', 'T0006', '2026-10-04T09:00:00Z', '50.00'),
        pp('W50', 'T0400', '2026-10-05T09:00:00Z', '-50.00'),
        pp('BACK', 'T1101', '2026-10-06T09:00:00Z', '100.00', { ref: 'WV' }),
        pp('W100', 'T0400', '2026-10-07T09:00:00Z', '-100.00'),
      ],
    })
    const w50 = (await api('/payouts/paypal/W50/lines')).body.data
    expect(w50.map((l: any) => l.id)).toEqual(['PAY1', 'WV', 'PAY2'])
    expect(sumNet(w50)).toBe(5000)
    const w100 = (await api('/payouts/paypal/W100/lines')).body.data
    expect(w100.map((l: any) => [l.id, l.category])).toEqual([['BACK', 'transfer']])
    expect(sumNet(w100)).toBe(10000)
  })

  it.each([['ZV', 'A50'], ['AV', 'Z50']])('a reversed withdrawal at the same instant as a withdrawal belongs to it (%s vs %s)', async (reversed, boundary) => {
    const { api } = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
        pp('PAY1', 'T0006', '2026-10-02T09:00:00Z', '100.00'),
        pp('PAY2', 'T0006', '2026-10-03T09:00:00Z', '50.00'),
        pp(reversed, 'T0400', '2026-10-04T09:00:00Z', '-100.00', { status: 'V' }),
        pp(boundary, 'T0400', '2026-10-04T09:00:00Z', '-50.00'),
        pp('BACK', 'T1101', '2026-10-05T09:00:00Z', '100.00', { ref: reversed }),
        pp('W100', 'T0400', '2026-10-06T09:00:00Z', '-100.00'),
      ],
    })
    const first = (await api(`/payouts/paypal/${boundary}/lines`)).body.data
    expect(first.map((l: any) => l.id)).toContain(reversed)
    expect(sumNet(first)).toBe(5000)
    expect(sumNet((await api('/payouts/paypal/W100/lines')).body.data)).toBe(10000)
  })

  it('a withdrawal fee (T0102) that references its withdrawal is an ordinary line', async () => {
    const { api } = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
        pp('PAY', 'T0006', '2026-10-02T09:00:00Z', '100.00'),
        pp('WFEE', 'T0102', '2026-10-03T08:59:59Z', '-2.00', { ref: 'W98' }),
        pp('W98', 'T0400', '2026-10-03T09:00:00Z', '-98.00'),
      ],
    })
    const lines = (await api('/payouts/paypal/W98/lines')).body.data
    expect(lines.map((l: any) => [l.id, l.category])).toEqual([['PAY', 'charge'], ['WFEE', 'fee']])
    expect(sumNet(lines)).toBe(9800)
  })

  it('fills order links with one bulk lookup, and fails the request when that lookup fails', async () => {
    const { api, store, order } = await paypalRig()
    const links = vi.spyOn(store.orders, 'paymentLinks')
    const get = vi.spyOn(store.orders, 'get')
    const byRef = vi.spyOn(store.orders, 'byPaymentReference')
    const ok = await api('/payouts/paypal/W2/lines')
    expect(ok.body.data.find((l: any) => l.id === 'REF1')).toMatchObject({ order_id: order.id, order_number: order.number })
    expect(links).toHaveBeenCalledTimes(1)
    expect(get).not.toHaveBeenCalled()
    expect(byRef).not.toHaveBeenCalled()

    links.mockRejectedValueOnce(new Error('D1_ERROR: too many queries'))
    const failed = await api('/payouts/paypal/W2/lines')
    expect(failed.status).toBe(500)
    expect(failed.body.error.code).toBe('internal_error')
  })

  it('halves a window PayPal finds too large, covering every second exactly once', async () => {
    const plain = await paypalRig()
    const split = await paypalRig({ maxResults: 2 })
    const since = '2026-09-15T00:00:00Z'
    const expected = (await plain.api(`/payouts?provider=paypal&created_since=${since}`)).body
    split.fake.windows.length = 0
    const res = await split.api(`/payouts?provider=paypal&created_since=${since}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(expected)

    // The answered windows cover [created_since, now − lag] with no gap.
    const windows = [...split.fake.windows].sort((a, b) => a[0] - b[0])
    expect(windows.length).toBeGreaterThan(2) // more than the two 31-day windows: some were halved
    // From a settlement delay (14 days) before created_since, so a late-clearing eCheck is seen.
    expect(windows[0]![0]).toBe(Date.parse(since) - 14 * 86_400_000)
    expect(windows[windows.length - 1]![1]).toBe(Date.parse(PAYPAL_NOW) - 3 * 3_600_000)
    // Adjacent windows overlap at their shared instant, so nothing between two whole seconds falls out.
    for (let i = 1; i < windows.length; i++) expect(windows[i]![0]).toBe(windows[i - 1]![1])

    const lines = (await split.api('/payouts/paypal/W2/lines')).body.data
    expect(lines.map((l: any) => l.id)).toEqual(['PAY2', 'FX-USD', 'REF1'])
    expect(sumNet(lines)).toBe(18990)
  })
})

describe('paypal balance mode (paypal_mode=balance)', () => {
  /** Two full days and a day still inside the reporting lag; withdrawals and withdrawal reversals are not lines. */
  const balanceTxns = (): PPTxn[] => [
    pp('W0', 'T0400', '2026-10-20T09:00:00Z', '-1.00'),
    pp('PAYA', 'T0006', '2026-10-28T10:00:00Z', '100.00', { fee: '-3.20', custom: 'ord_A' }),
    pp('PAYC', 'T0006', '2026-10-28T11:00:00Z', '50.00', { fee: '-1.75', currency: 'CAD', custom: 'ord_C' }),
    pp('REFA', 'T1107', '2026-10-28T15:00:00Z', '-40.00', { fee: '1.00', ref: 'PAYA' }),
    pp('FEE1', 'T0100', '2026-10-28T16:00:00Z', '-2.00'),
    pp('WD', 'T0400', '2026-10-28T18:00:00Z', '-50.00'),
    pp('PAYB', 'T0006', '2026-10-29T08:00:00Z', '20.00', { fee: '-0.80', custom: 'ord_B' }),
    pp('WREV', 'T0400', '2026-10-29T12:00:00Z', '-30.00', { status: 'V' }),
    pp('BACK', 'T1101', '2026-10-29T13:00:00Z', '30.00', { ref: 'WREV' }),
    pp('PEND', 'T0006', '2026-10-29T14:00:00Z', '9.00', { status: 'P' }),
    pp('PAYN', 'T0006', '2026-11-02T08:00:00Z', '10.00'),
  ]

  it('one payout per UTC day and currency, withdrawals excluded, status by reporting lag, Σ net = amount', async () => {
    const { api } = await paypalRig({ txns: balanceTxns() })
    const res = await api('/payouts?provider=paypal&paypal_mode=balance&created_since=2026-10-25T00:00:00Z')
    expect(res.status).toBe(200)
    expect(res.body.data.map((p: any) => [p.id, p.status, p.amount.amount, p.amount.currency, p.line_count])).toEqual([
      ['day-2026-10-28-CAD', 'paid', 4825, 'cad', 1],
      ['day-2026-10-28-USD', 'paid', 5580, 'usd', 3],
      ['day-2026-10-29-USD', 'paid', 1920, 'usd', 1],
      // 2026-11-02 ends after now − 3 h: listed, but pending (its amount can still change).
      ['day-2026-11-02-USD', 'pending', 1000, 'usd', 1],
    ])
    expect(res.body.data[1]).toEqual({
      id: 'day-2026-10-28-USD', provider: 'paypal', account_id: 'MERCHANTPAYER1', status: 'paid', amount: { amount: 5580, currency: 'usd' },
      arrival_date: '2026-10-28', created_at: '2026-10-28T23:59:59Z', method: 'balance', destination_label: 'PayPal balance', line_count: 3,
    })
    for (const p of res.body.data) {
      const lines = (await api(`/payouts/paypal/${p.id}/lines`)).body.data
      expect(lines).toHaveLength(p.line_count)
      expect(sumNet(lines)).toBe(p.amount.amount)
      for (const l of lines) expect(l.gross.amount - l.fee.amount).toBe(l.net.amount)
    }
  })

  it('a day\'s lines: refund and fee included, withdrawal, reversed withdrawal and its reversal left out; ids need no mode', async () => {
    const { api } = await paypalRig({ txns: balanceTxns() })
    // The id says what it is: get and lines need no paypal_mode.
    expect((await api('/payouts/paypal/day-2026-10-28-USD')).body.data).toMatchObject({ amount: { amount: 5580 }, line_count: 3, method: 'balance' })
    const lines = (await api('/payouts/paypal/day-2026-10-28-USD/lines')).body.data
    expect(lines.map((l: any) => [l.id, l.category, l.net.amount])).toEqual([['PAYA', 'charge', 9680], ['REFA', 'refund', -3900], ['FEE1', 'fee', -200]])
    expect(lines[1]).toMatchObject({ order_id: 'ord_A', payment_reference: 'PAYA' })
    const d29 = (await api('/payouts/paypal/day-2026-10-29-USD/lines?paypal_mode=balance')).body.data
    expect(d29.map((l: any) => l.id)).toEqual(['PAYB'])
    // No movement that day / malformed day / unknown currency: 404.
    expect((await api('/payouts/paypal/day-2026-10-30-USD')).status).toBe(404)
    expect((await api('/payouts/paypal/day-2026-02-30-USD')).status).toBe(404)
    expect((await api('/payouts/paypal/day-2026-10-28-EUR/lines')).status).toBe(404)
  })

  it('withdrawal mode stays the default; an unknown paypal_mode is 422; stripe ignores it', async () => {
    const { api } = await paypalRig({ txns: balanceTxns() })
    const withdrawals = await api('/payouts?provider=paypal&created_since=2026-10-25T00:00:00Z')
    expect(withdrawals.body.data.map((p: any) => [p.id, p.status])).toEqual([['WD', 'paid'], ['WREV', 'canceled']])
    const bad = await api('/payouts?provider=paypal&paypal_mode=sideways&created_since=2026-10-25T00:00:00Z')
    expect(bad.status).toBe(422)
    expect(bad.body.error.details).toEqual({ paypal_mode: 'must be one of withdrawal, balance' })
    expect((await api('/payouts/paypal/WD?paypal_mode=sideways')).status).toBe(422)

    const { store } = rig()
    const stripe = stripePayments({ stripe: fakeStripe(stripeData()).stripe, webhookSecret: 'whsec' })
    expect((await client(store, [stripe])('/payouts?provider=stripe&paypal_mode=sideways&created_since=2026-10-01T00:00:00Z')).status).toBe(200)
  })

  it('pages a balance-day list with the merged cursor', async () => {
    const { api } = await paypalRig({ txns: balanceTxns() })
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const res: any = await api(`/payouts?provider=paypal&paypal_mode=balance&created_since=2026-10-25T00:00:00Z&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      ids.push(...res.body.data.map((p: any) => p.id))
      cursor = res.body.next_cursor
    } while (cursor)
    expect(ids).toEqual(['day-2026-10-28-CAD', 'day-2026-10-28-USD', 'day-2026-10-29-USD', 'day-2026-11-02-USD'])
  })
})

describe('paypal partial withdrawals (carry lines from ending_balance)', () => {
  // Receive 100 (fee 3), withdraw 40 (57 stays), receive 20, withdraw 77 (balance emptied).
  const partial = (o: { w1Balance?: string; w2Balance?: string } = {}): PPTxn[] => [
    pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-5.00', { balance: '0.00' }),
    pp('P1', 'T0006', '2026-10-02T09:00:00Z', '100.00', { fee: '-3.00', balance: '97.00' }),
    pp('W1', 'T0400', '2026-10-03T09:00:00Z', '-40.00', o.w1Balance === '' ? {} : { balance: o.w1Balance ?? '57.00' }),
    pp('P2', 'T0006', '2026-10-04T09:00:00Z', '20.00', { balance: '77.00' }),
    pp('W2', 'T0400', '2026-10-05T09:00:00Z', '-77.00', o.w2Balance === '' ? {} : { balance: o.w2Balance ?? '0.00' }),
  ]

  it('carry_out on the partial withdrawal, carry_in on the next: each withdrawal\'s lines sum to its amount', async () => {
    const { api } = await paypalRig({ txns: partial() })
    const w1 = (await api('/payouts/paypal/W1/lines')).body.data
    expect(w1.map((l: any) => [l.id, l.type, l.category, l.net.amount])).toEqual([
      ['P1', 'T0006', 'charge', 9700],
      ['carry_out:W1', 'carry_out', 'balance', -5700],
    ])
    expect(w1[1]).toEqual({
      id: 'carry_out:W1', type: 'carry_out', category: 'balance', source_id: 'W1', order_id: null, order_number: null, payment_reference: null,
      gross: { amount: -5700, currency: 'usd' }, fee: { amount: 0, currency: 'usd' }, net: { amount: -5700, currency: 'usd' }, fee_details: [],
      created_at: '2026-10-03T09:00:00Z', available_on: null, description: 'PayPal balance left after this withdrawal',
    })
    expect(sumNet(w1)).toBe(4000)
    const w2 = (await api('/payouts/paypal/W2/lines')).body.data
    expect(w2.map((l: any) => [l.id, l.category, l.net.amount])).toEqual([['carry_in:W1', 'balance', 5700], ['P2', 'charge', 2000]])
    expect(w2[0]).toMatchObject({ type: 'carry_in', source_id: 'W1', gross: { amount: 5700 }, fee: { amount: 0 } })
    expect(sumNet(w2)).toBe(7700)
    // line_count counts the carry lines, in the list and on GET.
    expect((await api('/payouts/paypal/W1')).body.data.line_count).toBe(2)
    const list = await api('/payouts?provider=paypal&created_since=2026-09-25T00:00:00Z')
    expect(list.body.data.map((p: any) => [p.id, p.line_count])).toEqual([['W0', null], ['W1', 2], ['W2', 2]])
  })

  it('no ending_balance on a needed boundary: no carry lines (the consumer holds the payout)', async () => {
    const { api } = await paypalRig({ txns: partial({ w1Balance: '' }) })
    const w1 = (await api('/payouts/paypal/W1/lines')).body.data
    expect(w1.map((l: any) => l.id)).toEqual(['P1'])
    expect(sumNet(w1)).toBe(9700) // ≠ 4000: not balanced, and no carry line pretends it is
    const w2 = (await api('/payouts/paypal/W2/lines')).body.data
    expect(w2.map((l: any) => l.id)).toEqual(['P2'])
  })

  it('balances that do not reconcile with the lines give no carry lines, never a plug', async () => {
    const { api } = await paypalRig({ txns: partial({ w1Balance: '50.00' }) })
    expect((await api('/payouts/paypal/W1/lines')).body.data.map((l: any) => l.id)).toEqual(['P1'])
  })

  it('a withdrawal that empties the balance gets no zero carry lines', async () => {
    const { api } = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-5.00', { balance: '0.00' }),
        pp('P1', 'T0006', '2026-10-02T09:00:00Z', '100.00', { fee: '-3.00', balance: '97.00' }),
        pp('W1', 'T0400', '2026-10-03T09:00:00Z', '-97.00', { balance: '0.00' }),
      ],
    })
    expect((await api('/payouts/paypal/W1/lines')).body.data.map((l: any) => l.id)).toEqual(['P1'])
  })
})

describe('paypal delayed settlement (eCheck)', () => {
  /** An eCheck initiated before W1 that cleared after it (updated 10-06): its money went out with W2. */
  const echeck = (extra: PPTxn[] = [], o: PPOpts = { instrument: 'BANK', subInstrument: 'ECHECK' }): PPTxn[] => [
    pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
    pp('ECHK', 'T0006', '2026-10-02T10:00:00Z', '50.00', { fee: '-1.50', custom: 'ord_E', updated: '2026-10-06T10:00:00Z', ...o }),
    pp('PAY', 'T0006', '2026-10-03T10:00:00Z', '20.00'),
    pp('W1', 'T0400', '2026-10-04T09:00:00Z', '-20.00'),
    pp('W2', 'T0400', '2026-10-08T09:00:00Z', '-48.50'),
    ...extra,
  ]

  it('withdrawal mode: grouped by when it cleared, so it is in the later withdrawal', async () => {
    const { api } = await paypalRig({ txns: echeck() })
    const w1 = (await api('/payouts/paypal/W1/lines')).body.data
    expect(w1.map((l: any) => l.id)).toEqual(['PAY'])
    expect(sumNet(w1)).toBe(2000)
    const w2 = (await api('/payouts/paypal/W2/lines')).body.data
    expect(w2.map((l: any) => [l.id, l.created_at])).toEqual([['ECHK', '2026-10-02T10:00:00Z']])
    expect(sumNet(w2)).toBe(4850)
    const list = await api('/payouts?provider=paypal&created_since=2026-10-01T00:00:00Z')
    expect(list.body.data.map((p: any) => [p.id, p.line_count])).toEqual([['W0', null], ['W1', 1], ['W2', 1]])
  })

  it('balance mode: in the day it cleared, not the day it started', async () => {
    const { api } = await paypalRig({ txns: echeck() })
    const days = (await api('/payouts?provider=paypal&paypal_mode=balance&created_since=2026-10-01T00:00:00Z')).body.data
    expect(days.map((p: any) => [p.id, p.amount.amount])).toEqual([['day-2026-10-03-USD', 2000], ['day-2026-10-06-USD', 4850]])
    expect((await api('/payouts/paypal/day-2026-10-06-USD/lines')).body.data.map((l: any) => l.id)).toEqual(['ECHK'])
    expect((await api('/payouts/paypal/day-2026-10-02-USD')).status).toBe(404)
  })

  it('instrument_type BANK alone counts when it cleared a day or more later; an instant transfer or a card does not', async () => {
    const bank = await paypalRig({ txns: echeck([], { instrument: 'BANK' }) })
    expect((await bank.api('/payouts/paypal/W2/lines')).body.data.map((l: any) => l.id)).toEqual(['ECHK'])
    const card = await paypalRig({ txns: echeck([], { instrument: 'CREDIT_CARD' }) })
    expect((await card.api('/payouts/paypal/W1/lines')).body.data.map((l: any) => l.id)).toEqual(['ECHK', 'PAY'])
    const instant = await paypalRig({
      txns: [
        pp('W0', 'T0400', '2026-10-01T09:00:00Z', '-1.00'),
        // Updated two hours after it started (less than a day): an instant transfer, grouped by its start.
        pp('BNK', 'T0006', '2026-10-03T08:00:00Z', '20.00', { instrument: 'BANK', updated: '2026-10-03T10:00:00Z' }),
        pp('W1', 'T0400', '2026-10-04T09:00:00Z', '-20.00'),
      ],
    })
    expect((await instant.api('/payouts/paypal/W1/lines')).body.data.map((l: any) => l.id)).toEqual(['BNK'])
  })

  it('a payment something references (a refund after the withdrawal) keeps its initiation date', async () => {
    const { api } = await paypalRig({ txns: echeck([pp('REFE', 'T1107', '2026-10-05T10:00:00Z', '-10.00', { ref: 'ECHK' })]) })
    // The refund is after W1, but W1's read looks ahead for it.
    expect((await api('/payouts/paypal/W1/lines')).body.data.map((l: any) => l.id)).toEqual(['ECHK', 'PAY'])
    expect((await api('/payouts/paypal/W2/lines')).body.data.map((l: any) => l.id)).toEqual(['REFE'])
  })
})

describe('payout accounts on the list', () => {
  it('names every payout-capable provider\'s account; one that cannot be read is left out', async () => {
    const { store, adapter: paypal } = await paypalRig()
    const stripe = stripePayments({ stripe: fakeStripe(stripeData()).stripe, webhookSecret: 'whsec' })
    const api = client(store, [stripe, paypal, manualPayments()])
    const res = await api('/payouts?provider=paypal&created_since=2026-10-01T00:00:00Z')
    expect(res.body.accounts).toEqual([
      { provider: 'paypal', account_id: 'MERCHANTPAYER1' },
      { provider: 'stripe', account_id: 'acct_1ExAmPlE00000000' },
    ])

    const denied = fakeStripe({ payouts: [], txns: {} })
    denied.raw.accounts.retrieve.mockRejectedValue(Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError', statusCode: 403 }))
    const noStripeAccount = client(store, [stripePayments({ stripe: denied.stripe, webhookSecret: 'whsec' }), paypal])
    const listed = await noStripeAccount('/payouts?created_since=2026-10-01T00:00:00Z')
    expect(listed.status).toBe(200)
    expect(listed.body.accounts).toEqual([{ provider: 'paypal', account_id: 'MERCHANTPAYER1' }])
  })
})

// ── Both ───────────────────────────────────────────────────────────────────────────────────

describe('payouts across processors', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const clock = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
  }

  it('merges stripe and paypal oldest first and pages without gaps or repeats', async () => {
    clock('2026-11-04T00:00:00Z')
    const { store, adapter: paypal } = await paypalRig()
    const stripe = stripePayments({ stripe: fakeStripe(stripeData()).stripe, webhookSecret: 'whsec' })
    const api = client(store, [stripe, paypal, manualPayments()])
    const ids: string[] = []
    let cursor: string | null = null
    let providers: string[] = []
    do {
      const res: any = await api(`/payouts?created_since=2026-10-01T00:00:00Z&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.status).toBe(200)
      providers = res.body.providers
      ids.push(...res.body.data.map((p: any) => `${p.provider}:${p.id}`))
      cursor = res.body.next_cursor
    } while (cursor)
    expect(providers).toEqual(['paypal', 'stripe'])
    expect(ids).toEqual([
      'stripe:po_refund', 'paypal:W2', 'stripe:po_dispute', 'stripe:po_debit', 'stripe:po_manual', 'paypal:W3', 'stripe:po_1ExAmPlE0000000000Payout',
    ])
  })

  it('pages same-second payouts of two processors one at a time without skipping or repeating', async () => {
    clock('2026-11-02T12:00:00Z')
    const at = '2026-10-15T00:00:00Z'
    const { store, adapter: paypal } = await paypalRig({ txns: [pp('z', 'T0400', at, '-10.00')] })
    const stripe = stripePayments({ stripe: fakeStripe({ payouts: [synthPayout('po_A', 1000, at)], txns: {} }).stripe, webhookSecret: 'whsec' })
    const api = client(store, [stripe, paypal])
    const ids: string[] = []
    let cursor: string | null = null
    do {
      const res: any = await api(`/payouts?created_since=2026-10-01T00:00:00Z&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.status).toBe(200)
      ids.push(...res.body.data.map((p: any) => `${p.provider}:${p.id}`))
      cursor = res.body.next_cursor
    } while (cursor)
    // (created_at, provider, id): paypal before stripe at the same second, though "po_A" < "z".
    expect(ids).toEqual(['paypal:z', 'stripe:po_A'])
  })

  it('a merged list stops every processor at one cutoff, kept by its cursor, so a late PayPal withdrawal is never skipped', async () => {
    clock('2026-11-02T12:00:00Z')
    const { store, adapter: paypal } = await paypalRig({
      txns: [pp('W0', 'T0400', '2026-11-02T06:00:00Z', '-1.00'), pp('WLATE', 'T0400', '2026-11-02T09:00:01Z', '-2.00')],
      adapter: { now: () => new Date() },
    })
    const stripe = stripePayments({
      stripe: fakeStripe({
        payouts: [synthPayout('po_7', 700, '2026-11-02T07:00:00Z'), synthPayout('po_8', 800, '2026-11-02T08:00:00Z'), synthPayout('po_11', 1100, '2026-11-02T11:00:00Z')],
        txns: {},
      }).stripe,
      webhookSecret: 'whsec',
    })
    const api = client(store, [stripe, paypal])
    const ids = (res: any) => res.body.data.map((p: any) => `${p.provider}:${p.id}`)
    const since = '2026-11-01T00:00:00Z'

    // 12:00:00 — cutoff 09:00:00 for both processors: the 11:00 Stripe payout is not served yet.
    const first = await api(`/payouts?created_since=${since}&limit=2`)
    expect(ids(first)).toEqual(['paypal:W0', 'stripe:po_7'])
    vi.setSystemTime(new Date('2026-11-02T12:00:02Z'))
    // Two seconds later the next page keeps the first page's cutoff.
    const second = await api(`/payouts?created_since=${since}&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
    expect(ids(second)).toEqual(['stripe:po_8'])
    expect(second.body.next_cursor).toBeNull()

    // The next run, from where the consumer stopped, finds the PayPal withdrawal before any later payout.
    const next = await api(`/payouts?created_since=2026-11-02T08:00:00Z`)
    expect(ids(next)).toEqual(['stripe:po_8', 'paypal:WLATE'])
    vi.setSystemTime(new Date('2026-11-02T14:00:01Z'))
    expect(ids(await api(`/payouts?created_since=2026-11-02T08:00:00Z`))).toEqual(['stripe:po_8', 'paypal:WLATE', 'stripe:po_11'])

    // A Stripe-only list is not held back.
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
    expect(ids(await api(`/payouts?provider=stripe&created_since=${since}`))).toEqual(['stripe:po_7', 'stripe:po_8', 'stripe:po_11'])
  })

  it('the cursor freezes the default lower bound: a later page does not recompute "90 days ago"', async () => {
    clock('2026-11-02T12:00:00Z')
    const edge = new Date(Date.parse('2026-11-02T12:00:00Z') - 90 * 86_400_000 + 1000).toISOString().replace('.000Z', 'Z')
    const { store } = rig()
    const stripe = stripePayments({ stripe: fakeStripe({ payouts: [synthPayout('po_a', 100, edge), synthPayout('po_b', 200, edge)], txns: {} }).stripe, webhookSecret: 'whsec' })
    const api = client(store, [stripe])
    for (const path of ['/payouts?limit=1', '/payouts?provider=stripe&limit=1']) {
      vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
      const first = await api(path)
      expect(first.body.data.map((p: any) => p.id)).toEqual(['po_a'])
      vi.setSystemTime(new Date('2026-11-02T12:00:02Z'))
      const second = await api(`${path}&cursor=${encodeURIComponent(first.body.next_cursor)}`)
      expect(second.body.data.map((p: any) => p.id)).toEqual(['po_b'])
    }
  })

  it('a merged cutoff follows the configured PayPal lag (6 h), so its withdrawal is not skipped', async () => {
    clock('2026-11-02T12:00:00Z')
    const { store, adapter: paypal } = await paypalRig({
      txns: [pp('W7', 'T0400', '2026-11-02T07:00:00Z', '-7.00')],
      adapter: { now: () => new Date(), reportingLagMs: 6 * 3_600_000 },
    })
    const stripe = stripePayments({
      stripe: fakeStripe({
        payouts: [synthPayout('po_5', 500, '2026-11-02T05:00:00Z'), synthPayout('po_8', 800, '2026-11-02T08:00:00Z'), synthPayout('po_9', 900, '2026-11-02T09:00:00Z')],
        txns: {},
      }).stripe,
      webhookSecret: 'whsec',
    })
    const api = client(store, [stripe, paypal])
    const ids = (res: any) => res.body.data.map((p: any) => `${p.provider}:${p.id}`)
    // Cutoff 06:00 for both: Stripe does not run ahead to 08:00 / 09:00.
    expect(ids(await api('/payouts?created_since=2026-11-02T00:00:00Z'))).toEqual(['stripe:po_5'])
    vi.setSystemTime(new Date('2026-11-02T13:00:01Z'))
    expect(ids(await api('/payouts?created_since=2026-11-02T05:00:00Z'))).toEqual(['stripe:po_5', 'paypal:W7'])
    vi.setSystemTime(new Date('2026-11-02T15:00:00Z'))
    expect(ids(await api('/payouts?created_since=2026-11-02T05:00:00Z'))).toEqual(['stripe:po_5', 'paypal:W7', 'stripe:po_8', 'stripe:po_9'])
  })

  it('answers 404 for an unknown or payout-less provider and an empty list when there are none', async () => {
    const { store } = rig()
    const api = client(store, [manualPayments()])
    expect((await api('/payouts')).body).toEqual({ data: [], next_cursor: null, providers: [], accounts: [] })
    const res = await api('/payouts?provider=manual')
    expect(res.status).toBe(404)
    expect((await api('/payouts/stripe/po_1')).status).toBe(404)
  })
})
