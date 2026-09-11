import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveRegistrySource } from './registry.js'
import { bold, dim, green } from './ui.js'

export interface CreateOptions {
  dir: string
  template: string
  cwd: string
}

const SKIP = new Set([
  'node_modules', 'dist', '.astro', '.wrangler', '.env', '.dev.vars', 'test-results', 'playwright-report',
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
  if (sdkRange === '*' || sdkRange?.startsWith('workspace')) deps['@skuio/storefront'] = '^0.1.0'
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  cleanup()

  console.log(`\n${green('✓')} Created ${bold(target)} from the ${bold(opts.template)} template.\n`)
  console.log('Next:')
  console.log(`  ${dim('$')} cd ${opts.dir}`)
  console.log(`  ${dim('$')} npm install`)
  console.log(`  ${dim('$')} cp .env.example .env     ${dim('# add a Stripe test key')}`)
  console.log(`  ${dim('$')} npm run dev`)
  console.log(`\nThen open ${bold('CLAUDE.md')} — it tells your coding agent how the store is put together.\n`)
}
