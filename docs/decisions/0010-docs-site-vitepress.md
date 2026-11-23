# 0010 · Docs site with VitePress, served by the API

**Status:** Accepted

> **Decision:** VitePress builds `docs/` into `public/`, which the NestJS app serves next to the API.<br>
> **Why:** The markdown in the repo stays the single source, with one deployment and one origin for the demo.<br>
> **Cost:** A slightly longer build, and HTML pages served by the function rather than the CDN.

## Context

This is a portfolio project: the design and its reasoning matter as much as the running API. That
material already existed as markdown in the repo (an architecture document with about two dozen
Mermaid diagrams, feature pages, requirement plans), but the public deployment only showed a single
demo page. A hand-maintained HTML copy of the architecture document had started to drift from the
markdown.

## Decision

- **VitePress** builds a static site from `docs/`. The markdown files in the repo are the pages;
  there is no second copy. Sections: landing, live demo, architecture, decisions (these records),
  features, roadmap.
- The site is built into `public/` (generated, not committed) as part of `pnpm build`, so CI and
  Vercel build it with everything else.
- The NestJS app serves `public/` as static files with clean URLs (`src/site.ts`, `extensions: ['html']`),
  locally, in tests and on Vercel. API routes are unaffected because only existing files are served.
  Hashed assets get an immutable `Cache-Control`.
- The existing demo stays a dependency-free HTML page (`docs/public/demo-app.html`) and is embedded on
  `/demo`, so it keeps working against the API on the same origin.
- Mermaid diagrams are rendered in the browser by a small theme hook that imports Mermaid **only on
  pages that contain a diagram**. A plugin was tried first, but it preloaded about 50 Mermaid chunks
  on every page, including the landing page.

## Alternatives considered

- **Keep a single hand-written HTML page.** No build step, but no navigation, no search, and the docs
  stay invisible or get duplicated.
- **A React/Next.js frontend.** Far more machinery for content that is 90% markdown, and a second
  deployable to keep in sync with the API.
- **Docusaurus / Astro Starlight.** Both fit; VitePress was chosen because it's markdown-first,
  builds with Vite (already in the project for Vitest), and needed only dev dependencies.
- **A separate Vercel project for the docs.** Cleaner separation, but two deployments and a
  cross-origin demo (CORS for every API call).

## Consequences

- Docs change with the code in the same pull request, and every PR gets a preview of the site.
- `pnpm build` takes about 10 s longer, and the e2e tests for the site expect `public/` to be built
  (CI builds before testing).
- On Vercel the site's pages are served by the NestJS function rather than straight from the CDN.
  Hashed assets are cached, but HTML requests count as function invocations; serving `public/` from
  the CDN is a possible follow-up.
- Writing a page is writing markdown: features add their page under `docs/features/` and a sidebar
  entry; significant design changes add a record here.
