import { HDKey } from '@scure/bip32'
import { NETWORK, p2wpkh } from '@scure/btc-signer'
import type { Order } from '../types'
import type { PaymentAdapter, PaymentContext, PaymentEvent, PaymentStart } from './index'

/**
 * On-chain bitcoin, non-custodial, with no server and no node.
 *
 * The store holds only an account-level extended PUBLIC key (a Native SegWit
 * `zpub`, e.g. a dedicated account on a Trezor). Each order is quoted a fresh
 * receive address derived from it (BIP84 m/84'/0'/n'/0/i) and an amount in
 * sats at the live price, held for `quoteMinutes`. Payment is detected
 * through a public block explorer API (mempool.space), so nothing here can
 * spend: the private keys never leave the hardware wallet.
 *
 * There is no webhook — the explorer is polled: by the payment page while the
 * buyer waits, and by `sweep()`, which the store calls opportunistically (the
 * operations system's order poll is enough to keep it moving).
 *
 * Trade-offs, stated: on-chain only (no Lightning); detection depends on the
 * explorer being reachable; refunds are sent by hand from the wallet.
 */
export interface BitcoinPaymentOptions {
  /** Account extended public key: zpub… (BIP84) or xpub… treated as BIP84. Never a private key. */
  xpub: string
  /** Block explorer API base. Default https://mempool.space/api */
  explorer?: string
  /** Confirmations before an order is paid. Default 1. */
  confirmations?: number
  /** How long a quoted amount holds. Default 30 minutes. */
  quoteMinutes?: number
  /** Underpayment tolerated, in sats (wallet rounding). Default 0.5% of the quote. */
  toleranceRatio?: number
  label?: string
  fetch?: typeof fetch
}

export interface BitcoinQuote {
  address: string
  amountSats: number
  amountBtc: string
  rate: number
  expiresAt: string
  /** BIP21 URI for the QR code. */
  uri: string
  status: 'awaiting' | 'seen' | 'paid' | 'expired' | 'underpaid'
  receivedSats: number
  txid: string | null
  confirmations: number
}

export interface BitcoinPaymentAdapter extends PaymentAdapter {
  /** The order's current quote (re-quoted at the live price if it expired unpaid). */
  quote(order: Order, ctx: PaymentContext): Promise<BitcoinQuote>
  /** Check every open quote against the explorer; returns the events to apply. */
  sweep(ctx: PaymentContext): Promise<PaymentEvent[]>
}

const PROVIDER = 'bitcoin'
const ZPUB = 0x04b24746
const XPUB = 0x0488b21e
const RECYCLE_AFTER_MS = 24 * 3600_000

interface Row {
  derivation_index: number
  address: string
  order_id: string | null
  amount_sats: number | null
  btc_usd_rate: number | null
  quoted_at: string | null
  expires_at: string | null
  txid: string | null
  received_sats: number
  paid_at: string | null
}

interface ExplorerTx {
  txid: string
  status: { confirmed: boolean; block_height?: number }
  vout: { scriptpubkey_address?: string; value: number }[]
}

/** Receive address i of a BIP84 account public key. */
export function deriveAddress(xpub: string, index: number): string {
  const version = xpub.startsWith('zpub') ? ZPUB : XPUB
  const account = HDKey.fromExtendedKey(xpub, { private: 0, public: version })
  const child = account.deriveChild(0).deriveChild(index)
  if (!child.publicKey) throw new Error('could not derive a public key')
  const address = p2wpkh(child.publicKey, NETWORK).address
  if (!address) throw new Error('could not encode address')
  return address
}

