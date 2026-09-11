#!/usr/bin/env node
/**
 * The registry is the source of truth for UI blocks; the template is a store
 * built from them. This copies every block file into templates/default so the
 * two never drift — and `--check` fails CI when they have.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const registry = JSON.parse(readFileSync(join(root, 'registry', 'registry.json'), 'utf8'))
const template = join(root, 'templates', 'default')
const check = process.argv.includes('--check')

let written = 0
let drift = []

for (const block of registry.blocks) {
  for (const file of block.files) {
    const from = join(root, 'registry', 'blocks', block.name, file.from)
    const to = join(template, file.to)
    if (!existsSync(from)) {
      console.error(`registry.json names a file that does not exist: ${block.name}/${file.from}`)
      process.exit(1)
    }
    const content = readFileSync(from, 'utf8')
    const current = existsSync(to) ? readFileSync(to, 'utf8') : null
    if (current === content) continue
    if (check) {
      drift.push(file.to)
      continue
    }
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, content)
    written++
    console.log(`  sync  ${file.to}`)
  }
}

if (check) {
  if (drift.length) {
    console.error(`Template has drifted from the registry in ${drift.length} file(s):`)
    drift.forEach((f) => console.error(`  ${f}`))
    console.error('\nEdit the block under registry/blocks and run `npm run sync:template`.')
    process.exit(1)
  }
  console.log('template matches registry')
} else {
  console.log(`${written} file(s) synced`)
}
