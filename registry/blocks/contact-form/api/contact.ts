import type { APIContext } from 'astro'
import { config } from '../../lib/catalog'
import { sendEmail } from '../../lib/email'
import { readEnv } from '../../lib/stripe'

export const prerender = false

const MAX_FIELD = 4000
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function clean(value: FormDataEntryValue | null): string {
  return String(value ?? '').trim().slice(0, MAX_FIELD)
}

export async function POST(context: APIContext): Promise<Response> {
  const form = await context.request.formData()

  // Honeypot — a real browser leaves this empty. Answer 200 so bots learn nothing.
  if (clean(form.get('company'))) return json({ ok: true })

  const name = clean(form.get('name'))
  const email = clean(form.get('email'))
  const message = clean(form.get('message'))
  if (!name || !email || !message || !email.includes('@')) return json({ ok: false, error: 'missing_fields' }, 400)

  const to = readEnv(context, 'CONTACT_NOTIFICATION_EMAIL') ?? config.contact?.email
  if (!to) {
    console.error('contact: no CONTACT_NOTIFICATION_EMAIL and no config.contact.email')
    return json({ ok: false, error: 'not_configured' }, 500)
  }

  const sent = await sendEmail(context, {
    to,
    replyTo: email,
    subject: `Website enquiry — ${name}`,
    text: [`Name:  ${name}`, `Email: ${email}`, '', message, '', '--', `Sent from ${context.url.origin}/contact/`].join('\n'),
  })

  return sent ? json({ ok: true }) : json({ ok: false, error: 'send_failed' }, 502)
}
