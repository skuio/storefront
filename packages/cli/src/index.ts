import { add } from './add.js'
import { create } from './create.js'
import { loadRegistry, resolveRegistrySource } from './registry.js'
import { bold, dim, red } from './ui.js'

const USAGE = `
${bold('skuio')} — scaffold a SKU.io storefront and add blocks

  ${bold('skuio create')} <dir> [--template default]   scaffold a new store
  ${bold('skuio add')} <block...> [--overwrite]        copy blocks into this project
  ${bold('skuio list')}                                show available blocks

Blocks are copied, not installed: after \`add\`, the files are yours to change.
Set ${dim('SKUIO_REGISTRY')} to a path or URL to use a different registry.
`

async function main(argv: string[]) {
  const [cmd, ...rest] = argv
  const flags = new Set(rest.filter((a) => a.startsWith('--')))
  const args = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--template')
  const flagValue = (name: string) => {
    const i = rest.indexOf(`--${name}`)
    return i > -1 ? rest[i + 1] : undefined
  }

  switch (cmd) {
    case 'create': {
      const dir = args[0]
      if (!dir) throw new Error('create needs a directory name')
      await create({ dir, template: flagValue('template') ?? 'default', cwd: process.cwd() })
      return
    }
    case 'add': {
      if (args.length === 0) throw new Error('add needs at least one block name')
      await add({ names: args, cwd: process.cwd(), overwrite: flags.has('--overwrite') })
      return
    }
    case 'list': {
      const registry = await loadRegistry(resolveRegistrySource())
      const width = Math.max(...registry.blocks.map((b) => b.name.length))
      for (const b of registry.blocks) console.log(`  ${bold(b.name.padEnd(width))}  ${dim(b.description)}`)
      return
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE)
      return
    default:
      throw new Error(`Unknown command "${cmd}"\n${USAGE}`)
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`\n${red('error')} ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
