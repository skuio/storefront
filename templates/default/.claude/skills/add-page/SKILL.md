---
name: add-page
description: Add a static page to this store (about, FAQ, install guide, landing page) and wire it into navigation.
---

# Add a page

1. Create `src/pages/<slug>.astro`. Start from `src/pages/about.astro`:
   - `import BaseLayout from '../layouts/BaseLayout.astro'`
   - `export const prerender = false` (every page renders in the Worker)
   - Pass `title` and `description` to `BaseLayout` — they become the `<title>`,
     meta description and Open Graph tags.
   - Use `Breadcrumbs` for the trail; use the `prose-store` class on rich text.
2. If the page belongs in navigation, add it to the `nav` array in
   `src/components/SiteHeader.astro` and/or the legal nav in `SiteFooter.astro`.
3. Add its path to `STATIC` in `src/pages/sitemap.xml.ts`.
4. If it replaces a URL from a previous site, add a line to `public/_redirects`:
   `/old-path/  /new-path/  301`.
5. `npm run build` — the page must render with no errors — then `npm run check`.

## What goes on the page

- **Facts come from sources.** Specs, dimensions, compatibility, policies and
  claims come from the manufacturer's data or the owner — never invented to
  fill a section. Mark anything you could not trace `CONFIRM` and list it for
  the owner. No earnings, savings or performance claims the source does not
  make, and no generated pictures presented as the real product.
- **Contact details work everywhere.** Show the email address as text beside
  any `mailto:` link (it does nothing in Facebook/Instagram in-app browsers)
  and link the contact form.
- **Video** that must play on iOS cannot come from `public/` (no `Range`
  support); see `CLAUDE.md` → "Mobile, iOS and in-app browsers".
- A page that should not be indexed passes `noindex` to `BaseLayout`; if it is
  private (an account area), also add a `Disallow:` line in
  `src/pages/robots.txt.ts`.
