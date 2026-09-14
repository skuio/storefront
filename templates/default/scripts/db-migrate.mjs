#!/usr/bin/env node
/**
 * Apply the store schema to the D1 database.
 *
 *   node scripts/db-migrate.mjs --local     # the local D1 used by `astro dev`
 *   node scripts/db-migrate.mjs --remote    # production
 *
 * The migrations ship inside @skuio/storefront (db/migrations/*.sql). They
 * are copied into ./migrations so wrangler can track which ones it applied,
 * then `wrangler d1 migrations apply` runs. Re-running is safe.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = process.argv.includes('--remote') ? '--remote' : '--local'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const sdkDir = dirname(require.resolve('@skuio/storefront/package.json'))
const source = join(sdkDir, 'db', 'migrations')
const dest = join(root, 'migrations')
mkdirSync(dest, { recursive: true })
const files = readdirSync(source).filter((f) => f.endsWith('.sql')).sort()
for (const f of files) copyFileSync(join(source, f), join(dest, f))
console.log(`migrate: ${files.length} migration(s) from ${sdkDir} → ./migrations (${target})`)
const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx'
execFileSync(wrangler, ['wrangler', 'd1', 'migrations', 'apply', 'DB', target], { cwd: root, stdio: 'inherit', env: { ...process.env, CF_API_KEY: undefined, CF_API_EMAIL: undefined } })
