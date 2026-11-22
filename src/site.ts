import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The docs site and the demo, built by VitePress into public/ (`pnpm docs:build`,
 * part of `pnpm build`). Relative to the project root, like migrations/: the app
 * runs from there. On Vercel the CDN serves public/ before requests reach the
 * function; this covers local runs and tests.
 *
 * Only existing files are served, so API routes are unaffected. `extensions`
 * maps the site's clean URLs (`/demo`) to their files (`demo.html`).
 */
export const SITE_DIR = join(process.cwd(), 'public');

export function serveSite(app: NestExpressApplication): void {
  app.useStaticAssets(SITE_DIR, { extensions: ['html'] });
}
