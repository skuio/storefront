import type { MailAdapter, MailMessage } from './types'

export interface ConsoleMailOptions {
  /** Where to write; defaults to console.log. `wrangler tail` shows it in production. */
  log?: (line: string) => void
}

/**
 * Logs instead of sending. The whole text body is printed, so a magic link
 * or an order confirmation can be read straight from the Worker log.
 */
export function consoleMail(options: ConsoleMailOptions = {}): MailAdapter {
  const log = options.log ?? ((line: string) => console.log(line))
  return {
    id: 'console',
    async send(message: MailMessage) {
      log(`[mail] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`)
    },
  }
}
