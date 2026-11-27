import { language } from './language.ts';

export type SheetStop = 'peek' | 'half' | 'full';

/**
 * On a narrow screen the panel is a sheet over the map. It rests at one of three heights,
 * chosen with the handle: a tap steps between them and a drag settles on the nearest.
 * On a wide screen the panel sits beside the route and this height is unused.
 */
export function createSheet(panel: HTMLElement, handle: HTMLButtonElement, peek: () => number) {
  const narrow = matchMedia('(max-width: 820px)');
  let stop: SheetStop = 'half',
    drag: { y: number, height: number, moved: boolean } | null = null,
    dragged = false;
  // The full sheet leaves the bar above it uncovered. The lowest stop is as tall as the caller says the trip's heading is.
  const heights = () => {
    const full = Math.max(240, innerHeight - 64);
    return { peek: Math.min(full, Math.max(96, peek())), half: Math.round(innerHeight * .55), full };
  };
  const setHeight = (pixels: number) => document.documentElement.style.setProperty('--sheet', pixels + 'px');
  function rest(next: SheetStop) {
    stop = next;
    document.body.dataset.sheet = next;
    setHeight(heights()[next]);
    handle.setAttribute('aria-expanded', String(next === 'full'));
    handle.setAttribute('aria-label', next === 'full'
      ? language === 'he' ? 'הקטנת הרשימה כדי לראות את המפה' : 'Lower the list to see the map'
      : language === 'he' ? 'הגדלת הרשימה' : 'Raise the list');
  }
  handle.addEventListener('pointerdown', event => {
    drag = { y: event.clientY, height: panel.getBoundingClientRect().height, moved: false };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag) return;
    const raised = drag.y - event.clientY;
    if (Math.abs(raised) > 6) drag.moved = true;
    if (!drag.moved) return;
    const { peek, full } = heights();
    panel.dataset.dragging = '';
    setHeight(Math.max(peek, Math.min(full, drag.height + raised)));
  });
  function release() {
    if (!drag) return;
    dragged = drag.moved;
    drag = null;
    delete panel.dataset.dragging;
    if (!dragged) return;
    const height = panel.getBoundingClientRect().height;
    const nearest = Object.entries(heights()).sort((a, b) => Math.abs(a[1] - height) - Math.abs(b[1] - height))[0][0];
    rest(nearest as SheetStop);
  }
  handle.addEventListener('pointerup', release);
  handle.addEventListener('pointercancel', release);
  handle.addEventListener('click', () => {
    // The click that ends a drag has already been answered.
    if (dragged) dragged = false;
    else rest(stop === 'half' ? 'full' : 'half');
  });
  addEventListener('resize', () => rest(stop));
  rest(stop);
  return {
    get stop() {
      return stop;
    },
    get narrow() {
      return narrow.matches;
    },
    /**
     * How much of the map the sheet covers, known before its transition ends.
     * A full sheet hides the whole map, so this is the half height the handle lowers it to next.
     */
    get cover() {
      return narrow.matches ? heights()[stop === 'full' ? 'half' : stop] : 0;
    },
    rest,
    relabel: () => rest(stop)
  };
}
