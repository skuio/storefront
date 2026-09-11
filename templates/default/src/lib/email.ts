import type { APIContext } from 'astro'
import { readEnv } from './stripe'

export interface OutboundEmail {
  to: string
  subject: string
  text: string
  replyTo?: string
}

/**
 * Transactional mail through SendGrid's v3 API — HTTP because Workers cannot
 * open SMTP sockets. Returns false rather than pretending to have sent when
 * the key is missing, so callers can tell the customer.
 */
export async function sendEmail(context: APIContext, message: OutboundEmail): Promise<boolean> {
  const apiKey = readEnv(context, 'SENDGRID_API_KEY')
  const fromEmail = readEnv(context, 'MAIL_FROM')
  const fromName = readEnv(context, 'MAIL_FROM_NAME') ?? 'Store'

  if (!apiKey || !fromEmail) {
    console.error('email: SENDGRID_API_KEY / MAIL_FROM not configured; message not sent', { to: message.to, subject: message.subject })
    return false
  }

  try {
    const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: fromEmail, name: fromName },
        subject: message.subject,
        content: [{ type: 'text/plain', value: message.text }],
        ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
      }),
    })
    if (response.status !== 202) {
      // A 403 here is usually an unverified sender identity, not a bad key.
      console.error('email: SendGrid rejected the message', response.status, await response.text())
      return false
    }
    return true
  } catch (error) {
    console.error('email: send failed', error)
    return false
  }
}
