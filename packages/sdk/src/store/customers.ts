import type { Customer } from '../types'
import type { StoreContext } from './context'

interface CustomerRow {
  id: string
  email: string
  name: string | null
  phone: string | null
  created_at: string
  updated_at: string
}

const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id,
  email: r.email,
  name: r.name,
  phone: r.phone,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

export class CustomersService {
  constructor(private readonly ctx: StoreContext) {}

  async byId(id: string): Promise<Customer | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first<CustomerRow>()
    return row ? toCustomer(row) : null
  }

  async byEmail(email: string): Promise<Customer | null> {
    const row = await this.ctx.db.prepare(`SELECT * FROM customers WHERE email = ?`).bind(normalizeEmail(email)).first<CustomerRow>()
    return row ? toCustomer(row) : null
  }

  async count(): Promise<number> {
    const row = await this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM customers`).first<{ n: number }>()
    return row?.n ?? 0
  }
}
