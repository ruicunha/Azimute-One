import polygonClipping from 'polygon-clipping';
import { CM93_SCALE_ORDER, type Cm93ScaleCode } from './cm93-quilt';

type Position2D = [number, number];
type Ring = Position2D[];
type PolygonCoordinates = Ring[];
type MultiPolygonCoordinates = PolygonCoordinates[];

const clipping = polygonClipping as unknown as {
  union: (...geometries: MultiPolygonCoordinates[]) => MultiPolygonCoordinates;
  difference: (subject: MultiPolygonCoordinates, ...clips: MultiPolygonCoordinates[]) => MultiPolygonCoordinates;
  intersection: (subject: MultiPolygonCoordinates, ...clips: MultiPolygonCoordinates[]) => MultiPolygonCoordinates;
};

function pointOnSegment(point: Position2D, start: Position2D, end: Position2D): boolean {
  const cross = (point[0] - start[0]) * (end[1] - start[1]) - (point[1] - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (point[0] - start[0]) * (end[0] - start[0]) + (point[1] - start[1]) * (end[1] - start[1]);
  if (dot < -1e-10) return false;
  const lengthSquared = (end[0] - start[0]) ** 2 + (end[1] - start[1]) ** 2;
  return dot <= lengthSquared + 1e-10;
}

function pointInRing(point: Position2D, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (pointOnSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < ((b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0])) {
      inside = !inside;
    }
  }
  return inside;
}

export function cm93PointInCoverage(point: Position2D, coverage: MultiPolygonCoordinates): boolean {
  return coverage.some((polygon) => {
    if (!polygon.length || !pointInRing(point, polygon[0])) return false;
    return !polygon.slice(1).some((hole) => pointInRing(point, hole));
  });
}

function toMultiPolygon(geometry: GeoJSON.Geometry): MultiPolygonCoordinates | null {
  if (geometry.type === 'Polygon') {
    return [geometry.coordinates.map((ring) => ring.map((p) => [p[0], p[1]] as Position2D))];
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((polygon) => polygon.map((ring) => ring.map((p) => [p[0], p[1]] as Position2D)));
  }
  return null;
}

function unionRegions(regions: MultiPolygonCoordinates[]): MultiPolygonCoordinates {
  const nonEmpty = regions.filter((region) => region.length > 0);
  if (!nonEmpty.length) return [];
  if (nonEmpty.length === 1) return nonEmpty[0];
  return clipping.union(...nonEmpty);
}

function pointFromPosition(position: GeoJSON.Position): Position2D {
  return [position[0], position[1]];
}

function segmentIntersectionParameter(start: Position2D, end: Position2D, edgeStart: Position2D, edgeEnd: Position2D): number | null {
  const rx = end[0] - start[0];
  const ry = end[1] - start[1];
  const sx = edgeEnd[0] - edgeStart[0];
  const sy = edgeEnd[1] - edgeStart[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null;
  const qpx = edgeStart[0] - start[0];
  const qpy = edgeStart[1] - start[1];
  const t = (qpx * sy - qpy * sx) / denominator;
  const u = (qpx * ry - qpy * rx) / denominator;
  if (t < -1e-10 || t > 1 + 1e-10 || u < -1e-10 || u > 1 + 1e-10) return null;
  return Math.max(0, Math.min(1, t));
}

function interpolate(start: Position2D, end: Position2D, t: number): Position2D {
  return [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
}

function clipLineToCoverage(line: Position2D[], coverage: MultiPolygonCoordinates): Position2D[][] {
  if (line.length < 2 || coverage.length === 0) return [];
  if (line.every((point) => cm93PointInCoverage(point, coverage))) return [line];

  const edges: Array<[Position2D, Position2D]> = [];
  for (const polygon of coverage) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i++) edges.push([ring[i - 1], ring[i]]);
    }
  }

  const result: Position2D[][] = [];
  let current: Position2D[] = [];
  const flush = () => {
    if (current.length >= 2) result.push(current);
    current = [];
  };

  for (let segmentIndex = 1; segmentIndex < line.length; segmentIndex++) {
    const start = line[segmentIndex - 1];
    const end = line[segmentIndex];
    const parameters = [0, 1];
    for (const [edgeStart, edgeEnd] of edges) {
      const t = segmentIntersectionParameter(start, end, edgeStart, edgeEnd);
      if (t !== null) parameters.push(t);
    }
    parameters.sort((a, b) => a - b);
    const unique = parameters.filter((value, index) => index === 0 || Math.abs(value - parameters[index - 1]) > 1e-9);

    for (let i = 1; i < unique.length; i++) {
      const t0 = unique[i - 1];
      const t1 = unique[i];
      if (t1 - t0 < 1e-10) continue;
      const a = interpolate(start, end, t0);
      const b = interpolate(start, end, t1);
      const midpoint = interpolate(start, end, (t0 + t1) / 2);
      if (cm93PointInCoverage(midpoint, coverage)) {
        if (!current.length) current = [a, b];
        else {
          const last = current[current.length - 1];
          if (Math.abs(last[0] - a[0]) < 1e-9 && Math.abs(last[1] - a[1]) < 1e-9) current.push(b);
          else {
            flush();
            current = [a, b];
          }
        }
      } else {
        flush();
      }
    }
  }
  flush();
  return result;
}

