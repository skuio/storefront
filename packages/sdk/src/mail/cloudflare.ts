import type { MailAdapter, MailMessage } from './types'

/** The shape of a Workers `send_email` binding (Cloudflare Email Service). */
export interface CloudflareSendEmailBinding {
  send(message: {
    to: string | string[]
    from: { email: string; name?: string } | string
    subject: string
    html?: string
    text?: string
    replyTo?: string
  }): Promise<{ messageId?: string } | unknown>
}

export interface CloudflareMailOptions {
  /** The `send_email` binding from wrangler.jsonc, e.g. env.EMAIL. */
  binding: CloudflareSendEmailBinding
  /** Sender on a domain onboarded with `wrangler email sending enable <domain>`. */
  from: { email: string; name?: string }
}

/**
 * Cloudflare Email Service through the Worker's `send_email` binding: no API
 * key, no third party — the domain is onboarded once (SPF/DKIM are added to
 * the zone automatically) and the binding sends to any recipient.
 */
export function cloudflareMail(options: CloudflareMailOptions): MailAdapter {
  return {
    id: 'cloudflare',
    async send(message: MailMessage) {
      await options.binding.send({
        to: message.to,
        from: options.from,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      })
    },
  }
}
