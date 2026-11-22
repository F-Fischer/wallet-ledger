import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import { inBrowser } from 'vitepress';
import './custom.css';

/**
 * Renders ```mermaid blocks (emitted as <pre class="mermaid"> by the fence rule
 * in config.ts). Mermaid is ~2 MB, so it's imported only on pages that have a
 * diagram, and diagrams are redrawn when the light/dark theme changes.
 */
async function renderMermaid(): Promise<void> {
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'default';
  const blocks = [...document.querySelectorAll<HTMLElement>('pre.mermaid')].filter(
    (block) => block.dataset.theme !== theme,
  );
  if (blocks.length === 0) return;
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, theme });
  for (const block of blocks) {
    // Keep the source so the diagram can be redrawn after a theme switch.
    block.dataset.source ??= block.textContent ?? '';
    block.removeAttribute('data-processed');
    block.textContent = block.dataset.source;
    block.dataset.theme = theme;
  }
  await mermaid.run({ nodes: blocks });
}

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    if (!inBrowser) return;
    // Page load, route changes and theme switches can fire together: run one
    // render at a time so two passes never draw into the same block.
    let queue = Promise.resolve();
    const render = () => {
      queue = queue.then(renderMermaid).catch((err) => console.error(err));
    };
    router.onAfterRouteChange = () => setTimeout(render);
    window.addEventListener('load', render);
    new MutationObserver(render).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  },
} satisfies Theme;
