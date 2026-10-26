import type { StorefrontConfig } from '../config'
import { formatMoney } from '../money'
import type { Address, Fulfillment, Order, StoreQuote } from '../types'

export interface RenderedMail {
  subject: string
  html: string
  text: string
}

export interface MailContext {
  config: StorefrontConfig
  /** Absolute origin for links, no trailing slash. */
  siteUrl: string
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function addressLines(a: Address | null | undefined): string[] {
  if (!a) return []
  return [a.name, a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(', '), a.country].filter(
    (x): x is string => !!x
  )
}

function layout(config: StorefrontConfig, title: string, bodyHtml: string, footer: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#1f2933;color:#ffffff;padding:20px 28px;font-size:18px;font-weight:700">${escapeHtml(config.name)}</td></tr>
<tr><td style="padding:28px"><h1 style="margin:0 0 16px;font-size:22px">${escapeHtml(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #e6e6e6;font-size:12px;color:#666">${footer}</td></tr>
</table></td></tr></table></body></html>`
}

function linesTable(order: Order, locale: string): string {
  const rows = order.lines
    .map(
      (l) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(l.name)}<br><span style="color:#666;font-size:12px">SKU ${escapeHtml(l.sku)} × ${l.quantity}</span></td><td align="right" style="padding:8px 0;border-bottom:1px solid #eee;white-space:nowrap">${formatMoney(l.totalAmount, locale)}</td></tr>`
    )
    .join('')
  const totals = [
    ['Subtotal', formatMoney(order.subtotal, locale)],
    ['Shipping', order.shipping.amount ? formatMoney(order.shipping, locale) : 'Free'],
    ...(order.discount.amount ? [['Discount', `−${formatMoney(order.discount, locale)}`]] : []),
    ...(order.tax.amount ? [['Tax', formatMoney(order.tax, locale)]] : []),
    ['Total', formatMoney(order.total, locale)],
  ]
    .map(([k, v], i, arr) => `<tr><td style="padding:6px 0;${i === arr.length - 1 ? 'font-weight:700' : 'color:#666'}">${k}</td><td align="right" style="padding:6px 0;${i === arr.length - 1 ? 'font-weight:700' : ''}">${v}</td></tr>`)
    .join('')
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">${rows}${totals}</table>`
}

function linesText(order: Order, locale: string): string[] {
  return [
    ...order.lines.map((l) => `${l.quantity} × ${l.name} (${l.sku}) — ${formatMoney(l.totalAmount, locale)}`),
    '',
    `Subtotal: ${formatMoney(order.subtotal, locale)}`,
    `Shipping: ${order.shipping.amount ? formatMoney(order.shipping, locale) : 'Free'}`,
    ...(order.discount.amount ? [`Discount: -${formatMoney(order.discount, locale)}`] : []),
    ...(order.tax.amount ? [`Tax: ${formatMoney(order.tax, locale)}`] : []),
    `Total:    ${formatMoney(order.total, locale)}`,
  ]
}

function contactFooter(config: StorefrontConfig): string {
  const bits = [config.contact?.phone ? `Call ${escapeHtml(config.contact.phone)}` : '', config.contact?.email ? `<a href="mailto:${escapeHtml(config.contact.email)}">${escapeHtml(config.contact.email)}</a>` : '']
    .filter(Boolean)
    .join(' · ')
  return bits ? `Questions? ${bits}` : escapeHtml(config.name)
}

export function orderConfirmationMail(order: Order, ctx: MailContext): RenderedMail {
  const { config, siteUrl } = ctx
  const number = `${config.orders.numberPrefix}${order.number}`
  const statusUrl = `${siteUrl}/checkout/success/?order=${encodeURIComponent(order.id)}&key=${encodeURIComponent(order.accessKey)}`
  const ship = addressLines(order.shippingAddress)
  const paid = order.payment.status === 'paid'
  const intro = paid
    ? `Thanks for your order. We have received your payment and will email you again when it ships.`
    : `Thanks for your order. It is reserved and will ship once payment is received.`
  const html = layout(
    config,
    `Order ${number} ${paid ? 'confirmed' : 'received'}`,
    `<p style="margin:0 0 16px;font-size:14px">${intro}</p>
${linesTable(order, config.locale)}
${ship.length ? `<h2 style="font-size:14px;margin:24px 0 6px">Shipping to</h2><p style="margin:0;font-size:14px;color:#444">${ship.map(escapeHtml).join('<br>')}</p>` : ''}
${order.shippingMethod ? `<p style="margin:12px 0 0;font-size:13px;color:#666">${escapeHtml(order.shippingMethod.name)}</p>` : ''}
<p style="margin:24px 0 0;font-size:14px"><a href="${escapeHtml(statusUrl)}" style="color:#0f6fff">View your order</a></p>`,
    contactFooter(config)
  )
  const text = [
    `${config.name} — order ${number} ${paid ? 'confirmed' : 'received'}`,
    '',
    intro,
    '',
    ...linesText(order, config.locale),
    '',
    ...(ship.length ? ['Shipping to:', ...ship, ''] : []),
    ...(order.shippingMethod ? [order.shippingMethod.name, ''] : []),
    `View your order: ${statusUrl}`,
  ].join('\n')
  return { subject: `Order ${number} ${paid ? 'confirmed' : 'received'} — ${config.name}`, html, text }
}

export function shippingConfirmationMail(order: Order, fulfillment: Fulfillment, ctx: MailContext): RenderedMail {
  const { config, siteUrl } = ctx
  const number = `${config.orders.numberPrefix}${order.number}`
  const shipped = fulfillment.lines
    .map((fl) => {
      const line = order.lines.find((l) => l.sku === fl.sku)
      return { name: line?.name ?? fl.sku, sku: fl.sku, quantity: fl.quantity }
    })
  const tracking = fulfillment.trackingNumber
    ? fulfillment.trackingUrl
      ? `<a href="${escapeHtml(fulfillment.trackingUrl)}" style="color:#0f6fff">${escapeHtml(fulfillment.trackingNumber)}</a>`
      : `<strong>${escapeHtml(fulfillment.trackingNumber)}</strong>`
    : ''
  const carrier = [fulfillment.carrier, fulfillment.service].filter(Boolean).join(' ')
  const portalUrl = `${siteUrl}/account/`
  const html = layout(
    config,
    `Order ${number} is on its way`,
    `<p style="margin:0 0 16px;font-size:14px">Good news — ${shipped.length === order.lines.length && shipped.every((s) => (order.lines.find((l) => l.sku === s.sku)?.quantity ?? 0) === s.quantity) ? 'your order' : 'part of your order'} has shipped${carrier ? ` with ${escapeHtml(carrier)}` : ''}.</p>
${tracking ? `<p style="margin:0 0 16px;font-size:14px">Tracking number: ${tracking}</p>` : ''}
<ul style="padding-left:18px;font-size:14px;margin:0 0 16px">${shipped.map((s) => `<li>${s.quantity} × ${escapeHtml(s.name)} <span style="color:#666">(${escapeHtml(s.sku)})</span></li>`).join('')}</ul>
<p style="margin:0;font-size:14px"><a href="${escapeHtml(portalUrl)}" style="color:#0f6fff">Track it in your account</a></p>`,
    contactFooter(config)
  )
  const text = [
    `${config.name} — order ${number} has shipped${carrier ? ` with ${carrier}` : ''}`,
    '',
    ...(fulfillment.trackingNumber ? [`Tracking: ${fulfillment.trackingNumber}${fulfillment.trackingUrl ? ` (${fulfillment.trackingUrl})` : ''}`, ''] : []),
    ...shipped.map((s) => `${s.quantity} × ${s.name} (${s.sku})`),
    '',
    `Track it in your account: ${portalUrl}`,
  ].join('\n')
  return { subject: `Order ${number} has shipped — ${config.name}`, html, text }
}

export function partnerSignInMail(input: { url: string; name: string; expiresMinutes: number }, ctx: MailContext): RenderedMail {
  const { config } = ctx
  const html = layout(
    config,
    'Your partner dashboard',
    `<p style="margin:0 0 16px;font-size:14px">Hi ${escapeHtml(input.name)} — click the button to open your ${escapeHtml(config.name)} partner dashboard: visits through your links, orders with your code, and your commission. The link works once and expires in ${input.expiresMinutes} minutes.</p>
<p style="margin:0 0 16px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#0f6fff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700;font-size:14px">Open my dashboard</a></p>
<p style="margin:0;font-size:12px;color:#666">If you did not request this, you can ignore this email.</p>`,
    escapeHtml(config.name)
  )
  const text = [`Your ${config.name} partner dashboard`, '', `Open this link (it works once and expires in ${input.expiresMinutes} minutes):`, input.url, '', 'If you did not request this, ignore this email.'].join('\n')
  return { subject: `Your ${config.name} partner dashboard`, html, text }
}

export function magicLinkMail(input: { url: string; expiresMinutes: number }, ctx: MailContext): RenderedMail {
  const { config } = ctx
  const html = layout(
    config,
    'Your sign-in link',
    `<p style="margin:0 0 16px;font-size:14px">Click the button to sign in to your ${escapeHtml(config.name)} account. The link works once and expires in ${input.expiresMinutes} minutes.</p>
<p style="margin:0 0 16px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#0f6fff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700;font-size:14px">Sign in</a></p>
<p style="margin:0;font-size:12px;color:#666">If you did not request this, you can ignore this email.</p>`,
    escapeHtml(config.name)
  )
  const text = [
    `Sign in to ${config.name}`,
    '',
    `Open this link to sign in (it works once and expires in ${input.expiresMinutes} minutes):`,
    input.url,
    '',
    'If you did not request this, ignore this email.',
  ].join('\n')
  return { subject: `Sign in to ${config.name}`, html, text }
}

export function ownerPasswordResetMail(input: { url: string; expiresMinutes: number }, ctx: MailContext): RenderedMail {
  const { config } = ctx
  const html = layout(
    config,
    'Reset your password',
    `<p style="margin:0 0 16px;font-size:14px">Someone asked to reset the owner password for ${escapeHtml(config.name)}. If that was you, click the button. The link works once and expires in ${input.expiresMinutes} minutes.</p>
<p style="margin:0 0 16px"><a href="${escapeHtml(input.url)}" style="display:inline-block;background:#0f6fff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700;font-size:14px">Choose a new password</a></p>
<p style="margin:0;font-size:12px;color:#666">If you did not ask for this, ignore this email — your password stays as it is.</p>`,
    escapeHtml(config.name)
  )
  const text = [
    `Reset the owner password for ${config.name}`,
    '',
    `Open this link to choose a new password (it works once and expires in ${input.expiresMinutes} minutes):`,
    input.url,
    '',
    'If you did not ask for this, ignore this email.',
  ].join('\n')
  return { subject: `Reset your ${config.name} owner password`, html, text }
}

export function merchantNewOrderMail(order: Order, ctx: MailContext): RenderedMail {
  const { config } = ctx
  const number = `${config.orders.numberPrefix}${order.number}`
  const ship = addressLines(order.shippingAddress)
  const text = [
    `New order ${number} — ${formatMoney(order.total, config.locale)}`,
    '',
    ...linesText(order, config.locale),
    '',
    `Customer: ${order.customer.name ?? '(not given)'}`,
    `Email:    ${order.customer.email}`,
    `Phone:    ${order.customer.phone ?? '(not given)'}`,
    '',
    ...(ship.length ? ['Ship to:', ...ship, ''] : []),
    ...(order.shippingMethod ? [`Shipping: ${order.shippingMethod.name}`] : []),
    `Payment:  ${order.payment.status}${order.payment.provider ? ` via ${order.payment.provider}` : ''}${order.payment.reference ? ` (${order.payment.reference})` : ''}`,
    ...(order.notes ? ['', `Notes: ${order.notes}`] : []),
    '',
    `Order id: ${order.id}`,
  ].join('\n')
  const html = layout(
    config,
    `New order ${number}`,
    `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>`,
    escapeHtml(config.name)
  )
  return { subject: `New order ${number} — ${formatMoney(order.total, config.locale)}`, html, text }
}

/** Where a buyer opens a quote without signing in: the access key is the credential. */
export function quoteUrl(quote: StoreQuote, siteUrl: string): string {
  return `${siteUrl}/quotes/${encodeURIComponent(quote.id)}/?key=${encodeURIComponent(quote.accessKey)}`
}

function quoteNumber(quote: StoreQuote, config: StorefrontConfig): string {
  return `${config.quotes.numberPrefix}${quote.number}`
}

function quoteLinesTable(quote: StoreQuote, locale: string, priced: boolean): string {
  const rows = quote.lines
    .map(
      (l) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${escapeHtml(l.name)}<br><span style="color:#666;font-size:12px">SKU ${escapeHtml(l.sku)} × ${l.quantity}${priced && l.unitAmount ? ` at ${formatMoney(l.unitAmount, locale)}` : ''}</span></td><td align="right" style="padding:8px 0;border-bottom:1px solid #eee;white-space:nowrap">${priced && l.totalAmount ? formatMoney(l.totalAmount, locale) : ''}</td></tr>`
    )
    .join('')
  const totals =
    priced && quote.total
      ? [
          ['Subtotal', quote.subtotal ? formatMoney(quote.subtotal, locale) : ''],
          ['Shipping', quote.shipping?.amount ? formatMoney(quote.shipping, locale) : 'Included'],
          ...(quote.tax?.amount ? [['Tax', formatMoney(quote.tax, locale)]] : []),
          ['Total', formatMoney(quote.total, locale)],
        ]
          .map(([k, v], i, arr) => `<tr><td style="padding:6px 0;${i === arr.length - 1 ? 'font-weight:700' : 'color:#666'}">${k}</td><td align="right" style="padding:6px 0;${i === arr.length - 1 ? 'font-weight:700' : ''}">${v}</td></tr>`)
          .join('')
      : ''
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">${rows}${totals}</table>`
}

function quoteLinesText(quote: StoreQuote, locale: string, priced: boolean): string[] {
  return [
    ...quote.lines.map((l) => `${l.quantity} × ${l.name} (${l.sku})${priced && l.totalAmount ? ` — ${formatMoney(l.totalAmount, locale)}` : ''}`),
    ...(priced && quote.total
      ? [
          '',
          ...(quote.subtotal ? [`Subtotal: ${formatMoney(quote.subtotal, locale)}`] : []),
          `Shipping: ${quote.shipping?.amount ? formatMoney(quote.shipping, locale) : 'Included'}`,
          ...(quote.tax?.amount ? [`Tax: ${formatMoney(quote.tax, locale)}`] : []),
          `Total:    ${formatMoney(quote.total, locale)}`,
        ]
      : []),
  ]
}

const button = (url: string, label: string) =>
  `<p style="margin:24px 0 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#0f6fff;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700;font-size:14px">${escapeHtml(label)}</a></p>`

/** To the buyer: we have your request. Carries the link that is their way back in — no account needed. */
export function quoteReceivedMail(quote: StoreQuote, ctx: MailContext): RenderedMail {
  const { config, siteUrl } = ctx
  const number = quoteNumber(quote, config)
  const url = quoteUrl(quote, siteUrl)
  const intro = `Thanks — we have your request for a quote and will email you when it is priced. Keep this email: the link below shows the quote's status at any time.`
  const html = layout(config, `Quote request ${number} received`, `<p style="margin:0 0 16px;font-size:14px">${intro}</p>${quoteLinesTable(quote, config.locale, false)}${button(url, 'View your quote request')}`, contactFooter(config))
  const text = [`${config.name} — quote request ${number} received`, '', intro, '', ...quoteLinesText(quote, config.locale, false), '', `View your quote request: ${url}`].join('\n')
  return { subject: `Quote request ${number} received — ${config.name}`, html, text }
}

/** To the buyer: the quote is priced and waiting for their answer. */
export function quoteReadyMail(quote: StoreQuote, ctx: MailContext): RenderedMail {
  const { config, siteUrl } = ctx
  const number = quoteNumber(quote, config)
  const url = quoteUrl(quote, siteUrl)
  const expiry = quote.expiresAt ? ` It is valid until ${new Date(quote.expiresAt).toLocaleDateString(config.locale, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}.` : ''
  const intro = `Your quote is ready.${expiry} Accept it to place the order at these prices, or decline it — either takes one click.`
  const html = layout(
    config,
    `Quote ${number} is ready`,
    `<p style="margin:0 0 16px;font-size:14px">${escapeHtml(intro)}</p>${quoteLinesTable(quote, config.locale, true)}${quote.offerNote ? `<p style="margin:16px 0 0;font-size:14px;color:#444;white-space:pre-wrap">${escapeHtml(quote.offerNote)}</p>` : ''}${button(url, 'Review and accept')}`,
    contactFooter(config)
  )
  const text = [`${config.name} — quote ${number} is ready`, '', intro, '', ...quoteLinesText(quote, config.locale, true), ...(quote.offerNote ? ['', quote.offerNote] : []), '', `Review and accept: ${url}`].join('\n')
  return { subject: `Quote ${number} is ready — ${config.name}`, html, text }
}

/** To the merchant: a new request, or the buyer's answer to an offer. */
export function merchantQuoteMail(quote: StoreQuote, ctx: MailContext, event: 'requested' | 'accepted' | 'declined', orderNumber?: string | null): RenderedMail {
  const { config } = ctx
  const number = quoteNumber(quote, config)
  const headline =
    event === 'requested'
      ? `New quote request ${number}`
      : event === 'accepted'
        ? `Quote ${number} accepted${orderNumber ? ` — order ${config.orders.numberPrefix}${orderNumber}` : ''}`
        : `Quote ${number} declined`
  const ship = addressLines(quote.shippingAddress)
  const text = [
    headline,
    '',
    ...quoteLinesText(quote, config.locale, event !== 'requested'),
    '',
    `Customer: ${quote.customer.name ?? '(not given)'}`,
    ...(quote.company ? [`Company:  ${quote.company}`] : []),
    `Email:    ${quote.customer.email}`,
    `Phone:    ${quote.customer.phone ?? '(not given)'}`,
    ...(ship.length ? ['', 'Ship to:', ...ship] : []),
    ...(quote.message ? ['', `Message: ${quote.message}`] : []),
    ...(event === 'declined' && quote.declineReason ? ['', `Reason: ${quote.declineReason}`] : []),
    '',
    `Quote id: ${quote.id}`,
  ].join('\n')
  const html = layout(config, headline, `<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap;margin:0">${escapeHtml(text)}</pre>`, escapeHtml(config.name))
  return { subject: `${headline} — ${config.name}`, html, text }
}
