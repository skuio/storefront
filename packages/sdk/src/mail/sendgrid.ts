import type { MailAdapter, MailMessage } from './types'

export interface SendgridMailOptions {
  apiKey: string
  from: { email: string; name?: string }
  /** Override for tests. */
  fetch?: typeof fetch
}

export class MailSendError extends Error {
  readonly status: number
  constructor(status: number, body: string) {
    super(`SendGrid rejected the message: HTTP ${status} ${body}`.trim())
    this.name = 'MailSendError'
    this.status = status
  }
}

/**
 * SendGrid v3 over HTTP, because Workers cannot open SMTP sockets.
 * `from.email` must be a verified sender identity or SendGrid answers 403.
 */
export function sendgridMail(options: SendgridMailOptions): MailAdapter {
  const doFetch = options.fetch ?? fetch
  return {
    id: 'sendgrid',
    async send(message: MailMessage) {
      const response = await doFetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: options.from.email, ...(options.from.name ? { name: options.from.name } : {}) },
          subject: message.subject,
          content: [
            { type: 'text/plain', value: message.text },
            { type: 'text/html', value: message.html },
          ],
          ...(message.replyTo ? { reply_to: { email: message.replyTo } } : {}),
        }),
      })
      if (response.status !== 202) throw new MailSendError(response.status, await response.text().catch(() => ''))
    },
  }
}
