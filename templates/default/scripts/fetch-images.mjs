#!/usr/bin/env node
/**
 * Download every image named in src/data/image-sources.json into
 * src/assets/products/. Idempotent: files already on disk are skipped.
 */
import { mkdir, writeFile, stat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const OUT = resolve(process.cwd(), 'src/assets/products')
const sources = JSON.parse(await readFile(resolve(process.cwd(), 'src/data/image-sources.json'), 'utf8'))
await mkdir(OUT, { recursive: true })

const queue = Object.entries(sources)
let done = 0, skipped = 0
const failed = []
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const [name, url] = queue.shift()
    const file = `${OUT}/${name}`
    try {
      const s = await stat(file).catch(() => null)
      if (s && s.size > 0) { skipped++; continue }
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) throw new Error('empty body')
      await writeFile(file, buf)
      done++
    } catch (e) {
      failed.push(`${url} — ${e.message}`)
    }
  }
}))
console.log(`downloaded ${done}, already present ${skipped}, failed ${failed.length}`)
failed.forEach((f) => console.error(`  FAIL ${f}`))
if (failed.length) process.exitCode = 1
