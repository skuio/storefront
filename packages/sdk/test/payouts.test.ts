import { describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { handleStoreApi } from '../src/api'
import { manualPayments } from '../src/payments/manual'
import { paypalLineCategory, paypalPayments } from '../src/payments/paypal'
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
      list: vi.fn(async (params: { payout: string; starting_after?: string; limit?: number }) => {
        if (d.fail?.balance) throw d.fail.balance
        const rows = d.txns[params.payout]
        if (!rows) throw Object.assign(new Error('No such payout'), { type: 'StripeInvalidRequestError', statusCode: 400 })
        return page(rows, params)
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

    const debit = (await api('/payouts/stripe/po_debit/lines')).body.data
    // A refund of a charge paid out earlier reads that charge once.
    expect(fake.raw.charges.retrieve.mock.calls).toEqual([['ch_C']])
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
const pp = (id: string, code: string, date: string, value: string, opts: { fee?: string; currency?: string; status?: string; custom?: string; ref?: string } = {}): PPTxn => ({
  transaction_info: {
    transaction_id: id,
    transaction_event_code: code,
    transaction_initiation_date: date.replace('Z', '+0000'),
    transaction_amount: { currency_code: opts.currency ?? 'USD', value },
    ...(opts.fee ? { fee_amount: { currency_code: opts.currency ?? 'USD', value: opts.fee } } : {}),
    transaction_status: opts.status ?? 'S',
    ...(opts.custom ? { custom_field: opts.custom } : {}),
    ...(opts.ref ? { paypal_reference_id: opts.ref } : {}),
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

function fakePayPal(txns: PPTxn[], opts: { userinfo?: number; search?: number; pageSize?: number } = {}) {
  const calls: string[] = []
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    calls.push(url.pathname + url.search)
    if (url.pathname === '/v1/oauth2/token') return Response.json({ access_token: 'T', expires_in: 3600 })
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
      const size = opts.pageSize ?? Number(q.get('page_size'))
      const n = Number(q.get('page'))
      return Response.json({
        account_number: 'MERCHANTPAYER1',
        transaction_details: rows.slice((n - 1) * size, n * size),
        page: n,
        total_pages: Math.max(1, Math.ceil(rows.length / size)),
      })
    }
    return new Response('no route', { status: 599 })
  })
  return { fetch: impl as unknown as typeof fetch, calls }
}

async function paypalRig(opts: Parameters<typeof fakePayPal>[1] = {}) {
  const { store } = rig()
  await seed(store)
  const order = await placeOrder(store)
  const fake = fakePayPal(paypalTxns(order.id), { pageSize: 3, ...opts })
  const adapter = paypalPayments({ clientId: 'CLIENT_ID', clientSecret: 's', webhookId: 'W', environment: 'live', fetch: fake.fetch, now: () => new Date('2026-11-02T12:00:00Z') })
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

  it('maps T-codes to categories', () => {
    expect(paypalLineCategory('T0006')).toBe('charge')
    expect(paypalLineCategory('T0700')).toBe('charge')
    expect(paypalLineCategory('T1107')).toBe('refund')
    expect(paypalLineCategory('T1201')).toBe('dispute')
    expect(paypalLineCategory('T1108')).toBe('dispute_reversal')
    expect(paypalLineCategory('T0106')).toBe('fee')
    expect(paypalLineCategory('T1501')).toBe('reserve')
    expect(paypalLineCategory('T0200')).toBe('adjustment')
    expect(paypalLineCategory('T0300')).toBe('transfer')
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
})

// ── Both ───────────────────────────────────────────────────────────────────────────────────

describe('payouts across processors', () => {
  it('merges stripe and paypal oldest first and pages without gaps or repeats', async () => {
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

  it('answers 404 for an unknown or payout-less provider and an empty list when there are none', async () => {
    const { store } = rig()
    const api = client(store, [manualPayments()])
    expect((await api('/payouts')).body).toEqual({ data: [], next_cursor: null, providers: [] })
    const res = await api('/payouts?provider=manual')
    expect(res.status).toBe(404)
    expect((await api('/payouts/stripe/po_1')).status).toBe(404)
  })
})
