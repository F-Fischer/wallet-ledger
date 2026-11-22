import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';

// The site is built into the repo's public/ folder: on Vercel that folder is
// served by the CDN next to the NestJS function, and locally the API serves
// it (see src/main.ts). public/ is generated, not committed.
const outDir = fileURLToPath(new URL('../../public', import.meta.url));

export default withMermaid(
  defineConfig({
    title: 'Wallet Ledger',
    description:
      'A USD wallet on a double-entry ledger: how to move money correctly with NestJS and Postgres.',
    lang: 'en-US',
    outDir,
    cleanUrls: true,
    lastUpdated: false,
    // Docs that only make sense in the repo, not on the site.
    srcExclude: ['**/README.md', 'ARCHITECTURE.md'],
    themeConfig: {
      nav: [
        { text: 'Demo', link: '/demo' },
        { text: 'Architecture', link: '/architecture/' },
        { text: 'Decisions', link: '/decisions/' },
        { text: 'Features', link: '/features/ledger-foundation' },
        { text: 'Roadmap', link: '/requirements/00-ledger-foundation' },
      ],
      sidebar: {
        '/features/': [
          {
            text: 'Features',
            items: [
              { text: 'Ledger foundation', link: '/features/ledger-foundation' },
              { text: 'Demo web page', link: '/features/demo-web' },
            ],
          },
        ],
        '/requirements/': [
          {
            text: 'Requirements',
            items: [
              { text: 'Ledger foundation', link: '/requirements/00-ledger-foundation' },
              { text: 'FX remittances', link: '/requirements/fx-remittances' },
              { text: 'Debit card', link: '/requirements/debit-card' },
            ],
          },
        ],
      },
      outline: { level: [2, 3] },
      search: { provider: 'local' },
      socialLinks: [{ icon: 'github', link: 'https://github.com/F-Fischer/wallet-ledger' }],
      footer: {
        message: 'Money is an integer number of cents. Every movement sums to zero.',
      },
    },
    mermaid: {},
  }),
);