function clipFeatureToCoverage(feature: GeoJSON.Feature, coverage: MultiPolygonCoordinates): GeoJSON.Feature[] {
  const geometry = feature.geometry;
  if (!geometry) return [];
  if (geometry.type === 'Point') {
    return cm93PointInCoverage(pointFromPosition(geometry.coordinates), coverage) ? [feature] : [];
  }
  if (geometry.type === 'MultiPoint') {
    const coordinates = geometry.coordinates.filter((position) => cm93PointInCoverage(pointFromPosition(position), coverage));
    return coordinates.length ? [{ ...feature, geometry: { type: 'MultiPoint', coordinates } }] : [];
  }
  if (geometry.type === 'LineString') {
    const paths = clipLineToCoverage(geometry.coordinates.map(pointFromPosition), coverage);
    if (!paths.length) return [];
    return [{ ...feature, geometry: paths.length === 1
      ? { type: 'LineString', coordinates: paths[0] }
      : { type: 'MultiLineString', coordinates: paths } }];
  }
  if (geometry.type === 'MultiLineString') {
    const paths = geometry.coordinates.flatMap((line) => clipLineToCoverage(line.map(pointFromPosition), coverage));
    if (!paths.length) return [];
    return [{ ...feature, geometry: paths.length === 1
      ? { type: 'LineString', coordinates: paths[0] }
      : { type: 'MultiLineString', coordinates: paths } }];
  }
  const multiPolygon = toMultiPolygon(geometry);
  if (!multiPolygon) return [];
  try {
    const clipped = clipping.intersection(multiPolygon, coverage);
    if (!clipped.length) return [];
    if (clipped.length === 1) {
      return [{ ...feature, geometry: { type: 'Polygon', coordinates: clipped[0] } }];
    }
    return [{ ...feature, geometry: { type: 'MultiPolygon', coordinates: clipped } }];
  } catch {
    // Invalid geometry must not leak outside its chart's M_COVR region.
    return [];
  }
}

function isCoverageFeature(feature: GeoJSON.Feature): boolean {
  const name = String(feature.properties?.cm93Class ?? '').toUpperCase();
  return name === '_M_SOR' || name === 'M_COVR';
}

function isMetadataFeature(feature: GeoJSON.Feature): boolean {
  return String(feature.properties?.cm93Class ?? '').toUpperCase() === 'M_PROD';
}

export type Cm93CoverageQuiltResult = {
  features: GeoJSON.Feature[];
  coverageByScale: Partial<Record<Cm93ScaleCode, MultiPolygonCoordinates>>;
  warnings: string[];
};

/**
 * Reproduces OpenCPN's essential CM93 quilt rule: the most detailed available
 * scale owns its M_COVR region; each coarser scale only renders in the remaining
 * uncovered region. All geometries are clipped, so lines, points and depth/land
 * polygons cannot leak beyond the coverage assigned to their source scale.
 */
export function buildCm93CoverageQuiltFeatures(
  currentFeatures: GeoJSON.Feature[],
  targetScale: Cm93ScaleCode,
): Cm93CoverageQuiltResult {
  const targetIndex = CM93_SCALE_ORDER.indexOf(targetScale);
  const rawRegions = new Map<Cm93ScaleCode, MultiPolygonCoordinates[]>();
  for (const scale of CM93_SCALE_ORDER.slice(0, targetIndex + 1)) rawRegions.set(scale, []);

  for (const feature of currentFeatures) {
    if (!isCoverageFeature(feature)) continue;
    const scale = String(feature.properties?.cm93Scale ?? '').toUpperCase() as Cm93ScaleCode;
    if (!rawRegions.has(scale) || !feature.geometry) continue;
    const polygon = toMultiPolygon(feature.geometry);
    if (polygon?.length) rawRegions.get(scale)?.push(polygon);
  }

  const coverageByScale: Partial<Record<Cm93ScaleCode, MultiPolygonCoordinates>> = {};
  const warnings: string[] = [];
  let allocatedCoverage: MultiPolygonCoordinates = [];

  // Calculate the effective coverage from most detailed to coarsest.
  for (let scaleIndex = targetIndex; scaleIndex >= 0; scaleIndex--) {
    const scale = CM93_SCALE_ORDER[scaleIndex];
    let rawCoverage: MultiPolygonCoordinates;
    try {
      rawCoverage = unionRegions(rawRegions.get(scale) ?? []);
    } catch {
      warnings.push('Could not combine M_COVR coverage for CM93 scale ' + scale + '; this scale was skipped.');
      rawCoverage = [];
    }
    if (!rawCoverage.length) continue;

    let effectiveCoverage = rawCoverage;
    if (allocatedCoverage.length) {
      try {
        effectiveCoverage = clipping.difference(rawCoverage, allocatedCoverage);
      } catch {
        warnings.push('Could not subtract finer coverage from CM93 scale ' + scale + '; this scale was skipped.');
        effectiveCoverage = [];
      }
    }
    coverageByScale[scale] = effectiveCoverage;
    try {
      allocatedCoverage = unionRegions([allocatedCoverage, rawCoverage]);
    } catch {
      // Retain the prior allocation. A failed union must never authorize a
      // coarser chart to overwrite an already-known finer coverage region.
      warnings.push('Could not extend the CM93 coverage allocation at scale ' + scale + '.');
    }
  }

  const features: GeoJSON.Feature[] = [];
  for (const feature of currentFeatures) {
    if (isCoverageFeature(feature) || isMetadataFeature(feature) || !feature.geometry) continue;
    const scale = String(feature.properties?.cm93Scale ?? '').toUpperCase() as Cm93ScaleCode;
    const scaleIndex = CM93_SCALE_ORDER.indexOf(scale);
    if (scaleIndex < 0 || scaleIndex > targetIndex) continue;
    const coverage = coverageByScale[scale];
    if (!coverage?.length) continue;
    features.push(...clipFeatureToCoverage(feature, coverage));
  }

  return { features, coverageByScale, warnings };
}
