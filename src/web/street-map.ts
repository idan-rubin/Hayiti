import { isRecord } from '../domain/core.ts';

/** The street map under the journal's pins: OpenFreeMap vector tiles, with place names in the journal's language. */
const styleURL = 'https://tiles.openfreemap.org/styles/liberty';

// The credit line is written here. The style and its tile sources carry their own credit text, which the
// map layer would otherwise insert into the page as markup.
const credit = '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://openmaptiles.org/">OpenMapTiles</a>'
  + ' Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

type Language = 'en' | 'he';
export type Basemap = 'streets' | 'satellite' | 'terrain';
export function isBasemap(value: string): value is Basemap {
  return value === 'streets' || value === 'satellite' || value === 'terrain';
}
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

// Switching away during a download must not start two copies of the same map library.
let libraryDownload: Promise<void> | undefined,
  portableWorkerUrl: string | undefined,
  supportsWebGL: boolean | undefined;
function loadLibrary() {
  libraryDownload ??= (async () => {
    for (const file of libraryFiles) await download(file);
  })().finally(() => { libraryDownload = undefined; });
  return libraryDownload;
}
function startStreets(map: JournalMap, language: () => Language, report: (problem: StreetMapProblem) => void) {
  let active = true,
    layer: StreetMapLayer | null = null,
    street: StreetMap | null = null,
    names: string[] = [],
    styled = false,
    loading = false,
    sourceFailed = false;
  // Tiles that failed to load. One that has left the view, or loaded on a later try, is no longer missing.
  const failedTiles = new Set<StreetTile>();
  const tilesMissing = () => {
    for (const tile of failedTiles) if (tile.uses === 0 || tile.state !== 'errored') failedTiles.delete(tile);
    return failedTiles.size > 0;
  };
  const relabel = () => {
    if (street && styled) for (const id of names) street.setLayoutProperty(id, 'text-field', nameIn(language()));
  };
  async function load() {
    if (layer || loading) return;
    // The library draws with the second version of WebGL only.
    supportsWebGL ??= Boolean(document.createElement('canvas').getContext('webgl2'));
    if (!supportsWebGL) {
      report('unsupported');
      return;
    }
    loading = true;
    let style: object,
      library: MapLibrary,
      makeLayer: StreetMapLayerFactory;
    try {
      // Both files run again when either is missing, because the layer keeps the library it was loaded with.
      if (typeof maplibregl === 'undefined' || !L.maplibreGL) await loadLibrary();
      if (!active) return;
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
      if (active) report('unreachable');
      return;
    } finally {
      loading = false;
    }
    if (!active) return;
    // The portable journal carries the library's worker as text. The hosted journal serves it as a file.
    const worker = document.querySelector('script[data-part="street-map-worker"]');
    library.setWorkerUrl(worker
      ? (portableWorkerUrl ??= URL.createObjectURL(new Blob([worker.textContent ?? ''], { type: 'text/javascript' })))
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
      if (layer !== made) return;
      styled = true;
      // The traveler may have switched language while the style was loading.
      relabel();
    });
    // The style can arrive and the streets it points to still fail, all of them or some tiles.
    street.on('error', event => {
      if (layer !== made || event.sourceId === undefined) return;
      if (event.tile) failedTiles.add(event.tile);
      else sourceFailed = true;
      report('unreachable');
    });
    // Once the map has drawn a view that no failed tile is part of, the streets in view are complete again.
    street.on('idle', () => {
      if (layer === made && !sourceFailed && !tilesMissing()) report(null);
    });
  }
  function reconnect() {
    // Streets that failed to load are drawn again from the start.
    if (layer && (sourceFailed || tilesMissing())) {
      map.removeLayer(layer);
      layer = street = null;
      styled = sourceFailed = false;
      failedTiles.clear();
    }
    void load();
  }
  window.addEventListener('online', reconnect);
  void load();
  return {
    relabel,
    remove() {
      active = false;
      window.removeEventListener('online', reconnect);
      const current = layer;
      layer = null;
      if (current) map.removeLayer(current);
    }
  };
}

const eoxTiles = 'https://tiles.maps.eox.at/wmts/1.0.0/';
const osmCredit = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const rasterStyles = {
  satellite: [
    {
      url: eoxTiles + 's2cloudless_3857/default/g/{z}/{y}/{x}.jpg',
      maxNativeZoom: 14,
      attribution: '<a href="https://cloudless.eox.at/">EOxCloudless</a> by EOX IT Services GmbH'
        + ' (Contains modified Copernicus Sentinel data 2016), <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>'
    },
    {
      url: eoxTiles + 'overlay_bright_3857/default/g/{z}/{y}/{x}.png',
      maxNativeZoom: 14,
      attribution: '<a href="https://maps.eox.at/">Overlay</a>: ' + osmCredit
        + ', rendering © <a href="https://eox.at/">EOX</a> and <a href="https://github.com/mapserver/basemaps">MapServer</a>'
    }
  ],
  terrain: [{
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 17,
    attribution: osmCredit + ', SRTM | © <a href="https://opentopomap.org/">OpenTopoMap</a>'
      + ' (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA</a>)'
  }]
};

// Leaflet draws these image tiles directly, including on devices that cannot start the vector street map.
function startRaster(map: JournalMap, style: 'satellite' | 'terrain', report: (problem: StreetMapProblem) => void) {
  const failedTiles = new Set<HTMLElement>();
  const layers = rasterStyles[style].map(({ url, maxNativeZoom, attribution }) => {
    const layer = L.tileLayer(url, { maxNativeZoom, maxZoom: 19, attribution });
    layer.on('tileerror', ({ tile }) => {
      failedTiles.add(tile);
      report('unreachable');
    });
    layer.on('tileunload', ({ tile }) => {
      if (failedTiles.delete(tile) && !failedTiles.size) report(null);
    });
    return layer.addTo(map);
  });
  function reconnect() {
    if (failedTiles.size) for (const layer of layers) layer.redraw();
  }
  window.addEventListener('online', reconnect);
  return {
    remove() {
      window.removeEventListener('online', reconnect);
      for (const layer of layers) layer.remove();
    }
  };
}

/** Changes only the map background. The Leaflet camera, route lines and pin layers stay in place. */
export function addStreetMap(map: JournalMap, language: () => Language, report: (problem: StreetMapProblem) => void) {
  let selected: Basemap = 'streets';
  let background: { remove(): void; relabel?(): void } = startStreets(map, language, report);
  return {
    relabel() { background.relabel?.(); },
    select(style: Basemap) {
      if (style === selected) return;
      selected = style;
      background.remove();
      report(null);
      background = style === 'streets' ? startStreets(map, language, report) : startRaster(map, style, report);
    }
  };
}
