import type { StorefrontConfig } from '../config'
import type { Database } from '../db/driver'
import { consoleMail } from '../mail/console'
import type { MailAdapter } from '../mail/types'
import { CatalogService } from './catalog'
import { CheckoutService } from './checkout'
import { ConnectionsService } from './connections'
import { PartnersService } from './partners'
import type { StoreContext, StoreEnv } from './context'
import { CustomersService } from './customers'
import { EventsService } from './events'
import { InventoryService } from './inventory'
import { OrdersService } from './orders'
import { OwnersService } from './owners'
import { SessionsService } from './sessions'

export const STORE_PLATFORM_VERSION = '2.1.0'

export interface StoreOptions {
  db: Database
  config: StorefrontConfig
  env?: StoreEnv
  mail?: MailAdapter
  /** Injectable clock for tests. */
  clock?: () => Date
  /** How long an isolate keeps a catalog snapshot. 0 disables the cache. */
  catalogCacheTtlMs?: number
  log?: (message: string, data?: unknown) => void
}

export interface StoreHealth {
  name: string
  url: string
  currency: string
  locale: string
  version: string
  counts: { products: number; categories: number; orders: number; customers: number }
  /** True once an owner exists, so a consumer can tell the merchant to run `owner:create` first. */
  owner_configured: boolean
  time: string
}

export interface Store {
  readonly db: Database
  readonly config: StorefrontConfig
  readonly env: StoreEnv
  readonly mail: MailAdapter
  readonly siteUrl: string
  now(): string
  readonly catalog: CatalogService
  readonly inventory: InventoryService
  readonly customers: CustomersService
  readonly orders: OrdersService
  readonly checkout: CheckoutService
  readonly sessions: SessionsService
  readonly events: EventsService
  readonly owners: OwnersService
  readonly connections: ConnectionsService
  readonly partners: PartnersService
  health(): Promise<StoreHealth>
}

/**
 * The store: every service over one database. Cheap to create, so make one
 * per request (the Astro convention is `store(Astro)` in src/lib/store.ts).
 */
export function createStore(options: StoreOptions): Store {
  const env = options.env ?? {}
  const clock = options.clock ?? (() => new Date())
  const ctx: StoreContext = {
    db: options.db,
    config: options.config,
    env,
    mail: options.mail ?? consoleMail(),
    now: () => clock().toISOString(),
    siteUrl: (env.PUBLIC_SITE_URL || options.config.url).replace(/\/+$/, ''),
    log: options.log ?? ((message, data) => console.warn(message, data === undefined ? '' : JSON.stringify(data))),
  }
  const catalog = new CatalogService(ctx, options.catalogCacheTtlMs ?? 30_000)
  const inventory = new InventoryService(ctx, (skus) => catalog.existingSkus(skus), () => catalog.invalidate())
  const events = new EventsService(ctx)
  const customers = new CustomersService(ctx)
  const orders = new OrdersService(ctx, events, inventory)
  const checkout = new CheckoutService(ctx, catalog, orders, events)
  const sessions = new SessionsService(ctx, customers)
  const owners = new OwnersService(ctx)
  const connections = new ConnectionsService(ctx)
  const partners = new PartnersService(ctx)

  return {
    db: ctx.db,
    config: ctx.config,
    env,
    mail: ctx.mail,
    siteUrl: ctx.siteUrl,
    now: ctx.now,
    catalog,
    inventory,
    customers,
    orders,
    checkout,
    sessions,
    events,
    owners,
    connections,
    partners,
    async health() {
      const [counts, orderCount, customerCount, ownerCount] = await Promise.all([catalog.counts(), orders.count(), customers.count(), owners.count()])
      return {
        name: ctx.config.name,
        url: ctx.config.url,
        currency: ctx.config.currency.toUpperCase(),
        locale: ctx.config.locale,
        version: STORE_PLATFORM_VERSION,
        counts: { ...counts, orders: orderCount, customers: customerCount },
        owner_configured: ownerCount > 0,
        time: ctx.now(),
      }
    },
  }
}

export type { StoreContext, StoreEnv } from './context'
export type { Database, DbStatement, DbValue } from '../db/driver'
export { bindable } from '../db/driver'
export { StoreError, type StoreErrorCode } from './errors'
export {
  CatalogService, type ProductInput, type CategoryInput, type ProductRecord, type CategoryRecord,
  type ProductPage, type CategoryPage, type ProductListQuery, type CategoryListQuery, deriveAvailability,
} from './catalog'
export { InventoryService, type InventoryItemInput, type InventoryResult } from './inventory'
export { CustomersService, normalizeEmail } from './customers'
export { OrdersService, ABANDONED_AFTER_MINUTES, type PaymentRecord, type FulfillmentInput, type ChangedPage } from './orders'
export { CheckoutService, type CheckoutInput, type CheckoutItem, type Quote, type PricedLine } from './checkout'
export { SessionsService, type MagicLink, type Session, MAGIC_LINK_MINUTES, SESSION_DAYS } from './sessions'
export { EventsService } from './events'
export { newId, randomToken, randomBase64Url, hashToken, sha256Hex, secretsEqual } from './crypto'
export { OwnersService, normalizeOwnerEmail, type Owner, type OwnerSession, type OwnerResetLink, OWNER_SESSION_DAYS, OWNER_RESET_MINUTES } from './owners'
export {
  ConnectionsService, isLocalHost, type Connection, type AuthorizeParams, type AuthorizeRequest, type IssuedKey, type ConnectScope,
  CONNECT_CODE_MINUTES, CONNECT_SCOPES, SCOPE_DESCRIPTIONS, API_KEY_PREFIX,
} from './connections'
export { hashPassword, verifyPassword, passwordProblem, PASSWORD_MIN_LENGTH, PASSWORD_ITERATIONS } from './password'
export { RateLimiter, type RateLimitPolicy } from './ratelimit'
export { PartnersService, PARTNER_LINK_MINUTES, PARTNER_SESSION_DAYS, type PartnerReport, type PartnerReportLine, type PartnerReportOptions, type PartnerTraffic, type TrafficDay, type TrafficSource, type VisitInput } from './partners'
