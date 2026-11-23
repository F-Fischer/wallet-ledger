/**
 * Click a Mermaid diagram to open it full screen. Zoom with the wheel, the
 * +/- buttons, keyboard (+, -, 0) or a two-finger pinch; drag to pan. Esc, the
 * close button or a click on the backdrop closes it. No dependencies: the SVG
 * is cloned into an overlay and moved with a CSS transform.
 */

const MIN = 0.2;
const MAX = 8;

let overlay: HTMLElement | null = null;

export function setupDiagramZoom(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    const block = target?.closest<HTMLElement>('.vp-doc pre.mermaid[data-processed="true"]');
    const svg = block?.querySelector('svg');
    if (svg && !overlay) open(svg);
  });
}

function open(source: SVGSVGElement): void {
  const box = source.getBoundingClientRect();
  const svg = source.cloneNode(true) as SVGSVGElement;
  // Draw at the diagram's natural size; the transform does the scaling.
  const natural = source.viewBox.baseVal;
  const width = natural?.width || box.width;
  const height = natural?.height || box.height;
  svg.removeAttribute('style');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));

  const stage = el('div', 'dz-stage');
  stage.append(svg);
  const label = el('span', 'dz-scale');
  const toolbar = el('div', 'dz-toolbar');
  const button = (text: string, title: string, onClick: () => void) => {
    const b = el('button', 'dz-button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };

  overlay = el('div', 'dz-overlay');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Diagram, zoomable');
  overlay.tabIndex = -1;
  overlay.append(stage, toolbar);
  document.body.append(overlay);
  document.documentElement.classList.add('dz-open');

  // Fit the whole diagram in the viewport, with a margin.
  const fit = () => {
    const pad = 48;
    const s = Math.min(
      (window.innerWidth - pad * 2) / width,
      (window.innerHeight - pad * 2 - 56) / height,
      MAX,
    );
    view.scale = Math.max(MIN, s);
    view.x = (window.innerWidth - width * view.scale) / 2;
    view.y = (window.innerHeight - 56 - height * view.scale) / 2;
    apply();
  };
  const view = { scale: 1, x: 0, y: 0 };
  const apply = () => {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    label.textContent = `${Math.round(view.scale * 100)}%`;
  };
  // Zoom keeping the point under (cx, cy) fixed on screen.
  const zoomAt = (factor: number, cx: number, cy: number) => {
    const next = Math.min(MAX, Math.max(MIN, view.scale * factor));
    const k = next / view.scale;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.scale = next;
    apply();
  };
  const center = () => [window.innerWidth / 2, (window.innerHeight - 56) / 2] as const;

  toolbar.append(
    button('−', 'Zoom out', () => zoomAt(1 / 1.25, ...center())),
    label,
    button('+', 'Zoom in', () => zoomAt(1.25, ...center())),
    button('Fit', 'Fit to screen', fit),
    button('✕', 'Close', close),
  );

  overlay.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    { passive: false },
  );

  // Pan with one pointer, pinch-zoom with two.
  const pointers = new Map<number, { x: number; y: number }>();
  let moved = false;
  overlay.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.dz-toolbar')) return;
    overlay!.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
  });
  overlay.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      view.x += e.clientX - prev.x;
      view.y += e.clientY - prev.y;
      apply();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.entries()].map(([id, p]) =>
        id === e.pointerId ? { x: e.clientX, y: e.clientY } : p,
      );
      const [pa, pb] = [...pointers.values()];
      const before = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      const after = Math.hypot(a.x - b.x, a.y - b.y);
      if (before > 0) zoomAt(after / before, (a.x + b.x) / 2, (a.y + b.y) / 2);
    }
    if (Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y) > 2) moved = true;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  const release = (e: PointerEvent) => pointers.delete(e.pointerId);
  overlay.addEventListener('pointerup', release);
  overlay.addEventListener('pointercancel', release);
  // A click on the backdrop (not a drag, not on the diagram) closes.
  overlay.addEventListener('click', (e) => {
    if (!moved && e.target === overlay) close();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === '+' || e.key === '=') zoomAt(1.25, ...center());
    else if (e.key === '-') zoomAt(1 / 1.25, ...center());
    else if (e.key === '0') fit();
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);

  function close() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', fit);
    document.documentElement.classList.remove('dz-open');
    overlay?.remove();
    overlay = null;
  }

  fit();
  overlay.focus();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string) {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
