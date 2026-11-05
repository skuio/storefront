import { afterEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { handleStoreApi } from '../src/api'
import { manualPayments } from '../src/payments/manual'
import { paypalPayments } from '../src/payments/paypal'
import { stripeLineCategory, stripeMethodLabel, stripePayments } from '../src/payments/stripe'
import { comparePayouts, isAfter, isoSeconds, isWithin, type PaymentAdapter, type PaymentPayouts, type Payout } from '../src/payments'
import type { Store } from '../src/store'
import { rig } from './helpers'

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
  payment_method_details: { type: 'card', card: { brand: 'visa' } },
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
      payment_method: { type: 'card', label: 'Card' },
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
    expect(byId.txn_billing).toMatchObject({ type: 'stripe_fee', category: 'fee', source_id: null, order_id: null, order_number: null, payment_method: null, net: { amount: -200 } })
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

  it('names the method each line was paid with, read from the expanded source in the same one request', async () => {
    const data = stripeData()
    const affirm = { id: 'py_1ExAmPlE00000000000Affirm', object: 'charge', payment_intent: 'pi_M1', metadata: { order_id: 'ord_M1', order_number: '201' }, payment_method_details: { type: 'affirm', affirm: {} } }
    const cashapp = { id: 'py_1ExAmPlE0000000000Cashapp', object: 'charge', payment_intent: 'pi_M2', metadata: { order_id: 'ord_M2', order_number: '202' }, payment_method_details: { type: 'cashapp', cashapp: {} } }
    const card = { id: 'ch_M3', object: 'charge', payment_intent: 'pi_M3', metadata: { order_id: 'ord_M3', order_number: '203' }, payment_method_details: { type: 'card', card: { brand: 'amex' } } }
    const bare = { id: 'ch_M4', object: 'charge', payment_intent: 'pi_M4', metadata: { order_id: 'ord_M4', order_number: '204' } }
    data.payouts.push(synthPayout('po_methods', 68600, '2026-10-25T00:00:00Z'))
    data.charges = { ...data.charges, [affirm.id]: affirm }
    data.txns.po_methods = [
      bt('txn_po_methods', 'payout', -(68600), 0, '2026-10-25T00:00:00Z', 'po_methods', 'payout'),
      bt('txn_refund_affirm', 'payment_refund', -4000, 0, '2026-10-24T00:00:00Z', { id: 'pyr_1', object: 'refund', charge: affirm.id }, 'refund'),
      bt('txn_bare', 'charge', 10000, 320, '2026-10-23T00:00:00Z', bare),
      bt('txn_card', 'charge', 20000, 610, '2026-10-22T00:00:00Z', card),
      bt('txn_cashapp', 'payment', 15000, 465, '2026-10-21T00:00:00Z', cashapp, 'charge'),
      bt('txn_affirm', 'payment', 30000, 1005, '2026-10-20T00:00:00Z', affirm, 'charge'),
    ]
    const { api, fake } = stripeRig(data)
    const lines = (await api('/payouts/stripe/po_methods/lines')).body.data
    const byId = Object.fromEntries(lines.map((l: any) => [l.id, l]))
    expect(byId.txn_affirm).toMatchObject({ type: 'payment', category: 'charge', source_id: affirm.id, payment_method: { type: 'affirm', label: 'Affirm' } })
    expect(byId.txn_cashapp.payment_method).toEqual({ type: 'cashapp', label: 'Cash App Pay' })
    expect(byId.txn_card).toMatchObject({ type: 'charge', payment_method: { type: 'card', label: 'Card' } })
    // A refund names the method of the payment it gives back.
    expect(byId.txn_refund_affirm).toMatchObject({ category: 'refund', order_id: 'ord_M1', payment_method: { type: 'affirm', label: 'Affirm' } })
    // No payment_method_details: null, never a guess.
    expect(byId.txn_bare.payment_method).toBeNull()
    expect(sumNet(lines)).toBe(68600)
    // Still one Stripe request for the page: the method rides on the expanded source.
    expect(fake.raw.balanceTransactions.list).toHaveBeenCalledTimes(1)
    expect(fake.raw.charges.retrieve).not.toHaveBeenCalled()
  })

  it('labels Stripe payment method types for people', () => {
    expect(stripeMethodLabel('card')).toBe('Card')
    expect(stripeMethodLabel('affirm')).toBe('Affirm')
    expect(stripeMethodLabel('klarna')).toBe('Klarna')
    expect(stripeMethodLabel('afterpay_clearpay')).toBe('Afterpay / Clearpay')
    expect(stripeMethodLabel('cashapp')).toBe('Cash App Pay')
    expect(stripeMethodLabel('link')).toBe('Link')
    expect(stripeMethodLabel('us_bank_account')).toBe('ACH bank debit')
    expect(stripeMethodLabel('mobilepay')).toBe('Mobilepay')
    expect(stripeMethodLabel('some_new_method')).toBe('Some new method')
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

// ── Across processors ──────────────────────────────────────────────────────────────────────
//
// Stripe is the only built-in payout provider. The merged list, its cursor and `accounts` are generic,
// so they are exercised with Stripe plus a minimal in-memory payouts adapter ("acme").

function fakePayouts(id: string, payouts: { id: string; createdAt: string }[], opts: { lagMs?: number; account?: string | null | Error } = {}): PaymentAdapter {
  const toPayout = (p: { id: string; createdAt: string }): Payout => ({
    id: p.id, provider: id, accountId: 'acme_acct', status: 'paid', amount: { amount: 100, currency: 'usd' }, arrivalDate: p.createdAt.slice(0, 10),
    createdAt: p.createdAt, method: 'standard', destinationLabel: null, lineCount: 0,
  })
  const payoutsCapability: PaymentPayouts = {
    ...(opts.lagMs ? { reportingLagMs: opts.lagMs } : {}),
    async list({ createdSince, after, limit, until, asOf }) {
      // Like a processor that reports late: only payouts older than its lag, as of the run's clock.
      const horizon = isoSeconds(new Date(Math.min(asOf ?? Date.now(), Date.now()) - (opts.lagMs ?? 0)))
      const all = payouts.map(toPayout).filter((p) => p.createdAt >= createdSince && p.createdAt <= horizon && isAfter(p, after) && isWithin(p, until)).sort(comparePayouts)
      return { payouts: all.slice(0, limit), hasMore: all.length > limit }
    },
    async get(payoutId) {
      const p = payouts.find((x) => x.id === payoutId)
      return p ? toPayout(p) : null
    },
    async lines() {
      return { lines: [], nextCursor: null }
    },
    async account() {
      if (opts.account instanceof Error) throw opts.account
      return opts.account === undefined ? 'acme_acct' : opts.account
    },
  }
  return { id, label: id, start: async () => ({ kind: 'instructions', html: '' }), handleWebhook: async () => [], payouts: payoutsCapability }
}

describe('payouts across processors', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  const clock = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
  }
  const ids = (res: any) => res.body.data.map((p: any) => `${p.provider}:${p.id}`)

  it('merges providers oldest first and pages without gaps or repeats', async () => {
    clock('2026-11-04T00:00:00Z')
    const { store } = rig()
    const stripe = stripePayments({ stripe: fakeStripe(stripeData()).stripe, webhookSecret: 'whsec' })
    const acme = fakePayouts('acme', [{ id: 'a1', createdAt: '2026-10-10T09:00:00Z' }, { id: 'a2', createdAt: '2026-10-25T09:00:00Z' }])
    const api = client(store, [stripe, acme, manualPayments()])
    const seen: string[] = []
    let cursor: string | null = null
    let providers: string[] = []
    do {
      const res: any = await api(`/payouts?created_since=2026-10-01T00:00:00Z&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.status).toBe(200)
      providers = res.body.providers
      seen.push(...ids(res))
      cursor = res.body.next_cursor
    } while (cursor)
    expect(providers).toEqual(['acme', 'stripe'])
    expect(seen).toEqual([
      'stripe:po_refund', 'acme:a1', 'stripe:po_dispute', 'stripe:po_debit', 'stripe:po_manual', 'acme:a2', 'stripe:po_1ExAmPlE0000000000Payout',
    ])
  })

  it('pages same-second payouts of two providers one at a time without skipping or repeating', async () => {
    clock('2026-11-02T12:00:00Z')
    const at = '2026-10-15T00:00:00Z'
    const { store } = rig()
    const stripe = stripePayments({ stripe: fakeStripe({ payouts: [synthPayout('po_A', 1000, at)], txns: {} }).stripe, webhookSecret: 'whsec' })
    const api = client(store, [stripe, fakePayouts('acme', [{ id: 'z', createdAt: at }])])
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const res: any = await api(`/payouts?created_since=2026-10-01T00:00:00Z&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      expect(res.status).toBe(200)
      seen.push(...ids(res))
      cursor = res.body.next_cursor
    } while (cursor)
    // (created_at, provider, id): acme before stripe at the same second, though "po_A" < "z".
    expect(seen).toEqual(['acme:z', 'stripe:po_A'])
  })

  it('a merged list stops every provider at one cutoff, kept by its cursor, so a late-reporting provider is never skipped', async () => {
    clock('2026-11-02T12:00:00Z')
    const { store } = rig()
    const acme = fakePayouts('acme', [{ id: 'A0', createdAt: '2026-11-02T06:00:00Z' }, { id: 'ALATE', createdAt: '2026-11-02T09:00:01Z' }], { lagMs: 3 * 3_600_000 })
    const stripe = stripePayments({
      stripe: fakeStripe({
        payouts: [synthPayout('po_7', 700, '2026-11-02T07:00:00Z'), synthPayout('po_8', 800, '2026-11-02T08:00:00Z'), synthPayout('po_11', 1100, '2026-11-02T11:00:00Z')],
        txns: {},
      }).stripe,
      webhookSecret: 'whsec',
    })
    const api = client(store, [stripe, acme])
    const since = '2026-11-01T00:00:00Z'
    // 12:00:00 — cutoff 09:00:00 for both: the 11:00 Stripe payout is not served yet.
    const first = await api(`/payouts?created_since=${since}&limit=2`)
    expect(ids(first)).toEqual(['acme:A0', 'stripe:po_7'])
    vi.setSystemTime(new Date('2026-11-02T12:00:02Z'))
    const second = await api(`/payouts?created_since=${since}&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`)
    expect(ids(second)).toEqual(['stripe:po_8'])
    expect(second.body.next_cursor).toBeNull()
    // The next run, from where the consumer stopped, finds the late payout before any later one.
    expect(ids(await api(`/payouts?created_since=2026-11-02T08:00:00Z`))).toEqual(['stripe:po_8', 'acme:ALATE'])
    vi.setSystemTime(new Date('2026-11-02T14:00:01Z'))
    expect(ids(await api(`/payouts?created_since=2026-11-02T08:00:00Z`))).toEqual(['stripe:po_8', 'acme:ALATE', 'stripe:po_11'])
    // A Stripe-only list is not held back.
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'))
    expect(ids(await api(`/payouts?provider=stripe&created_since=${since}`))).toEqual(['stripe:po_7', 'stripe:po_8', 'stripe:po_11'])
  })

  it('a Stripe run reads as of its first page: a payout made after it waits for the next run', async () => {
    clock('2026-11-02T12:00:00Z')
    const { store } = rig()
    const data: FakeStripeData = { payouts: [synthPayout('po_a', 100, '2026-11-02T10:00:00Z'), synthPayout('po_b', 200, '2026-11-02T11:00:00Z')], txns: {} }
    const api = client(store, [stripePayments({ stripe: fakeStripe(data).stripe, webhookSecret: 'whsec' })])
    const base = '/payouts?provider=stripe&created_since=2026-11-02T00:00:00Z'
    const first = await api(`${base}&limit=1`)
    expect(ids(first)).toEqual(['stripe:po_a'])
    data.payouts.push(synthPayout('po_c', 300, '2026-11-02T12:00:30Z'))
    vi.setSystemTime(new Date('2026-11-02T12:01:00Z'))
    const second = await api(`${base}&limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`)
    expect(ids(second)).toEqual(['stripe:po_b'])
    expect(second.body.next_cursor).toBeNull()
    expect(ids(await api(base))).toEqual(['stripe:po_a', 'stripe:po_b', 'stripe:po_c'])
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

  it('names every payout-capable provider\'s account; one that cannot be read is left out', async () => {
    const { store } = rig()
    const stripe = stripePayments({ stripe: fakeStripe(stripeData()).stripe, webhookSecret: 'whsec' })
    const res = await client(store, [stripe, fakePayouts('acme', [], { account: null }), manualPayments()])('/payouts?provider=stripe&created_since=2026-10-01T00:00:00Z')
    expect(res.body.accounts).toEqual([{ provider: 'stripe', account_id: 'acct_1ExAmPlE00000000' }])

    const denied = fakeStripe({ payouts: [], txns: {} })
    denied.raw.accounts.retrieve.mockRejectedValue(Object.assign(new Error('The provided key does not have the required permissions'), { type: 'StripePermissionError', statusCode: 403 }))
    const listed = await client(store, [stripePayments({ stripe: denied.stripe, webhookSecret: 'whsec' }), fakePayouts('acme', [], { account: new Error('down') })])('/payouts?created_since=2026-10-01T00:00:00Z')
    expect(listed.status).toBe(200)
    expect(listed.body.accounts).toEqual([])
    const withAcme = await client(store, [fakePayouts('acme', [])])('/payouts')
    expect(withAcme.body.accounts).toEqual([{ provider: 'acme', account_id: 'acme_acct' }])
  })

  it('PayPal is not a payout provider: it books per order, so /payouts/paypal is 404', async () => {
    const { store } = rig()
    const paypal = paypalPayments({ clientId: 'CLIENT_ID', clientSecret: 's', webhookId: 'W', environment: 'live', fetch: (async () => new Response('no', { status: 599 })) as unknown as typeof fetch })
    const api = client(store, [paypal])
    expect(paypal.payouts).toBeUndefined()
    expect((await api('/payouts')).body).toEqual({ data: [], next_cursor: null, providers: [], accounts: [] })
    expect((await api('/payouts?provider=paypal')).status).toBe(404)
    expect((await api('/payouts/paypal/W1')).status).toBe(404)
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
