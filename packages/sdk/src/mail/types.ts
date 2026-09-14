export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
}

/** Sends one transactional message. Implementations: `sendgrid`, `console`. */
export interface MailAdapter {
  readonly id: string
  send(message: MailMessage): Promise<void>
}
