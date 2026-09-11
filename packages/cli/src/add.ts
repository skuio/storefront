import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadRegistry, readText, resolveRegistrySource, type RegistryBlock } from './registry.js'
import { bold, dim, green, yellow } from './ui.js'

export interface AddOptions {
  names: string[]
  cwd: string
  overwrite: boolean
}

/**
 * Copy blocks into the project. Copy-and-own: once a file is in the project it
 * is the project's, and a later `add` only replaces it when asked to.
 */
export async function add(opts: AddOptions): Promise<void> {
  const source = resolveRegistrySource()
  const registry = await loadRegistry(source)
  const byName = new Map(registry.blocks.map((b) => [b.name, b]))

  // Resolve registry dependencies transitively, dependencies first.
  const wanted: RegistryBlock[] = []
  const seen = new Set<string>()
  const visit = (name: string, requestedBy?: string) => {
    if (seen.has(name)) return
    const block = byName.get(name)
    if (!block) {
      const via = requestedBy ? ` (needed by ${requestedBy})` : ''
      throw new Error(`No block named "${name}"${via}. Run \`skuio list\` to see what exists.`)
    }
    seen.add(name)
    for (const dep of block.registryDependencies ?? []) visit(dep, name)
    wanted.push(block)
  }
  opts.names.forEach((n) => visit(n))

  const deps = new Set<string>()
  let written = 0
  let skipped = 0

  for (const block of wanted) {
    console.log(`\n${bold(block.name)} ${dim('—')} ${block.description}`)
    for (const file of block.files) {
      const target = join(opts.cwd, file.to)
      const content = await readText(source, `registry/blocks/${block.name}/${file.from}`)

      if (existsSync(target) && !opts.overwrite) {
        const same = readFileSync(target, 'utf8') === content
        console.log(
          `  ${yellow('skip')}  ${file.to} ${dim(same ? '(identical)' : '(exists — pass --overwrite to replace)')}`
        )
        skipped++
        continue
      }

      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content)
      console.log(`  ${green('write')} ${file.to}`)
      written++
    }
    block.dependencies?.forEach((d) => deps.add(d))
  }

  console.log(`\n${written} file(s) written, ${skipped} skipped.`)
  if (deps.size) {
    console.log(`\nInstall the packages these blocks import:\n  ${bold(`npm install ${[...deps].join(' ')}`)}`)
  }
}
