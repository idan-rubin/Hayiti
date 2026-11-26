const preferenceKey = 'hayiti-language';
const hebrewLocale = /^he(?:-|$)/i.test(navigator.languages?.[0] || navigator.language);
const supported = (value: unknown): value is 'he' | 'en' => value === 'en' || value === 'he';
function initialLanguage(): 'en' | 'he' {
  const requested = new URLSearchParams(location.search).get('lang');
  if (supported(requested)) {
    try {
      localStorage.setItem(preferenceKey, requested);
    } catch {}
    return requested;
  }
  try {
    const saved = localStorage.getItem(preferenceKey);
    if (supported(saved)) return saved;
  } catch {/* The control still works when browser storage is disabled. */}
  return hebrewLocale ? 'he' : 'en';
}
export let language = initialLanguage();
export const locale = () => language === 'he' ? 'he-IL' : 'en-US';

// Capture only the authored HTML, before trip records or user input enter the DOM.
export function bindLanguageControl(hebrew: Record<string, string>, onChange = () => {}) {
  const control = document.getElementById('languageSwitch');
  if (!(control instanceof HTMLSelectElement)) throw Error('Missing language selector');
  const bindings: Array<() => void> = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node instanceof Element && node.matches('script,style,template,#languageSwitch')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  function bind(original: string, set: (value: string) => void) {
    const key = original.trim();
    if (!Object.hasOwn(hebrew, key)) return;
    const translated = original.replace(key, () => hebrew[key]);
    bindings.push(() => set(language === 'he' ? translated : original));
  }
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      const text = node;
      bind(text.data, value => {
        text.data = value;
      });
    } else if (node instanceof Element) {
      const element = node;
      for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
        if (element.hasAttribute(attr)) bind(element.getAttribute(attr) ?? '', value => element.setAttribute(attr, value));
      }
    }
  }
  const apply = () => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'he' ? 'rtl' : 'ltr';
    for (const update of bindings) update();
    control.value = language;
    control.setAttribute('aria-label', language === 'he' ? 'שפה' : 'Language');
  };
  apply();
  control.addEventListener('change', () => {
    if (!supported(control.value)) return;
    language = control.value;
    try {
      localStorage.setItem(preferenceKey, language);
    } catch {}
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.set('lang', language);
      try {
        history.replaceState(history.state, '', url);
      } catch {}
    }
    apply();
    onChange();
  });
}
