import type { StorefrontConfig } from '../config'
import type { Database } from '../db/driver'
import type { MailAdapter } from '../mail/types'

/** Environment the store reads. Every key is optional; missing ones degrade to safe defaults. */
export interface StoreEnv {
  /** Absolute public origin used in emails and return URLs. Defaults to config.url. */
  PUBLIC_SITE_URL?: string
  /** HMAC key for session and magic-link hashes. */
  SESSION_SECRET?: string
  /** Merchant address that hears about every paid order. */
  ORDER_NOTIFICATION_EMAIL?: string
  [key: string]: string | undefined
}

export interface StoreContext {
  db: Database
  config: StorefrontConfig
  env: StoreEnv
  mail: MailAdapter
  /** ISO timestamp, injectable for tests. */
  now(): string
  siteUrl: string
  log(message: string, data?: unknown): void
}

/** Split an IN (...) list so no statement exceeds D1's bound-parameter limit. */
export function chunk<T>(items: T[], size = 80): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(',')

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
