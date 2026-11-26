import { isRecord } from '../domain/core.ts';

/** The street map under the journal's pins: OpenFreeMap vector tiles, with place names in the journal's language. */
const styleURL = 'https://tiles.openfreemap.org/styles/liberty';

// The credit line is written here. The style and its tile sources carry their own credit text, which the
// map layer would otherwise insert into the page as markup.
const credit = '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a>'
  + ' Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

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

// The hosted journal downloads the map library as these files, in this order. The portable journal carries them.
const libraryFiles = ['vendor/maplibre-gl.js', 'vendor/leaflet-maplibre-gl.js'];

function download(file: string) {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL(file, document.baseURI).href;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(Error('Street map library unavailable'));
    };
    document.head.append(script);
  });
}

/**
 * Draws the street map and reports whether it could. Returns a function that puts the place names
 * in the journal's current language.
 */
export function addStreetMap(map: JournalMap, language: () => Language, report: (problem: StreetMapProblem) => void) {
  let layer: StreetMapLayer | null = null,
    street: StreetMap | null = null,
    names: string[] = [],
    styled = false,
    loading = false,
    incomplete = false;
  const relabel = () => {
    if (street && styled) for (const id of names) street.setLayoutProperty(id, 'text-field', nameIn(language()));
  };
  async function load() {
    if (layer || loading) return;
    // The library draws with the second version of WebGL only.
    if (!document.createElement('canvas').getContext('webgl2')) {
      report('unsupported');
      return;
    }
    loading = true;
    let style: object,
      library: MapLibrary,
      makeLayer: StreetMapLayerFactory;
    try {
      // Both files run again when either is missing, because the layer keeps the library it was loaded with.
      if (typeof maplibregl === 'undefined' || !L.maplibreGL) for (const file of libraryFiles) await download(file);
      if (typeof maplibregl === 'undefined' || !L.maplibreGL) throw Error('Street map library unavailable');
      library = maplibregl;
      makeLayer = L.maplibreGL;
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
    // The portable journal carries the library's worker as text. The hosted journal serves it as a file.
    const worker = document.querySelector('script[data-part="street-map-worker"]');
    library.setWorkerUrl(worker
      ? URL.createObjectURL(new Blob([worker.textContent ?? ''], { type: 'text/javascript' }))
      : new URL('vendor/maplibre-gl-worker.js', document.baseURI).href);
    const made = makeLayer({ style, attributionControl: { customAttribution: credit } });
    try {
      made.addTo(map);
    } catch {
      // A layer that could not start would go on following the map and fail on every move, which misplaces the pins.
      map.off(made.getEvents(), made);
      made.getContainer().remove();
      report('unsupported');
      return;
    }
    layer = made;
    street = made.getMaplibreMap();
    report(null);
    street.on('style.load', () => {
      styled = true;
      // The traveler may have switched language while the style was loading.
      relabel();
    });
    // The style can arrive and the streets it points to still fail, all of them or some tiles.
    street.on('error', event => {
      if (event.sourceId === undefined) return;
      incomplete = true;
      report('unreachable');
    });
  }
  window.addEventListener('online', () => {
    // Streets that failed to load are drawn again from the start.
    if (layer && incomplete) {
      map.removeLayer(layer);
      layer = street = null;
      styled = incomplete = false;
    }
    void load();
  });
  void load();
  return relabel;
}
