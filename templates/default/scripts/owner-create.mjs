#!/usr/bin/env node
/**
 * Create (or reset) the store owner who signs in at /admin.
 *
 *   npm run owner:create -- --email you@example.com --name "Your Name"          # the deployed database
 *   npm run owner:create:local -- --email you@example.com --name "Your Name"    # the local D1 used by `astro dev`
 *
 * The password is asked for on the terminal without echo, or read from
 * OWNER_PASSWORD for automation. Only its PBKDF2 hash is written, through
 * `wrangler d1 execute` like the seed script. Re-running for an email that
 * already exists resets that owner's password (and name, if given).
 * There is no public sign-up: this script is the only way an owner appears.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const sqlite = args.includes('--sqlite')
const target = args.includes('--local') ? '--local' : '--remote'
const email = (flag('email') ?? '').trim().toLowerCase()
const name = flag('name')?.trim() || null
if (!email.includes('@')) {
  console.error('usage: owner-create.mjs --email <address> [--name "<name>"] [--local|--remote|--sqlite]')
  process.exit(1)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const sdkDir = dirname(require.resolve('@skuio/storefront/package.json'))
const { hashPassword, passwordProblem } = await import(join(sdkDir, 'dist', 'store.js'))

const wranglerConfig = sqlite ? '' : readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
const dbName = /"database_name"\s*:\s*"([^"]+)"/.exec(wranglerConfig)?.[1]
if (!sqlite && !dbName) throw new Error('wrangler.jsonc has no d1_databases[].database_name')

async function askPassword(prompt) {
  if (process.env.OWNER_PASSWORD) return process.env.OWNER_PASSWORD
  if (!process.stdin.isTTY) throw new Error('No terminal for the password prompt; set OWNER_PASSWORD instead')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  // Mute the echo while the password is typed.
  const write = rl._writeToOutput.bind(rl)
  rl._writeToOutput = (s) => (s.includes(prompt) ? write(s) : undefined)
  return new Promise((resolve) => rl.question(prompt, (v) => { rl.close(); process.stdout.write('\n'); resolve(v) }))
}

const password = await askPassword(`Password for ${email}: `)
const problem = passwordProblem(password)
if (problem) {
  console.error(`password ${problem}`)
  process.exit(1)
}
if (!process.env.OWNER_PASSWORD) {
  const again = await askPassword('Repeat it: ')
  if (again !== password) {
    console.error('passwords do not match')
    process.exit(1)
  }
}

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const id = 'own_' + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('')
const now = new Date().toISOString()
const hash = await hashPassword(password)
const sql = `INSERT INTO owners (id, email, name, password_hash, created_at) VALUES (${q(id)}, ${q(email)}, ${q(name)}, ${q(hash)}, ${q(now)}) ON CONFLICT (email) DO UPDATE SET name = COALESCE(excluded.name, owners.name), password_hash = excluded.password_hash;\n`

if (sqlite) {
  const { runOnSqlite } = await import('./lib/sqlite.mjs')
  const file = await runOnSqlite(root, [sql])
  console.log(`owner: ${email} can now sign in at /admin (${file})`)
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'owner-create-'))
const file = join(dir, 'owner.sql')
writeFileSync(file, sql, { mode: 0o600 })
const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx'
// A global CF_API_KEY in the environment breaks D1 calls; wrangler's own login is what we want.
execFileSync(wrangler, ['wrangler', 'd1', 'execute', dbName, target, '--file', file], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, CF_API_KEY: undefined, CF_API_EMAIL: undefined, OWNER_PASSWORD: undefined } })
console.log(`owner: ${email} can now sign in at /admin (${dbName} ${target})`)
