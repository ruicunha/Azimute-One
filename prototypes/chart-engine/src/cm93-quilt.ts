/**
 * Viewport-aware CM93 V2 cell selection for the experimental chart quilt.
 * Each target-scale footprint carries an ordered candidate chain from target
 * scale to coarser scales, allowing the renderer to fall back when a file is
 * missing, fails to decode, or decodes to no usable features.
 */
export type Cm93CellFile = {
  name: string;
  webkitRelativePath?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type Cm93ViewportBounds = { west: number; south: number; east: number; north: number };
export const CM93_SCALE_ORDER = ['Z', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type Cm93ScaleCode = typeof CM93_SCALE_ORDER[number];
export const CM93_SCALE_STEPS: Record<Cm93ScaleCode, number> = { Z: 120, A: 60, B: 30, C: 12, D: 3, E: 1, F: 1, G: 1 };

export function cm93ScaleForZoom(zoom: number): Cm93ScaleCode {
  if (zoom < 3.5) return 'Z';
  if (zoom < 4.5) return 'A';
  if (zoom < 5.5) return 'B';
  if (zoom < 7.5) return 'C';
  if (zoom < 9.5) return 'D';
  if (zoom < 11.5) return 'E';
  if (zoom < 13.5) return 'F';
  return 'G';
}

function normalizedLongitude(longitude: number): number {
  return ((longitude % 360) + 360) % 360;
}

function signedLongitude(longitude: number): number {
  const normalized = normalizedLongitude(longitude);
  return normalized > 180 ? normalized - 360 : normalized;
}

function pathForCell(latitudeCell: number, longitudeCell: number, scale: string): string {
  const cellLatitude = latitudeCell + 30;
  const rootLatitude = Math.floor((cellLatitude - 30) / 60) * 60 + 30;
  const rootLongitude = Math.floor(longitudeCell / 60) * 60;
  const root = String(rootLatitude).padStart(4, '0') + String(rootLongitude).padStart(4, '0');
  const filename = String(cellLatitude).padStart(4, '0') + String(longitudeCell).padStart(4, '0') + '.' + scale.toLowerCase();
  return '/' + root.toLowerCase() + '/' + scale.toLowerCase() + '/' + filename;
}

export type Cm93CellCandidate = { file: Cm93CellFile; scale: Cm93ScaleCode };
export type Cm93CellCandidateGroup = { bounds: Cm93ViewportBounds; candidates: Cm93CellCandidate[] };
export type Cm93ViewportSelection = {
  scale: Cm93ScaleCode;
  files: Cm93CellFile[];
  scaleCounts: Partial<Record<Cm93ScaleCode, number>>;
  candidateGroups: Cm93CellCandidateGroup[];
};

export function selectCm93ViewportCells(
  files: Cm93CellFile[],
  bounds: Cm93ViewportBounds,
  zoom: number,
  maxCells = 1200,
): Cm93ViewportSelection {
  const targetScale = cm93ScaleForZoom(zoom);
  const targetIndex = CM93_SCALE_ORDER.indexOf(targetScale);
  const targetStep = CM93_SCALE_STEPS[targetScale];
  const byPath = new Map<string, Cm93CellFile>();
  for (const file of files) {
    const parts = (file.webkitRelativePath || file.name).toLowerCase().split('/');
    byPath.set('/' + parts.slice(-3).join('/'), file);
  }

  const south = Math.max(-79.5, Math.min(bounds.south, bounds.north));
  const north = Math.min(80, Math.max(bounds.south, bounds.north));
  const longitudeSpan = Math.min(360, Math.max(0, bounds.east - bounds.west));
  const firstLatitudeCell = Math.floor((south * 3 + 240) / targetStep) * targetStep;
  const lastLatitudeCell = Math.floor((north * 3 + 240) / targetStep) * targetStep;
  const firstLongitudeCell = Math.floor((normalizedLongitude(bounds.west) * 3) / targetStep) * targetStep;
  const lastLongitudeCell = Math.floor((normalizedLongitude(bounds.west) * 3 + longitudeSpan * 3) / targetStep) * targetStep;

  const groups: Cm93CellCandidateGroup[] = [];
  const union = new Map<string, Cm93CellCandidate>();
  for (let latitudeCell = firstLatitudeCell; latitudeCell <= lastLatitudeCell; latitudeCell += targetStep) {
    for (let longitudeUnwrapped = firstLongitudeCell; longitudeUnwrapped <= lastLongitudeCell; longitudeUnwrapped += targetStep) {
      const longitudeCell = ((longitudeUnwrapped % 1080) + 1080) % 1080;
      const centerLatitude = (latitudeCell + targetStep / 2 - 240) / 3;
      const centerLongitude = normalizedLongitude((longitudeUnwrapped + targetStep / 2) / 3);
      const candidates: Cm93CellCandidate[] = [];
      for (let scaleIndex = targetIndex; scaleIndex >= 0; scaleIndex--) {
        const scale = CM93_SCALE_ORDER[scaleIndex];
        const step = CM93_SCALE_STEPS[scale];
        const candidateLatitudeCell = Math.floor((centerLatitude * 3 + 240) / step) * step;
        const candidateLongitudeCell = Math.floor((centerLongitude * 3) / step) * step;
        const candidate = byPath.get(pathForCell(candidateLatitudeCell, candidateLongitudeCell, scale));
        if (!candidate) continue;
        const key = (candidate.webkitRelativePath || candidate.name).toLowerCase();
        if (!candidates.some((item) => (item.file.webkitRelativePath || item.file.name).toLowerCase() === key)) {
          candidates.push({ file: candidate, scale });
          union.set(key, { file: candidate, scale });
        }
      }

      const west = signedLongitude(longitudeCell / 3);
      const east = signedLongitude((longitudeCell + targetStep) / 3);
      groups.push({
        bounds: { west, east, south: (latitudeCell - 240) / 3, north: (latitudeCell + targetStep - 240) / 3 },
        candidates,
      });
      if (groups.length >= maxCells) break;
    }
    if (groups.length >= maxCells) break;
  }

  const scaleCounts: Partial<Record<Cm93ScaleCode, number>> = {};
  for (const item of union.values()) scaleCounts[item.scale] = (scaleCounts[item.scale] ?? 0) + 1;
  return { scale: targetScale, files: [...union.values()].map((item) => item.file), scaleCounts, candidateGroups: groups };
}

/** Clip feature geometries to one target footprint so a coarse fallback used
 * for an empty fine cell cannot draw over neighboring fine cells. */
export function clipCm93FeaturesToBounds(
  features: GeoJSON.Feature[],
  bounds: Cm93ViewportBounds,
): GeoJSON.Feature[] {
  const rectangles: Cm93ViewportBounds[] = bounds.west <= bounds.east
    ? [bounds]
    : [{ ...bounds, east: 180 }, { ...bounds, west: -180 }];
  const inside = (p: number[]) => rectangles.some((r) => p[0] >= r.west - 1e-9 && p[0] <= r.east + 1e-9 && p[1] >= r.south - 1e-9 && p[1] <= r.north + 1e-9);
  const clipLine = (a: number[], b: number[], r: Cm93ViewportBounds): number[][] => {
    let t0 = 0; let t1 = 1;
    const dx = b[0] - a[0]; const dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy];
    const q = [a[0] - r.west, r.east - a[0], a[1] - r.south, r.north - a[1]];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) return []; continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
      if (t0 > t1) return [];
    }
    return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
  };
  const clipLineString = (coords: number[][]): number[][][] => {
    const parts: number[][][] = [];
    let active: number[][] = [];
    for (let i = 1; i < coords.length; i++) {
      const pieces = rectangles.map((r) => clipLine(coords[i - 1], coords[i], r)).filter((piece) => piece.length);
      const piece = pieces[0];
      if (!piece) { if (active.length > 1) parts.push(active); active = []; continue; }
      if (active.length && Math.abs(active[active.length - 1][0] - piece[0][0]) < 1e-8 && Math.abs(active[active.length - 1][1] - piece[0][1]) < 1e-8) active.push(piece[1]);
      else { if (active.length > 1) parts.push(active); active = piece; }
    }
    if (active.length > 1) parts.push(active);
    return parts;
  };
  const clipRing = (input: number[][], r: Cm93ViewportBounds): number[][] => {
    let output = input.slice(0, -1);
    const edges: Array<(p: number[]) => boolean> = [
      (p) => p[0] >= r.west, (p) => p[0] <= r.east,
      (p) => p[1] >= r.south, (p) => p[1] <= r.north,
    ];
    const intersection = (a: number[], b: number[], edge: number): number[] => {
      if (edge < 2) { const x = edge === 0 ? r.west : r.east; const t = (x - a[0]) / (b[0] - a[0] || 1); return [x, a[1] + t * (b[1] - a[1])]; }
      const y = edge === 2 ? r.south : r.north; const t = (y - a[1]) / (b[1] - a[1] || 1); return [a[0] + t * (b[0] - a[0]), y];
    };
    for (let edge = 0; edge < 4; edge++) {
      const inputRing = output; output = [];
      if (!inputRing.length) break;
      let previous = inputRing[inputRing.length - 1];
      for (const current of inputRing) {
        const currentIn = edges[edge](current); const previousIn = edges[edge](previous);
        if (currentIn) { if (!previousIn) output.push(intersection(previous, current, edge)); output.push(current); }
        else if (previousIn) output.push(intersection(previous, current, edge));
        previous = current;
      }
    }
    if (output.length < 3) return [];
    return [...output, output[0]];
  };
  const clipGeometry = (geometry: GeoJSON.Geometry): GeoJSON.Geometry | null => {
    switch (geometry.type) {
      case 'Point': return inside(geometry.coordinates) ? geometry : null;
      case 'MultiPoint': { const points = geometry.coordinates.filter(inside); return points.length ? { type: 'MultiPoint', coordinates: points } : null; }
      case 'LineString': {
        const parts = clipLineString(geometry.coordinates);
        if (!parts.length) return null;
        return parts.length === 1 ? { type: 'LineString', coordinates: parts[0] } : { type: 'MultiLineString', coordinates: parts };
      }
      case 'MultiLineString': {
        const lines = geometry.coordinates.flatMap(clipLineString);
        return lines.length ? { type: 'MultiLineString', coordinates: lines } : null;
      }
      case 'Polygon': {
        const rings = geometry.coordinates.map((ring) => rectangles.map((r) => clipRing(ring, r)).filter((ringPart) => ringPart.length)).flat();
        return rings.length ? { type: 'Polygon', coordinates: rings } : null;
      }
      case 'MultiPolygon': {
        const polygons = geometry.coordinates.map((polygon) => polygon.map((ring) => rectangles.map((r) => clipRing(ring, r)).filter((part) => part.length)).flat()).filter((polygon) => polygon.length);
        return polygons.length ? { type: 'MultiPolygon', coordinates: polygons } : null;
      }
      case 'GeometryCollection': {
        const geometries = geometry.geometries.map(clipGeometry).filter((g): g is GeoJSON.Geometry => g !== null);
        return geometries.length ? { type: 'GeometryCollection', geometries } : null;
      }
    }
  };
  const output: GeoJSON.Feature[] = [];
  for (const feature of features) {
    const geometry = clipGeometry(feature.geometry);
    if (geometry) output.push({ ...feature, geometry });
  }
  return output;
}

export function mergeCm93QuiltFeatures(currentFeatures: GeoJSON.Feature[]): GeoJSON.Feature[] {
  return currentFeatures;
}
