import { language } from './language.ts';

/**
 * The trip's dates as a reel behind a one-line opening, turned like the wheel of a slot machine:
 * a swipe or the mouse wheel rolls it, and it settles on one date. The menu beside it lists every date.
 * The reel is one control to the keyboard: the arrow keys step a day, Page Up and Page Down step a week,
 * and Home and End reach the trip's first and last day.
 */
export function createDateReel(reel: HTMLElement, menu: HTMLSelectElement, progress: HTMLElement, format: (day: string, style: 'full' | 'short') => string, onChange: (day: string) => void) {
  let dates: string[] = [],
    current = -1,
    step = 0,
    frame = 0;
  const progressLabel = (index: number) => language === 'he' ? 'יום ' + (index + 1) + ' מתוך ' + dates.length : 'Day ' + (index + 1) + ' of ' + dates.length;
  const clamp = (index: number) => Math.max(0, Math.min(dates.length - 1, index));
  function select(index: number, notify: boolean) {
    current = index;
    menu.selectedIndex = index;
    reel.setAttribute('aria-valuenow', String(index + 1));
    // A trip of one day has nothing to count.
    const label = dates.length > 1 ? progressLabel(index) : '';
    progress.textContent = label;
    reel.setAttribute('aria-valuetext', [menu.options[index].text, label].filter(Boolean).join(', '));
    if (notify) onChange(dates[index]);
  }
  function paint() {
    if (!step || !dates.length) return;
    const position = Math.max(0, Math.min(dates.length - 1, reel.scrollTop / step));
    const nearest = Math.round(position);
    // Only two faces can be seen through the single-line opening.
    for (let i = Math.floor(position); i <= Math.ceil(position); i++) {
      const tilt = (position - i) * 56;
      (reel.children[i].firstElementChild as HTMLElement).style.setProperty('--tilt', tilt + 'deg');
    }
    if (nearest !== current) select(nearest, true);
  }
  function jump(index: number) {
    if (!dates.length) return;
    index = clamp(index);
    reel.scrollTop = index * step;
    select(index, index !== current);
    paint();
  }
  function measure() {
    if (!reel.firstElementChild) return;
    const height = reel.firstElementChild.getBoundingClientRect().height;
    if (!height || height === step) return;
    step = height;
    jump(current);
  }
  new ResizeObserver(measure).observe(reel);
  reel.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  }, {
    passive: true
  });
  reel.addEventListener('keydown', event => {
    const shortcuts: Record<string, number> = {
      ArrowUp: current - 1,
      ArrowDown: current + 1,
      Home: 0,
      End: dates.length - 1,
      PageUp: current - 7,
      PageDown: current + 7
    };
    const index = shortcuts[event.key];
    if (index === undefined) return;
    event.preventDefault();
    jump(index);
  });
  // A tap on the date that already shows asks for that day again. The whole-trip view answers by returning to it.
  reel.addEventListener('click', () => {
    if (current >= 0) onChange(dates[current]);
  });
  menu.addEventListener('change', () => jump(menu.selectedIndex));
  /** `notes` name each day's stops and entries. `extras` name what else is recorded for it, outside its route. */
  return (days: string[], selected: string, notes: string[] = [], extras: string[] = []) => {
    dates = days;
    const labels = days.map(day => format(day, 'full'));
    menu.replaceChildren(...labels.map((label, i) => new Option([label, notes[i], extras[i]].filter(Boolean).join(' · '), days[i])));
    reel.replaceChildren(...labels.map((label, index) => {
      const row = document.createElement('div'),
        face = document.createElement('span');
      row.setAttribute('aria-hidden', 'true');
      // A day with something recorded stands out as the reel turns past it.
      if (notes[index] || extras[index]) row.dataset.recorded = '';
      if (language === 'en') {
        // A narrow opening shows the date in its short form.
        const full = document.createElement('b'),
          short = document.createElement('b');
        full.className = 'date-full';
        full.textContent = label;
        short.className = 'date-short';
        short.textContent = format(days[index], 'short');
        face.append(full, short);
      } else {
        face.textContent = label;
      }
      row.append(face);
      return row;
    }));
    reel.parentElement!.hidden = !days.length;
    if (!days.length) {
      progress.textContent = '';
      current = -1;
      step = 0;
      return;
    }
    reel.setAttribute('aria-valuemax', String(days.length));
    select(clamp(days.indexOf(selected)), false);
    step = 0;
    measure();
  };
}
