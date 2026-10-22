declare module 'martinez-polygon-clipping' {
  type Position = [number, number];
  type Ring = Position[];
  type Polygon = Ring[];
  type MultiPolygon = Polygon[];

  export function union(subject: MultiPolygon, clipping: MultiPolygon): MultiPolygon | null;
  export function diff(subject: MultiPolygon, clipping: MultiPolygon): MultiPolygon | null;
  export function intersection(subject: MultiPolygon, clipping: MultiPolygon): MultiPolygon | null;
  export function xor(subject: MultiPolygon, clipping: MultiPolygon): MultiPolygon | null;
}
