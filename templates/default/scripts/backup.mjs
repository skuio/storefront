#!/usr/bin/env node
/**
 * Back up the store's database: one gzipped, checksummed dump per run.
 *
 *   npm run backup                 # the production database
 *   npm run backup -- --local      # Cloudflare: the local D1 (to try it out)
 *
 * Cloudflare (default STORE_HOST): `wrangler d1 export --remote` → <db>.sql.gz,
 *   restorable with `wrangler d1 execute <db> --remote --file <db>.sql`.
 * Node (STORE_HOST=node): SQLite's online backup of DATABASE_PATH → <db>.sqlite.gz,
 *   a consistent copy taken while the store keeps serving; gunzip it into place to restore.
 *
 * Where it goes:
 *   BACKUP_S3_URI       s3://bucket/prefix — uploaded to <prefix>/<store>/<UTC timestamp>/ with
 *                       a SHA256SUMS file, using the `aws` CLI and its usual credentials
 *                       (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_PROFILE). Give it
 *                       write-only credentials; expire old dumps with a bucket lifecycle rule.
 *   BACKUP_S3_ENDPOINT  for S3-compatible stores (Cloudflare R2, Backblaze B2, Wasabi):
 *                       their endpoint URL, passed as --endpoint-url.
 *   (neither)           the dump stays in ./backups/ and the path is printed.
 *
 * Run it nightly from cron, a scheduled CI job or an existing backup server. It exits non-zero
 * on any failure, so whatever runs it can alert.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createGzip } from 'node:zlib'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const local = process.argv.includes('--local')
const host = process.env.STORE_HOST ?? 'cloudflare'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const work = join(tmpdir(), `store-backup-${stamp}`)
mkdirSync(work, { recursive: true })
const die = (msg) => {
  console.error(`backup: ✗ ${msg}`)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
}

let name
let raw
if (host === 'node') {
  const file = resolve(root, process.env.DATABASE_PATH ?? 'data/store.db')
  if (!existsSync(file)) die(`no SQLite database at ${file} (DATABASE_PATH)`)
  name = basename(file).replace(/\.[^.]+$/, '')
  raw = join(work, `${name}.sqlite`)
  const BetterSqlite3 = createRequire(join(root, 'package.json'))('better-sqlite3')
  const db = new BetterSqlite3(file, { readonly: true })
  await db.backup(raw)
  db.close()
} else {
  const config = readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
  name = /"database_name"\s*:\s*"([^"]+)"/.exec(config)?.[1]
  if (!name) die('wrangler.jsonc has no d1_databases[].database_name')
  raw = join(work, `${name}.sql`)
  // A global CF_API_KEY in the environment breaks D1 calls; wrangler's own login (or CLOUDFLARE_API_TOKEN) is what we want.
  const env = { ...process.env }
  delete env.CF_API_KEY
  delete env.CF_API_EMAIL
  try {
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'd1', 'export', name, local ? '--local' : '--remote', '--output', raw], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] })
  } catch {
    die(`wrangler d1 export ${name} failed`)
  }
}

const gz = `${raw}.gz`
await pipeline(createReadStream(raw), createGzip({ level: 6 }), createWriteStream(gz))
const sha = createHash('sha256').update(readFileSync(gz)).digest('hex')
writeFileSync(join(work, 'SHA256SUMS'), `${sha}  ${basename(gz)}\n`)
const size = `${(statSync(gz).size / 1024).toFixed(1)} KB`

const target = process.env.BACKUP_S3_URI?.replace(/\/+$/, '')
if (!target) {
  const dir = join(root, 'backups', stamp)
  mkdirSync(dir, { recursive: true })
  for (const f of [basename(gz), 'SHA256SUMS']) writeFileSync(join(dir, f), readFileSync(join(work, f)))
  rmSync(work, { recursive: true, force: true })
  console.log(`backup: ✓ ${join(dir, basename(gz))} (${size}); set BACKUP_S3_URI to upload it`)
  process.exit(0)
}

const dest = `${target}/${name}${local ? '-local' : ''}/${stamp}/`
const endpoint = process.env.BACKUP_S3_ENDPOINT ? ['--endpoint-url', process.env.BACKUP_S3_ENDPOINT] : []
for (const f of [basename(gz), 'SHA256SUMS']) {
  try {
    execFileSync('aws', ['s3', 'cp', join(work, f), dest + f, '--only-show-errors', ...endpoint], { stdio: ['ignore', 'inherit', 'inherit'] })
  } catch {
    die(`upload of ${f} to ${dest} failed (is the aws CLI installed and are its credentials set?)`)
  }
}
rmSync(work, { recursive: true, force: true })
console.log(`backup: ✓ ${dest}${basename(gz)} (${size}, sha256 ${sha.slice(0, 12)}…)`)
