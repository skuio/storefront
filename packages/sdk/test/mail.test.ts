import { describe, expect, it, vi } from 'vitest'
import { consoleMail, magicLinkMail, orderConfirmationMail, sendgridMail, shippingConfirmationMail } from '../src/mail'
import { config, placeOrder, rig, seed } from './helpers'

describe('mail templates', () => {
  it('render an order confirmation with lines, totals and the status link', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store, { items: [{ sku: 'VDCTOYTAC9504', quantity: 2 }], shippingAddress: { name: 'Ada <Lovelace>', line1: '1 Way', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } })
    const mail = orderConfirmationMail(order, { config, siteUrl: 'https://store.test' })
    expect(mail.subject).toBe('Order 1001 received — Test Store')
    expect(mail.html).toContain('Ada &lt;Lovelace&gt;')
    expect(mail.html).toContain('$2,198')
    expect(mail.text).toContain('2 × Toyota Tacoma 1995-2004 Vertical Lambo Doors (VDCTOYTAC9504) — $2,198')
    expect(mail.text).toContain(`https://store.test/checkout/success/?order=${order.id}&key=${order.accessKey}`)
    const paid = await store.orders.markPaid(order.id, { provider: 'manual', reference: null }, { notify: false })
    expect(orderConfirmationMail(paid, { config, siteUrl: 'https://store.test' }).subject).toBe('Order 1001 confirmed — Test Store')
  })

  it('render shipping and magic-link mails', async () => {
    const { store } = rig()
    await seed(store)
    const order = await placeOrder(store)
    const shipping = shippingConfirmationMail(order, { id: 'ful_1', externalId: 'x', carrier: 'UPS', service: null, trackingNumber: '1Z', trackingUrl: 'https://ups.test/1Z', shippedAt: null, lines: [{ sku: 'VDCTOYTAC9504', quantity: 1 }], createdAt: '' }, { config, siteUrl: 'https://store.test' })
    expect(shipping.subject).toBe('Order 1001 has shipped — Test Store')
    expect(shipping.html).toContain('href="https://ups.test/1Z"')
    expect(shipping.text).toContain('order 1001 has shipped with UPS')
    const link = magicLinkMail({ url: 'https://store.test/account/verify/?token=abc', expiresMinutes: 15 }, { config, siteUrl: 'https://store.test' })
    expect(link.text).toContain('https://store.test/account/verify/?token=abc')
    expect(link.html).toContain('expires in 15 minutes')
  })
})

describe('mail adapters', () => {
  it('console logs the whole text body', async () => {
    const lines: string[] = []
    const adapter = consoleMail({ log: (l) => lines.push(l) })
    await adapter.send({ to: 'a@b.c', subject: 'Hi', html: '<p>x</p>', text: 'plain body' })
    expect(lines[0]).toContain('to=a@b.c')
    expect(lines[0]).toContain('plain body')
  })

  it('sendgrid posts the v3 payload and surfaces rejections', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchOk = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! })
      return new Response('', { status: 202 })
    }) as unknown as typeof fetch
    const adapter = sendgridMail({ apiKey: 'SG.x', from: { email: 'noreply@store.test', name: 'Test Store' }, fetch: fetchOk })
    await adapter.send({ to: 'a@b.c', subject: 'Hi', html: '<p>x</p>', text: 'x', replyTo: 'r@b.c' })
    expect(calls[0]!.url).toBe('https://api.sendgrid.com/v3/mail/send')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer SG.x')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      personalizations: [{ to: [{ email: 'a@b.c' }] }],
      from: { email: 'noreply@store.test', name: 'Test Store' },
      subject: 'Hi',
      content: [{ type: 'text/plain', value: 'x' }, { type: 'text/html', value: '<p>x</p>' }],
      reply_to: { email: 'r@b.c' },
    })
    const fetch403 = (async () => new Response('sender not verified', { status: 403 })) as unknown as typeof fetch
    await expect(sendgridMail({ apiKey: 'SG.x', from: { email: 'x@y.z' }, fetch: fetch403 }).send({ to: 'a@b.c', subject: 's', html: '', text: '' })).rejects.toMatchObject({ status: 403 })
  })
})
