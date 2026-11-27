/** Subset of the browser APIs of Leaflet and MapLibre GL JS used by the journal. The build supplies the pinned distributions. */
type Coordinates = import('../domain/core.ts').Point;
interface MapPoint {
  equals(other: MapPoint): boolean;
}
interface Bounds {
  extend(points: Coordinates | Coordinates[]): Bounds;
  isValid(): boolean;
  getSouthWest(): MapPoint;
  getNorthEast(): MapPoint;
  getCenter(): MapPoint;
}
interface JournalMap {
  createPane(name: string): HTMLElement;
  setView(position: Coordinates | MapPoint, zoom: number, options?: {
    animate: boolean;
  }): JournalMap;
  getContainer(): HTMLElement;
  stop(): void;
  invalidateSize(options: {
    animate: boolean;
    pan: boolean;
  }): void;
  fitBounds(bounds: Bounds, options: {
    padding: Coordinates;
    maxZoom: number;
    animate: boolean;
  }): void;
  closePopup(): void;
  removeLayer(layer: StreetMapLayer): void;
  off(events: object, context: object): void;
  on(type: 'click', callback: (event: {
    latlng: {
      lat: number;
      lng: number;
    };
  }) => void): void;
}
interface LayerGroup {
  addTo(map: JournalMap): LayerGroup;
  clearLayers(): void;
}
interface MapMarker {
  addTo(layer: LayerGroup): MapMarker;
  bindPopup(content: HTMLElement): MapMarker;
  openPopup(): MapMarker;
  on(type: 'click', callback: () => void): MapMarker;
}
/** A tile of the street map, of any kind. The library counts the views that use it, and none do once it has left the view. */
interface StreetTile {
  state: string;
  uses: number;
}
/** The vector street map that the Leaflet layer draws. */
interface StreetMap {
  on(type: 'style.load', callback: () => void): void;
  on(type: 'error', callback: (event: {
    sourceId?: string;
    tile?: StreetTile;
  }) => void): void;
  on(type: 'idle', callback: () => void): void;
  setLayoutProperty(layer: string, name: 'text-field', value: unknown): void;
}
interface StreetMapLayer {
  addTo(map: JournalMap): StreetMapLayer;
  getMaplibreMap(): StreetMap;
  getEvents(): object;
  getContainer(): HTMLElement;
}
interface MapLibrary {
  setWorkerUrl(url: string): void;
}
type StreetMapLayerFactory = (options: {
  style: object;
  attributionControl: {
    customAttribution: string;
  };
}) => StreetMapLayer;
/** Absent when the hosted journal could not download the library. */
declare const maplibregl: MapLibrary | undefined;
declare const L: {
  map(id: string, options: {
    zoomControl: boolean;
    scrollWheelZoom: boolean;
    trackResize: boolean;
    zoomSnap: number;
    maxZoom: number;
  }): JournalMap;
  maplibreGL?: StreetMapLayerFactory;
  layerGroup(): LayerGroup;
  latLngBounds(points: Coordinates[]): Bounds;
  divIcon(options: {
    className: string;
    html: string;
    iconSize: Coordinates;
    iconAnchor: Coordinates;
  }): object;
  marker(point: Coordinates, options: {
    icon: object;
    title: string;
    alt: string;
  }): MapMarker;
  polyline(points: Coordinates[], options: {
    pane: string;
    color: string;
    weight: number;
    dashArray: string | null;
    opacity: number;
  }): {
    addTo(layer: LayerGroup): void;
  };
};
