---
name: add-page
description: Add a static page to this store (about, FAQ, install guide, landing page) and wire it into navigation.
---

# Add a page

1. Create `src/pages/<slug>.astro`. Start from `src/pages/about.astro`:
   - `import BaseLayout from '../layouts/BaseLayout.astro'`
   - `export const prerender = true`
   - Pass `title` and `description` to `BaseLayout` — they become the `<title>`,
     meta description and Open Graph tags.
   - Use `Breadcrumbs` for the trail; use the `prose-store` class on rich text.
2. If the page belongs in navigation, add it to the `nav` array in
   `src/components/SiteHeader.astro` and/or the legal nav in `SiteFooter.astro`.
3. If it replaces a URL from a previous site, add a line to `public/_redirects`:
   `/old-path/  /new-path/  301`.
4. `npm run build` — the page must render with no errors — then `npm run check`.
