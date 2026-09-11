import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface RegistryFile {
  /** Relative to the block's directory in the registry. */
  from: string
  /** Relative to the project root. */
  to: string
}

export interface RegistryBlock {
  name: string
  description: string
  files: RegistryFile[]
  /** npm packages the block needs. */
  dependencies?: string[]
  /** Other registry blocks the block imports. */
  registryDependencies?: string[]
}

export interface Registry {
  version: number
  blocks: RegistryBlock[]
}

export type RegistrySource = { kind: 'local'; root: string } | { kind: 'remote'; base: string }

export const DEFAULT_REMOTE = 'https://raw.githubusercontent.com/skuio/storefront/main'

/**
 * Where blocks come from, in priority order:
 *   1. SKUIO_REGISTRY — a local path or an https base URL
 *   2. the monorepo, when the CLI is running from inside it
 *   3. the public repo on GitHub
 */
export function resolveRegistrySource(): RegistrySource {
  const env = process.env.SKUIO_REGISTRY
  if (env) {
    if (/^https?:\/\//.test(env)) return { kind: 'remote', base: env.replace(/\/$/, '') }
    return { kind: 'local', root: resolve(env) }
  }

  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'registry', 'registry.json'))) return { kind: 'local', root: dir }
    dir = dirname(dir)
  }

  return { kind: 'remote', base: DEFAULT_REMOTE }
}

export async function readText(source: RegistrySource, relPath: string): Promise<string> {
  if (source.kind === 'local') {
    const file = join(source.root, relPath)
    if (!existsSync(file)) throw new Error(`Not found in local registry: ${relPath}`)
    return readFileSync(file, 'utf8')
  }
  const url = `${source.base}/${relPath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`)
  return res.text()
}

export async function loadRegistry(source: RegistrySource): Promise<Registry> {
  return JSON.parse(await readText(source, 'registry/registry.json')) as Registry
}
