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
/** The vector street map that the Leaflet layer draws. */
interface StreetMap {
  on(type: 'style.load', callback: () => void): void;
  setLayoutProperty(layer: string, name: 'text-field', value: unknown): void;
}
interface StreetMapLayer {
  addTo(map: JournalMap): StreetMapLayer;
  getMaplibreMap(): StreetMap;
}
declare const maplibregl: {
  setWorkerUrl(url: string): void;
};
declare const L: {
  map(id: string, options: {
    zoomControl: boolean;
    scrollWheelZoom: boolean;
    trackResize: boolean;
    zoomSnap: number;
    maxZoom: number;
  }): JournalMap;
  maplibreGL(options: {
    style: object;
    attributionControl: {
      customAttribution: string;
    };
  }): StreetMapLayer;
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
    color: string;
    weight: number;
    dashArray: string | null;
    opacity: number;
  }): {
    addTo(layer: LayerGroup): void;
  };
};
