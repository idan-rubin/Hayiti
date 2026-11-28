/**
 * The padding on two opposite edges of a map that is being fitted to a route: what covers each edge, plus a margin.
 * On a short or narrow map the two can add up to more than the map itself. That leaves the route no room, and the
 * fit answers by zooming in as far as it can. So the pair is cut back, in proportion, until `room` pixels stay free.
 */
export function fitPadding(size: number, before: number, after: number, margin: number, room = 48): [number, number] {
  const wanted = [before + margin, after + margin];
  const most = Math.max(0, size - Math.min(room, size));
  const scale = wanted[0] + wanted[1] > most ? most / (wanted[0] + wanted[1]) : 1;
  return [Math.floor(wanted[0] * scale), Math.floor(wanted[1] * scale)];
}
