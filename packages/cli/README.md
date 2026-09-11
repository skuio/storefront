# @skuio/cli

```
npx @skuio/cli create my-store      scaffold a store from the reference template
npx @skuio/cli add <block...>       copy UI blocks from the registry into it
npx @skuio/cli list                 see what blocks exist
```

Blocks are copied, not installed: after `add` the files are yours to change,
and a later `add` never overwrites without `--overwrite`. The scaffolded store
depends on `@skuio/storefront` from npm and owns everything else.

Kit and docs: https://github.com/skuio/storefront
