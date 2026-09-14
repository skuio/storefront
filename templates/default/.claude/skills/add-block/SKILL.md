---
name: add-block
description: Copy a UI block (product card, gallery, order lookup, ...) from the SKU.io registry into this store, or refresh one you already have.
---

# Add a block

Blocks are copy-and-own: `add` writes files into this project and they are
yours from then on. A later `add` will not overwrite your changes unless you
pass `--overwrite`.

1. `npx @skuio/cli list` — see what exists.
2. `npx @skuio/cli add <name>` — copies the block and anything it depends on.
   The output names every file written and any npm package to install.
3. Blocks import `store`, `config`, `routes` (and friends) from `src/lib/store.ts`
   and `resolveImage` from `src/lib/images.ts`. If you have moved those, fix the
   import paths in the new file.
4. Use the component in a page, then `npm run build` and `npm run check`.

To see what changed upstream before taking an update:
`npx @skuio/cli add <name>` without `--overwrite` reports "exists" for each
file; compare against the registry on GitHub, then rerun with `--overwrite` if
you want the new version.
