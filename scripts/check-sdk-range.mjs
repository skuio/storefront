#!/usr/bin/env node
/**
 * The CLI scaffolds new stores with a published range for @skuio/storefront.
 * A range that no longer covers the SDK's current minor produces stores whose
 * install fails outright, and nothing else in the build notices. Keep them in step.
 */
import { readFileSync } from 'node:fs'

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'))
const sdk = read('../packages/sdk/package.json')
const cli = read('../packages/cli/package.json')

const range = cli.sdkRange
if (!range) {
  console.error('packages/cli/package.json is missing "sdkRange".')
  process.exit(1)
}

const wanted = `^${sdk.version.split('.').slice(0, 2).join('.')}.0`
if (range !== wanted) {
  console.error(`@skuio/cli scaffolds "${range}" but the SDK is ${sdk.version}; set "sdkRange" to "${wanted}".`)
  process.exit(1)
}

console.log(`sdk range ok — cli scaffolds ${range} for SDK ${sdk.version}`)
