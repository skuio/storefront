export type { MailAdapter, MailMessage } from './types'
export {
  orderConfirmationMail, shippingConfirmationMail, magicLinkMail, merchantNewOrderMail, escapeHtml,
  type RenderedMail, type MailContext,
} from './templates'
export { consoleMail, type ConsoleMailOptions } from './console'
export { sendgridMail, MailSendError, type SendgridMailOptions } from './sendgrid'