export function bitcoinPayments(options: BitcoinPaymentOptions): BitcoinPaymentAdapter {
  if (/^[xyz]prv/.test(options.xpub)) throw new Error('bitcoinPayments was given a PRIVATE key — use the account public key (zpub)')
  // Fail at startup, not at the first checkout, if the key is malformed.
  deriveAddress(options.xpub, 0)
  const explorer = (options.explorer ?? 'https://mempool.space/api').replace(/\/+$/, '')
  const http = options.fetch ?? fetch
  const need = options.confirmations ?? 1
  const quoteMs = (options.quoteMinutes ?? 30) * 60_000
  const tolerance = options.toleranceRatio ?? 0.005

  async function get<T>(path: string): Promise<T> {
    const res = await http(`${explorer}${path}`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`explorer ${path}: ${res.status}`)
    const text = await res.text()
    return (text.trim().startsWith('{') || text.trim().startsWith('[') ? JSON.parse(text) : Number(text)) as T
  }

  async function usdRate(currency: string): Promise<number> {
    const prices = await get<Record<string, number>>('/v1/prices')
    const rate = prices[currency.toUpperCase()]
    if (!rate) throw new Error(`no BTC price in ${currency}`)
    return rate
  }

  async function txsFor(address: string): Promise<ExplorerTx[]> {
    return get<ExplorerTx[]>(`/address/${address}/txs`)
  }

  /** A row for this order: its own, a recycled one, or a newly derived index. */
  async function assign(order: Order, ctx: PaymentContext): Promise<Row> {
    const db = ctx.store.db
    const now = ctx.store.now()
    const own = await db.prepare(`SELECT * FROM bitcoin_addresses WHERE order_id = ? ORDER BY derivation_index DESC LIMIT 1`).bind(order.id).first<Row>()
    if (own) return own
    // Recycle an address quoted long ago, never paid and never touched on-chain.
    const stale = await db
      .prepare(`SELECT * FROM bitcoin_addresses WHERE paid_at IS NULL AND received_sats = 0 AND txid IS NULL AND (order_id IS NULL OR expires_at < ?) ORDER BY derivation_index LIMIT 5`)
      .bind(new Date(Date.parse(now) - RECYCLE_AFTER_MS).toISOString())
      .all<Row>()
    for (const r of stale.results) {
      if ((await txsFor(r.address)).length === 0) {
        await db.prepare(`UPDATE bitcoin_addresses SET order_id = ?, amount_sats = NULL, quoted_at = NULL, expires_at = NULL, updated_at = ? WHERE derivation_index = ?`).bind(order.id, now, r.derivation_index).run()
        return { ...r, order_id: order.id, amount_sats: null, quoted_at: null, expires_at: null }
      }
    }
    const last = await db.prepare(`SELECT MAX(derivation_index) AS i FROM bitcoin_addresses`).first<{ i: number | null }>()
    const index = (last?.i ?? -1) + 1
    const address = deriveAddress(options.xpub, index)
    await db
      .prepare(`INSERT INTO bitcoin_addresses (derivation_index, address, order_id, updated_at) VALUES (?, ?, ?, ?)`)
      .bind(index, address, order.id, now)
      .run()
    return { derivation_index: index, address, order_id: order.id, amount_sats: null, btc_usd_rate: null, quoted_at: null, expires_at: null, txid: null, received_sats: 0, paid_at: null }
  }

  async function check(row: Row, ctx: PaymentContext): Promise<{ received: number; txid: string | null; confirmations: number }> {
    const txs = await txsFor(row.address)
    if (!txs.length) return { received: 0, txid: null, confirmations: 0 }
    const tip = txs.some((t) => t.status.confirmed) ? await get<number>('/blocks/tip/height') : 0
    let received = 0
    let txid: string | null = null
    let confirmations = Infinity
    for (const t of txs) {
      const value = t.vout.filter((o) => o.scriptpubkey_address === row.address).reduce((s, o) => s + o.value, 0)
      if (!value) continue
      received += value
      txid ??= t.txid
      confirmations = Math.min(confirmations, t.status.confirmed && t.status.block_height ? tip - t.status.block_height + 1 : 0)
    }
    if (received !== row.received_sats || txid !== row.txid) {
      await ctx.store.db.prepare(`UPDATE bitcoin_addresses SET received_sats = ?, txid = ?, updated_at = ? WHERE derivation_index = ?`).bind(received, txid, ctx.store.now(), row.derivation_index).run()
    }
    return { received, txid, confirmations: Number.isFinite(confirmations) ? confirmations : 0 }
  }

  function paidEnough(row: Row, received: number): boolean {
    return !!row.amount_sats && received >= Math.floor(row.amount_sats * (1 - tolerance))
  }

  async function settle(row: Row, received: number, txid: string, ctx: PaymentContext): Promise<PaymentEvent> {
    await ctx.store.db.prepare(`UPDATE bitcoin_addresses SET paid_at = ?, updated_at = ? WHERE derivation_index = ?`).bind(ctx.store.now(), ctx.store.now(), row.derivation_index).run()
    const order = await ctx.store.orders.require(row.order_id!)
    return {
      type: 'paid',
      orderId: order.id,
      provider: PROVIDER,
      reference: txid,
      methodLabel: 'Bitcoin',
      paidAt: ctx.store.now(),
      // The order total in store currency — what the quote was for. The sats received are on the row.
      amount: order.total,
    }
  }

  const adapter: BitcoinPaymentAdapter = {
    id: PROVIDER,
    label: options.label ?? 'Bitcoin (on-chain)',

    async start(order, ctx): Promise<PaymentStart> {
      await adapter.quote(order, ctx)
      return { kind: 'redirect', url: `${ctx.siteUrl}/checkout/bitcoin/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}` }
    },

    async quote(order, ctx): Promise<BitcoinQuote> {
      let row = await assign(order, ctx)
      const now = Date.parse(ctx.store.now())
      const { received, txid, confirmations } = await check(row, ctx)
      const expired = !row.expires_at || Date.parse(row.expires_at) < now
      // Re-quote only while nothing has been sent: a payment in flight keeps the price it was sent at.
      if (expired && received === 0) {
        const rate = await usdRate(order.currency)
        const amountSats = Math.ceil((order.total.amount / 100 / rate) * 1e8)
        const expiresAt = new Date(now + quoteMs).toISOString()
        await ctx.store.db
          .prepare(`UPDATE bitcoin_addresses SET amount_sats = ?, btc_usd_rate = ?, quoted_at = ?, expires_at = ?, updated_at = ? WHERE derivation_index = ?`)
          .bind(amountSats, rate, ctx.store.now(), expiresAt, ctx.store.now(), row.derivation_index)
          .run()
        row = { ...row, amount_sats: amountSats, btc_usd_rate: rate, expires_at: expiresAt }
        await ctx.store.events.record(order.id, 'checkout_session_created', { provider: PROVIDER, session: row.address })
      }
      const enough = paidEnough(row, received)
      const status: BitcoinQuote['status'] = row.paid_at || (enough && confirmations >= need) ? 'paid' : enough ? 'seen' : received > 0 ? 'underpaid' : Date.parse(row.expires_at!) < now ? 'expired' : 'awaiting'
      const amountBtc = (row.amount_sats! / 1e8).toFixed(8)
      return {
        address: row.address,
        amountSats: row.amount_sats!,
        amountBtc,
        rate: row.btc_usd_rate!,
        expiresAt: row.expires_at!,
        uri: `bitcoin:${row.address}?amount=${amountBtc}&label=${encodeURIComponent(`${ctx.store.config.name} ${ctx.store.config.orders.numberPrefix}${order.number}`)}`,
        status,
        receivedSats: received,
        txid,
        confirmations,
      }
    },

    async verifyReturn(_params, order, ctx): Promise<PaymentEvent[]> {
      const row = await ctx.store.db.prepare(`SELECT * FROM bitcoin_addresses WHERE order_id = ? AND paid_at IS NULL ORDER BY derivation_index DESC LIMIT 1`).bind(order.id).first<Row>()
      if (!row) return []
      const { received, txid, confirmations } = await check(row, ctx)
      return paidEnough(row, received) && confirmations >= need && txid ? [await settle(row, received, txid, ctx)] : []
    },

    async sweep(ctx): Promise<PaymentEvent[]> {
      const cutoff = new Date(Date.parse(ctx.store.now()) - 3 * 24 * 3600_000).toISOString()
      const { results } = await ctx.store.db
        .prepare(`SELECT * FROM bitcoin_addresses WHERE paid_at IS NULL AND order_id IS NOT NULL AND amount_sats IS NOT NULL AND quoted_at > ? ORDER BY derivation_index LIMIT 25`)
        .bind(cutoff)
        .all<Row>()
      const events: PaymentEvent[] = []
      for (const row of results) {
        try {
          const { received, txid, confirmations } = await check(row, ctx)
          if (paidEnough(row, received) && confirmations >= need && txid) events.push(await settle(row, received, txid, ctx))
        } catch (e) {
          events.push({ type: 'ignored', reason: `explorer check failed for ${row.address}: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
      return events
    },

    async handleWebhook(_request, ctx): Promise<PaymentEvent[]> {
      // No processor calls us; a POST here (e.g. a cron) just runs a sweep.
      return adapter.sweep(ctx)
    },
  }
  return adapter
}
