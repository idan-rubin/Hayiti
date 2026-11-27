import type { Point } from '../domain/core.ts';

/** A pan or a click in a neighbouring copy of the world can produce longitudes outside ±180. */
export function wrapLongitude(longitude: number): number {
  if (longitude >= -180 && longitude <= 180) return longitude;
  return longitude - 360 * Math.floor((longitude + 180) / 360);
}

/** Use the smallest longitude span containing the visible pins, including trips across the date line. */
export function projectMapPoints(points: Point[]): (point: Point) => Point {
  const longitudes = points.map(point => point[1]).sort((a, b) => a - b);
  if (!longitudes.length) return point => point;
  const first = longitudes[0], last = longitudes[longitudes.length - 1];
  // Keep the world in its usual position when the largest empty interval already contains the date line.
  let gap = first + 360 - last;
  let start = first;
  for (let i = 1; i < longitudes.length; i++) {
    const interval = longitudes[i] - longitudes[i - 1];
    if (interval > gap) {
      gap = interval;
      start = longitudes[i];
    }
  }
  const center = wrapLongitude(start + (360 - gap) / 2);
  return point => {
    const worlds = Math.round((center - point[1]) / 360);
    return worlds ? [point[0], point[1] + 360 * worlds] : point;
  };
}
