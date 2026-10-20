import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveRegistrySource } from './registry.js'
import { bold, dim, green } from './ui.js'

export interface CreateOptions {
  dir: string
  template: string
  cwd: string
}

/**
 * The published SDK range a scaffolded store depends on. It lives in the CLI's
 * own package.json so it ships with the package, and `scripts/check-sdk-range.mjs`
 * fails the build when it drifts from the SDK's current minor — a stale range here
 * scaffolds stores that cannot resolve the dependency at all.
 */
function publishedSdkRange(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { sdkRange?: string }
  if (!pkg.sdkRange) {
    throw new Error('@skuio/cli package.json is missing "sdkRange"')
  }
  return pkg.sdkRange
}

const SKIP = new Set([
  'node_modules', 'dist', '.astro', '.wrangler', '.env', '.dev.vars', '.store-api-key', 'migrations', 'test-results', 'playwright-report',
])

/**
 * Scaffold a new store from a template.
 *
 * The result is a plain project with no link back to this repo: it depends on
 * @skuio/storefront from npm and owns every other file outright.
 */
export async function create(opts: CreateOptions): Promise<void> {
  const target = resolve(opts.cwd, opts.dir)
  if (existsSync(target)) throw new Error(`${target} already exists`)

  const source = resolveRegistrySource()
  let templateDir: string
  let cleanup = () => {}

  if (source.kind === 'local') {
    templateDir = join(source.root, 'templates', opts.template)
    if (!existsSync(templateDir)) throw new Error(`No template "${opts.template}" in ${source.root}/templates`)
  } else {
    // Pull the repo tarball and take just the template out of it.
    const tmp = mkdtempSync(join(tmpdir(), 'skuio-'))
    cleanup = () => rmSync(tmp, { recursive: true, force: true })
    const tarball = join(tmp, 'repo.tgz')
    const res = await fetch('https://codeload.github.com/skuio/storefront/tar.gz/main')
    if (!res.ok) throw new Error(`Could not download template: HTTP ${res.status}`)
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
    execFileSync(
      'tar',
      ['-xzf', tarball, '-C', tmp, '--strip-components=1', `storefront-main/templates/${opts.template}`],
      { stdio: 'ignore' }
    )
    templateDir = join(tmp, 'templates', opts.template)
    if (!existsSync(templateDir)) {
      cleanup()
      throw new Error(`Template "${opts.template}" is not in the published repo`)
    }
  }

  mkdirSync(target, { recursive: true })
  cpSync(templateDir, target, { recursive: true, filter: (src) => !SKIP.has(basename(src)) })

  // Detach from the monorepo: real package name, real dependency range.
  const pkgPath = join(target, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
  pkg.name = basename(target).toLowerCase().replace(/[^a-z0-9-]/g, '-')
  pkg.private = true
  delete pkg.description
  const deps = (pkg.dependencies ?? {}) as Record<string, string>
  const sdkRange = deps['@skuio/storefront']
  let linkedSdk: string | null = null
  if (sdkRange === '*' || sdkRange?.startsWith('workspace')) {
    if (source.kind === 'local') {
      // Scaffolded from a checkout of the kit: link the SDK on disk so the
      // store builds before the package is on npm. Swap for a range to publish.
      linkedSdk = `file:${relative(target, join(source.root, 'packages', 'sdk')) || '.'}`
      deps['@skuio/storefront'] = linkedSdk
      // Astro pins vite 6; without this npm may hoist a second vite next to it.
      pkg.overrides = { ...((pkg.overrides as Record<string, string>) ?? {}), vite: '^6.4.3' }
    } else {
      deps['@skuio/storefront'] = publishedSdkRange()
    }
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  cleanup()

  console.log(`\n${green('✓')} Created ${bold(target)} from the ${bold(opts.template)} template.\n`)
  console.log('Next:')
  console.log(`  ${dim('$')} cd ${opts.dir}`)
  console.log(`  ${dim('$')} npm install`)
  console.log(`  ${dim('$')} cp .dev.vars.example .dev.vars   ${dim('# manual payments + console mail need no keys')}`)
  console.log(`\n  ${bold('On Cloudflare Workers + D1')} ${dim('(default)')}`)
  console.log(`  ${dim('$')} npx wrangler d1 create ${opts.dir}   ${dim('# paste the id into wrangler.jsonc')}`)
  console.log(`  ${dim('$')} npm run db:migrate:local && npm run seed`)
  console.log(`  ${dim('$')} npm run dev`)
  console.log(`  ${dim('$')} npm run owner:create:local -- --email you@example.com --name "Your Name"   ${dim('# the owner who signs in at /admin')}`)
  console.log(`\n  ${bold('On any Node host')} ${dim('(SQLite file)')}`)
  console.log(`  ${dim('$')} export STORE_HOST=node DATABASE_PATH=data/store.db`)
  console.log(`  ${dim('$')} npm run seed:sqlite && npm run dev`)
  console.log(`  ${dim('$')} npm run owner:create:sqlite -- --email you@example.com --name "Your Name"`)
  if (linkedSdk) {
    console.log(`\n${dim('@skuio/storefront is linked from your kit checkout (' + linkedSdk + ').')}`)
    console.log(dim('Run `npm run build` in the kit first, and replace the link with a version range before publishing.'))
  }
  console.log(`\nThen open ${bold('CLAUDE.md')} — it tells your coding agent how the store is put together.\n`)
}
