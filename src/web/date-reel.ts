import { language } from './language.ts';
export function createDateReel(reel: HTMLElement, menu: HTMLSelectElement, format: (day: string, style: 'full' | 'short') => string, onChange: (day: string) => void) {
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
    reel.setAttribute('aria-valuetext', menu.options[index].text + ', ' + progressLabel(index));
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
  menu.addEventListener('change', () => jump(menu.selectedIndex));
  // `notes` adds a short remark to each date in the list, such as how many stops the day holds.
  return (days: string[], selected: string, notes: string[] = []) => {
    dates = days;
    const labels = days.map(day => format(day, 'full'));
    menu.replaceChildren(...labels.map((label, i) => new Option(notes[i] ? label + ' · ' + notes[i] : label, days[i])));
    reel.replaceChildren(...labels.map((label, index) => {
      const row = document.createElement('div'),
        face = document.createElement('span');
      row.setAttribute('aria-hidden', 'true');
      if (language === 'en') {
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
      const progress = document.createElement('small');
      progress.textContent = progressLabel(index);
      face.append(progress);
      row.append(face);
      return row;
    }));
    reel.parentElement!.hidden = !days.length;
    if (!days.length) {
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
