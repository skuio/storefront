import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    store: 'src/store/index.ts',
    api: 'src/api/index.ts',
    payments: 'src/payments/index.ts',
    'payments/stripe': 'src/payments/stripe.ts',
    'payments/manual': 'src/payments/manual.ts',
    'payments/paypal': 'src/payments/paypal.ts',
    'payments/btcpay': 'src/payments/btcpay.ts',
    'payments/bitcoin': 'src/payments/bitcoin.ts',
    mail: 'src/mail/index.ts',
    'mail/sendgrid': 'src/mail/sendgrid.ts',
    'mail/console': 'src/mail/console.ts',
    'mail/cloudflare': 'src/mail/cloudflare.ts',
    'db/sqlite': 'src/db/sqlite.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  external: ['stripe'],
})
