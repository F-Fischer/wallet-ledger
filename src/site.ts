import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';

/**
 * The docs site and the demo, built by VitePress into public/ (`pnpm docs:build`,
 * part of `pnpm build`). Relative to the project root, like migrations/: the app
 * runs from there. This serves it everywhere: locally, in tests, and on Vercel,
 * where the NestJS function receives the site's requests too.
 *
 * Only existing files are served, so API routes are unaffected. `extensions`
 * maps the site's clean URLs (`/demo`) to their files (`demo.html`). Files under
 * assets/ have a content hash in their name, so browsers and the CDN may keep
 * them forever; pages are revalidated so a deploy shows up at once.
 */
export const SITE_DIR = join(process.cwd(), 'public');

export function serveSite(app: NestExpressApplication): void {
  app.useStaticAssets(SITE_DIR, {
    extensions: ['html'],
    setHeaders: (res, path) => {
      if (path.startsWith(join(SITE_DIR, 'assets'))) {
        res.setHeader(
          'Cache-Control',
          'public, max-age=31536000, s-maxage=31536000, immutable',
        );
      }
    },
  });
}
