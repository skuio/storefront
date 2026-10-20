#!/usr/bin/env node
/**
 * Checks to run before every deploy:  node scripts/predeploy.mjs && npm run deploy
 * (or name it `predeploy` in package.json and npm runs it before `npm run deploy` by itself).
 *
 *   1. A linked SDK is rebuilt. When @skuio/storefront is a `file:` dependency or a workspace link,
 *      the store bundles its compiled dist/, and nothing else rebuilds it: a store once shipped
 *      against a dist/ that predated an adapter in src/, and the build failed with
 *      `Rollup failed to resolve import "@skuio/storefront/payments/paypal"`.
 *   2. Every entry point the SDK exports exists on disk (linked or installed from npm).
 *   3. On Cloudflare Workers (the default host): the remote D1 database has every migration this SDK
 *      ships. New code against an old schema is a 5xx on every page that reads a new column — a
 *      staging store went 502 after an SDK bump for exactly that reason. Run `npm run db:migrate`
 *      first. Migrations are additive, so the old Worker keeps working on the new schema in between.
 *
 *   --local          check the local D1 database instead of the remote one
 *   --skip-schema    skip step 3 (another host, or no database binding)
 *   --skip-build     skip step 1
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Set(process.argv.slice(2))
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const die = (msg) => {
  console.error(`predeploy: ✗ ${msg}`)
  process.exit(1)
}
const ok = (msg) => console.log(`predeploy: ✓ ${msg}`)

// --- 1. a linked SDK is rebuilt ------------------------------------------------------------------
const require = createRequire(join(root, 'package.json'))
const sdkDir = dirname(require.resolve('@skuio/storefront/package.json'))
const linkPath = join(root, 'node_modules', '@skuio', 'storefront')
const linked =
  (existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink()) || !realpathSync(sdkDir).split(sep).includes('node_modules')
const sdkPkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'))

if (linked && !args.has('--skip-build')) {
  if (!sdkPkg.scripts?.build) die(`the linked SDK at ${sdkDir} has no build script`)
  console.log(`predeploy: rebuilding the linked SDK at ${realpathSync(sdkDir)}`)
  try {
    execFileSync(npm, ['run', 'build'], { cwd: sdkDir, stdio: 'inherit' })
  } catch {
    die(`the SDK build failed; if a dependency is missing, run \`npm ci\` in the SDK's checkout and retry`)
  }
  ok('linked SDK rebuilt')
} else if (linked) {
  console.log(`predeploy: linked SDK at ${realpathSync(sdkDir)} — rebuild skipped (--skip-build)`)
} else {
  ok(`SDK ${sdkPkg.version} installed from the registry`)
}

// --- 2. every export exists ----------------------------------------------------------------------
const missing = []
for (const [name, target] of Object.entries(sdkPkg.exports ?? {})) {
  const files = typeof target === 'string' ? [target] : Object.values(target ?? {}).filter((v) => typeof v === 'string')
  // Wildcard subpaths (./db/migrations/*) are directories of source files, not built output.
  for (const f of files) if (!f.includes('*') && !existsSync(join(sdkDir, f))) missing.push(`${name} → ${f}`)
}
if (missing.length) die(`the SDK is missing built entry points:\n  ${missing.join('\n  ')}`)
ok(`all ${Object.keys(sdkPkg.exports ?? {}).length} SDK entry points exist`)

// --- 3. the database has every migration ---------------------------------------------------------
if (args.has('--skip-schema')) {
  console.log('predeploy: schema check skipped')
  process.exit(0)
}
const wranglerConfig = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].map((f) => join(root, f)).find(existsSync)
if (!wranglerConfig || !/d1_databases/.test(readFileSync(wranglerConfig, 'utf8'))) {
  console.log('predeploy: no D1 database in the wrangler config; apply migrations with your host\'s tooling, then deploy')
  process.exit(0)
}
const shipped = readdirSync(join(sdkDir, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort()
const target = args.has('--local') ? '--local' : '--remote'
let applied = []
try {
  // The machine-wide CF_API_KEY/CF_API_EMAIL pair makes wrangler fail with "Authentication error
  // [code: 10000]"; wrangler's own login (or CLOUDFLARE_* variables) is what reads D1.
  const env = { ...process.env }
  delete env.CF_API_KEY
  delete env.CF_API_EMAIL
  const out = execFileSync(npx, ['wrangler', 'd1', 'execute', 'DB', target, '--json', '--command', 'SELECT name FROM d1_migrations ORDER BY id'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  applied = JSON.parse(out).flatMap((r) => r.results ?? []).map((r) => r.name)
} catch (e) {
  const detail = `${e.stdout ?? ''}${e.stderr ?? ''}`
  if (!/no such table: d1_migrations/.test(detail)) die(`could not read the ${target.slice(2)} database's migrations:\n${detail.trim() || e.message}`)
}
const pending = shipped.filter((f) => !applied.includes(f))
if (pending.length) {
  die(`the ${target.slice(2)} database is missing ${pending.length} migration(s): ${pending.join(', ')}\n  run \`npm run db:migrate${target === '--local' ? ':local' : ''}\` first, then deploy`)
}
ok(`the ${target.slice(2)} database has all ${shipped.length} migrations`)
