import { isRecord } from '../domain/core.ts';

/** The street map under the journal's pins: OpenFreeMap vector tiles, with place names in the journal's language. */
const styleURL = 'https://tiles.openfreemap.org/styles/liberty';

type Language = 'en' | 'he';
/** Why the street map is missing, or null when it is drawn. */
export type StreetMapProblem = 'unreachable' | 'unsupported' | null;

/** A label that prefers the journal's language and falls back to the name used locally. */
export function nameIn(language: Language): unknown[] {
  return language === 'en'
    ? ['coalesce', ['get', 'name:en'], ['get', 'name:latin'], ['get', 'name']]
    : ['coalesce', ['get', 'name:' + language], ['get', 'name']];
}

/** The layers whose label is a place name. Road numbers and other labels keep their own text. */
export function nameLayers(layers: unknown[]): string[] {
  return layers.flatMap(layer => isRecord(layer) && layer.type === 'symbol' && typeof layer.id === 'string' && isRecord(layer.layout)
    && JSON.stringify(layer.layout['text-field'] ?? null).includes('name') ? [layer.id] : []);
}

/**
 * Fits the provider's style to the journal: place names in the journal's language, and neither raised
 * buildings nor the provider's own points of interest, so the journal's pins and routes stay easy to see.
 * Returns the layers that carry place names.
 */
export function prepareStyle(style: unknown, language: Language): string[] {
  if (!isRecord(style) || !Array.isArray(style.layers)) throw Error('Street map style unavailable');
  const layers: unknown[] = style.layers.filter(layer => !isRecord(layer) || (layer.type !== 'fill-extrusion' && layer['source-layer'] !== 'poi'));
  style.layers = layers;
  const names = nameLayers(layers);
  for (const layer of layers) {
    if (isRecord(layer) && isRecord(layer.layout) && names.includes(String(layer.id))) layer.layout['text-field'] = nameIn(language);
  }
  return names;
}

/**
 * Draws the street map and reports whether it could. Returns a function that puts the place names
 * in the journal's current language.
 */
export function addStreetMap(map: JournalMap, language: () => Language, report: (problem: StreetMapProblem) => void) {
  let street: StreetMap | null = null,
    names: string[] = [],
    styled = false,
    loading = false;
  const relabel = () => {
    if (street && styled) for (const id of names) street.setLayoutProperty(id, 'text-field', nameIn(language()));
  };
  async function load() {
    if (street || loading) return;
    const canvas = document.createElement('canvas');
    if (!canvas.getContext('webgl2') && !canvas.getContext('webgl')) {
      report('unsupported');
      return;
    }
    loading = true;
    let style: object;
    try {
      const response = await fetch(styleURL);
      if (!response.ok) throw Error('Street map style unavailable');
      const received: unknown = await response.json();
      names = prepareStyle(received, language());
      if (!isRecord(received)) throw Error('Street map style unavailable');
      style = received;
    } catch {
      // Offline, the pins and routes are drawn without streets. The map is tried again when the connection returns.
      report('unreachable');
      return;
    } finally {
      loading = false;
    }
    try {
      street = L.maplibreGL({ style }).addTo(map).getMaplibreMap();
    } catch {
      report('unsupported');
      return;
    }
    report(null);
    street.on('style.load', () => {
      styled = true;
      // The traveler may have switched language while the style was loading.
      relabel();
    });
  }
  // The portable journal carries the library's worker as text. The hosted journal serves it as a file.
  const worker = document.querySelector('script[data-part="street-map-worker"]');
  maplibregl.setWorkerUrl(worker
    ? URL.createObjectURL(new Blob([worker.textContent ?? ''], { type: 'text/javascript' }))
    : new URL('vendor/maplibre-gl-worker.js', document.baseURI).href);
  window.addEventListener('online', () => void load());
  void load();
  return relabel;
}
