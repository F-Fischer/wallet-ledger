// Checks the built docs site (public/, from `pnpm docs:build`) for internal
// links that point to a missing page or a missing #anchor. VitePress' own
// dead-link check covers pages but not anchors. No dependencies: it reads the
// generated HTML. Usage: `pnpm docs:check`. Exits 1 if anything is broken.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, posix } from 'node:path';

const SITE = join(process.cwd(), 'public');
if (!existsSync(join(SITE, 'index.html'))) {
  console.error('public/index.html not found: run `pnpm docs:build` first');
  process.exit(1);
}

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'assets') yield* htmlFiles(path);
    } else if (name.endsWith('.html')) yield path;
  }
}

// Clean URL for a file: index.html -> dir/, page.html -> page
const urlOf = (file) => {
  const rel = relative(SITE, file).split('\\').join('/');
  return '/' + rel.replace(/(^|\/)index\.html$/, '$1').replace(/\.html$/, '');
};
// File for a clean URL, the way src/site.ts resolves it.
const fileOf = (url) => {
  const path = decodeURIComponent(url).replace(/^\//, '');
  const candidates = [path, `${path}.html`, join(path, 'index.html')];
  return candidates.map((c) => join(SITE, c)).find((c) => existsSync(c) && statSync(c).isFile());
};

const pages = new Map(); // file -> { ids, links }
for (const file of htmlFiles(SITE)) {
  const html = readFileSync(file, 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const links = [...html.matchAll(/<a\s[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  pages.set(file, { ids, links });
}

const problems = [];
for (const [file, { links }] of pages) {
  const from = urlOf(file);
  for (const raw of links) {
    if (/^(https?:|mailto:|tel:|\/\/|javascript:)/.test(raw)) continue;
    const href = raw.replace(/&amp;/g, '&');
    const [pathPart, hash] = href.split('#');
    let targetUrl = from;
    if (pathPart) {
      targetUrl = pathPart.startsWith('/')
        ? pathPart
        : posix.join(from.endsWith('/') ? from : posix.dirname(from), pathPart);
    }
    const target = fileOf(targetUrl);
    if (!target) {
      problems.push(`${from} -> ${href}: no such page`);
      continue;
    }
    if (hash && target.endsWith('.html')) {
      const ids = pages.get(target)?.ids ?? new Set();
      if (!ids.has(decodeURIComponent(hash))) problems.push(`${from} -> ${href}: no #${hash} on that page`);
    }
  }
}

const count = pages.size;
if (problems.length) {
  console.error(`${problems.length} broken link(s) in ${count} pages:`);
  for (const p of [...new Set(problems)]) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`ok: ${count} pages, every internal link and anchor resolves`);
