import { language, locale } from './language.ts';

/**
 * The trip's days as a row of buttons, one per day, beside the menu that lists every date.
 * The row scrolls sideways on a long trip and keeps the chosen day in view.
 */
export function createDayStrip(strip: HTMLElement, menu: HTMLSelectElement, progress: HTMLElement, format: (day: string, style: 'full' | 'short') => string, onChange: (day: string) => void) {
  let dates: string[] = [],
    current = -1,
    overview = false;
  const progressLabel = (index: number) => language === 'he' ? 'יום ' + (index + 1) + ' מתוך ' + dates.length : 'Day ' + (index + 1) + ' of ' + dates.length;
  const clamp = (index: number) => Math.max(0, Math.min(dates.length - 1, index));
  const days = () => [...strip.querySelectorAll('button')];
  function mark() {
    for (const [index, day] of days().entries()) {
      day.setAttribute('aria-pressed', String(!overview && index === current));
      // One day takes the Tab key. The arrow keys reach the rest.
      day.tabIndex = index === current ? 0 : -1;
    }
  }
  function select(index: number, notify: boolean) {
    current = index;
    menu.selectedIndex = index;
    progress.textContent = progressLabel(index);
    mark();
    const day = days()[index];
    // Scrolling the row itself leaves the panel around it where it is.
    strip.scrollTo({ left: day.offsetLeft - (strip.clientWidth - day.offsetWidth) / 2 });
    if (notify) onChange(dates[index]);
  }
  strip.addEventListener('click', event => {
    const day = event.target instanceof Element ? event.target.closest('button') : null;
    // Choosing the day already shown still leaves the whole-trip view.
    if (day) select(days().indexOf(day), true);
  });
  strip.addEventListener('keydown', event => {
    const forward = getComputedStyle(strip).direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = forward === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
    const shortcuts: Record<string, number> = {
      [back]: current - 1,
      [forward]: current + 1,
      Home: 0,
      End: dates.length - 1,
      PageUp: current - 7,
      PageDown: current + 7
    };
    const index = shortcuts[event.key];
    if (index === undefined || !dates.length) return;
    event.preventDefault();
    select(clamp(index), clamp(index) !== current || overview);
    days()[current].focus();
  });
  menu.addEventListener('change', () => select(menu.selectedIndex, true));
  return {
    set(list: string[], selected: string, notes: string[] = []) {
      dates = list;
      const weekday = new Intl.DateTimeFormat(locale(), { weekday: language === 'he' ? 'narrow' : 'short', timeZone: 'UTC' });
      const month = new Intl.DateTimeFormat(locale(), { month: 'short', timeZone: 'UTC' });
      const labels = list.map(day => format(day, 'full'));
      menu.replaceChildren(...labels.map((label, i) => new Option(notes[i] ? label + ' · ' + notes[i] : label, list[i])));
      strip.replaceChildren(...list.flatMap((day, index) => {
        const date = new Date(day + 'T12:00:00Z');
        const button = document.createElement('button'),
          name = document.createElement('small'),
          number = document.createElement('b');
        button.type = 'button';
        button.dataset.day = day;
        button.setAttribute('aria-label', [labels[index], notes[index], progressLabel(index)].filter(Boolean).join(' · '));
        // A dot marks a day that has something recorded.
        if (notes[index]) button.dataset.recorded = '';
        name.textContent = weekday.format(date);
        number.textContent = String(date.getUTCDate());
        button.append(name, number);
        // The list below names the month. The strip names it only where a new one begins.
        if (!index || date.getUTCDate() !== 1) return [button];
        const heading = document.createElement('span');
        heading.textContent = month.format(date);
        heading.setAttribute('aria-hidden', 'true');
        return [heading, button];
      }));
      strip.parentElement!.hidden = !list.length;
      if (!list.length) {
        progress.textContent = '';
        current = -1;
        return;
      }
      select(clamp(list.indexOf(selected)), false);
    },
    /** The whole-trip view shows every day at once, so no single day is marked as chosen. */
    showAll(value: boolean) {
      overview = value;
      mark();
    }
  };
}
