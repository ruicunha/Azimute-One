import polygonClipping from 'polygon-clipping';
import { CM93_SCALE_ORDER, type Cm93ScaleCode } from './cm93-quilt.ts';

type Position2D = [number, number];
type Ring = Position2D[];
type PolygonCoordinates = Ring[];
export type Cm93MultiPolygonCoordinates = PolygonCoordinates[];
type MultiPolygonCoordinates = Cm93MultiPolygonCoordinates;

type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type CoverageEdge = {
  start: Position2D;
  end: Position2D;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
type PreparedCoverage = {
  geometry: MultiPolygonCoordinates;
  bounds: Bounds;
  edges: CoverageEdge[];
  components: Array<{ geometry: PolygonCoordinates; bounds: Bounds }>;
};

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY;
}

function geometryBounds(geometry: GeoJSON.Geometry): Bounds | null {
  if (geometry.type === 'GeometryCollection') {
    const childBounds = geometry.geometries.map(geometryBounds).filter((item): item is Bounds => item !== null);
    if (!childBounds.length) return null;
    return childBounds.reduce((result, item) => ({
      minX: Math.min(result.minX, item.minX),
      minY: Math.min(result.minY, item.minY),
      maxX: Math.max(result.maxX, item.maxX),
      maxY: Math.max(result.maxY, item.maxY),
    }));
  }
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let found = false;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      const x = value[0];
      const y = value[1];
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
      found = true;
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return found ? bounds : null;
}

function prepareCoverage(geometry: MultiPolygonCoordinates): PreparedCoverage | null {
  let bounds: Bounds | null = null;
  const edges: CoverageEdge[] = [];
  const components: PreparedCoverage['components'] = [];
  for (const polygon of geometry) {
    let componentBounds: Bounds | null = null;
    for (const ring of polygon) {
      for (const point of ring) {
        if (!bounds) bounds = { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] };
        else {
          bounds.minX = Math.min(bounds.minX, point[0]);
          bounds.minY = Math.min(bounds.minY, point[1]);
          bounds.maxX = Math.max(bounds.maxX, point[0]);
          bounds.maxY = Math.max(bounds.maxY, point[1]);
        }
        if (!componentBounds) componentBounds = { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] };
        else {
          componentBounds.minX = Math.min(componentBounds.minX, point[0]);
          componentBounds.minY = Math.min(componentBounds.minY, point[1]);
          componentBounds.maxX = Math.max(componentBounds.maxX, point[0]);
          componentBounds.maxY = Math.max(componentBounds.maxY, point[1]);
        }
      }
      for (let i = 1; i < ring.length; i++) {
        const start = ring[i - 1];
        const end = ring[i];
        edges.push({
          start, end,
          minX: Math.min(start[0], end[0]),
          minY: Math.min(start[1], end[1]),
          maxX: Math.max(start[0], end[0]),
          maxY: Math.max(start[1], end[1]),
        });
      }
    }
    if (componentBounds) components.push({ geometry: polygon, bounds: componentBounds });
  }
  return bounds ? { geometry, bounds, edges, components } : null;
}

const clipping = polygonClipping as unknown as {
  union: (...geometries: MultiPolygonCoordinates[]) => MultiPolygonCoordinates;
  difference: (subject: MultiPolygonCoordinates, ...clips: MultiPolygonCoordinates[]) => MultiPolygonCoordinates;
  intersection: (subject: MultiPolygonCoordinates, ...clips: MultiPolygonCoordinates[]) => MultiPolygonCoordinates;
};

function pointOnSegment(point: Position2D, start: Position2D, end: Position2D): boolean {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-20) {
    return (point[0] - start[0]) ** 2 + (point[1] - start[1]) ** 2 < 1e-20;
  }
  const cross = (point[0] - start[0]) * dy - (point[1] - start[1]) * dx;
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (point[0] - start[0]) * dx + (point[1] - start[1]) * dy;
  if (dot < -1e-10) return false;
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

function clipLineToCoverage(line: Position2D[], prepared: PreparedCoverage): Position2D[][] {
  const coverage = prepared.geometry;
  if (line.length < 2 || coverage.length === 0) return [];
  const edges = prepared.edges;

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
    const segmentBounds: Bounds = {
      minX: Math.min(start[0], end[0]),
      minY: Math.min(start[1], end[1]),
      maxX: Math.max(start[0], end[0]),
      maxY: Math.max(start[1], end[1]),
    };
    for (const edge of edges) {
      if (!boundsOverlap(segmentBounds, edge)) continue;
      const t = segmentIntersectionParameter(start, end, edge.start, edge.end);
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

function clipFeatureToCoverage(feature: GeoJSON.Feature, prepared: PreparedCoverage, precomputedBounds?: Bounds | null): GeoJSON.Feature[] {
  const coverage = prepared.geometry;
  const geometry = feature.geometry;
  if (!geometry) return [];
  const bounds = precomputedBounds === undefined ? geometryBounds(geometry) : precomputedBounds;
  if (!bounds || !boundsOverlap(bounds, prepared.bounds)) return [];
  if (geometry.type === 'Point') {
    return cm93PointInCoverage(pointFromPosition(geometry.coordinates), coverage) ? [feature] : [];
  }
  if (geometry.type === 'MultiPoint') {
    const coordinates = geometry.coordinates.filter((position) => cm93PointInCoverage(pointFromPosition(position), coverage));
    return coordinates.length ? [{ ...feature, geometry: { type: 'MultiPoint', coordinates } }] : [];
  }
  if (geometry.type === 'LineString') {
    const paths = clipLineToCoverage(geometry.coordinates.map(pointFromPosition), prepared);
    if (!paths.length) return [];
    return [{ ...feature, geometry: paths.length === 1
      ? { type: 'LineString', coordinates: paths[0] }
      : { type: 'MultiLineString', coordinates: paths } }];
  }
  if (geometry.type === 'MultiLineString') {
    const paths = geometry.coordinates.flatMap((line) => clipLineToCoverage(line.map(pointFromPosition), prepared));
    if (!paths.length) return [];
    return [{ ...feature, geometry: paths.length === 1
      ? { type: 'LineString', coordinates: paths[0] }
      : { type: 'MultiLineString', coordinates: paths } }];
  }
  const multiPolygon = toMultiPolygon(geometry);
  if (!multiPolygon) return [];
  // The effective coverage can contain many disconnected polygon components.
  // Intersecting against the full MultiPolygon makes polygon-clipping compare
  // each feature with all of them. Keep only components whose bounds overlap
  // this feature, then run the same Boolean intersection on that reduced set.
  // Preserve each candidate polygon's holes and use inclusive bbox overlap so
  // boundary-touching components are not accidentally discarded.
  const candidateCoverage = prepared.components
    .filter((component) => boundsOverlap(bounds, component.bounds))
    .map((component) => component.geometry);
  if (!candidateCoverage.length) return [];
  try {
    const clipped = clipping.intersection(multiPolygon, candidateCoverage);
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

function geometryTypeIsPolygon(type: GeoJSON.Geometry['type']): boolean {
  return type === 'Polygon' || type === 'MultiPolygon';
}

function isCoverageFeature(feature: GeoJSON.Feature): boolean {
  const name = String(feature.properties?.cm93Class ?? '').toUpperCase();
  return name === '_M_SOR' || name === 'M_COVR';
}

function isMetadataFeature(feature: GeoJSON.Feature): boolean {
  return String(feature.properties?.cm93Class ?? '').toUpperCase() === 'M_PROD';
}

export type Cm93CoverageQuiltMetrics = {
  collectCoverageMs: number;
  coverageAllocationMs: number;
  prepareCoverageMs: number;
  featureBoundsMs: number;
  pointClipMs: number;
  lineClipMs: number;
  polygonClipMs: number;
  featureLoopMs: number;
  inputFeatureCount: number;
  coverageFeatureCount: number;
  metadataFeatureCount: number;
  missingGeometryCount: number;
  invalidScaleCount: number;
  noCoverageCount: number;
  boundsRejectedCount: number;
  pointFeatureCount: number;
  lineFeatureCount: number;
  polygonFeatureCount: number;
  outputFeatureCount: number;
  coverageEdgeCount: number;
  polygonCoverageComponentCount: number;
  polygonCoverageCandidateCount: number;
};

export type Cm93CoverageQuiltResult = {
  features: GeoJSON.Feature[];
  coverageByScale: Partial<Record<Cm93ScaleCode, MultiPolygonCoordinates>>;
  warnings: string[];
  metrics: Cm93CoverageQuiltMetrics;
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
  const metrics: Cm93CoverageQuiltMetrics = {
    collectCoverageMs: 0, coverageAllocationMs: 0, prepareCoverageMs: 0,
    featureBoundsMs: 0, pointClipMs: 0, lineClipMs: 0, polygonClipMs: 0, featureLoopMs: 0,
    inputFeatureCount: currentFeatures.length, coverageFeatureCount: 0, metadataFeatureCount: 0,
    missingGeometryCount: 0, invalidScaleCount: 0, noCoverageCount: 0, boundsRejectedCount: 0,
    pointFeatureCount: 0, lineFeatureCount: 0, polygonFeatureCount: 0, outputFeatureCount: 0, coverageEdgeCount: 0,
    polygonCoverageComponentCount: 0, polygonCoverageCandidateCount: 0,
  };
  const targetIndex = CM93_SCALE_ORDER.indexOf(targetScale);
  const rawRegions = new Map<Cm93ScaleCode, MultiPolygonCoordinates[]>();
  for (const scale of CM93_SCALE_ORDER.slice(0, targetIndex + 1)) rawRegions.set(scale, []);
  const collectStartedAt = performance.now();

  for (const feature of currentFeatures) {
    if (!isCoverageFeature(feature)) continue;
    metrics.coverageFeatureCount++;
    const scale = String(feature.properties?.cm93Scale ?? '').toUpperCase() as Cm93ScaleCode;
    if (!rawRegions.has(scale) || !feature.geometry) continue;
    const polygon = toMultiPolygon(feature.geometry);
    if (polygon?.length) rawRegions.get(scale)?.push(polygon);
  }

  metrics.collectCoverageMs = performance.now() - collectStartedAt;
  const allocationStartedAt = performance.now();
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

  metrics.coverageAllocationMs = performance.now() - allocationStartedAt;
  const prepareStartedAt = performance.now();
  const preparedCoverageByScale: Partial<Record<Cm93ScaleCode, PreparedCoverage>> = {};
  for (const [scale, coverage] of Object.entries(coverageByScale) as Array<[Cm93ScaleCode, MultiPolygonCoordinates]>) {
    const prepared = prepareCoverage(coverage);
    if (prepared) {
      preparedCoverageByScale[scale] = prepared;
      metrics.coverageEdgeCount += prepared.edges.length;
      metrics.polygonCoverageComponentCount += prepared.components.length;
    }
  }
  metrics.prepareCoverageMs = performance.now() - prepareStartedAt;

  const features: GeoJSON.Feature[] = [];
  const featureLoopStartedAt = performance.now();
  for (const feature of currentFeatures) {
    if (isCoverageFeature(feature)) continue;
    if (isMetadataFeature(feature)) { metrics.metadataFeatureCount++; continue; }
    if (!feature.geometry) { metrics.missingGeometryCount++; continue; }
    const scale = String(feature.properties?.cm93Scale ?? '').toUpperCase() as Cm93ScaleCode;
    const scaleIndex = CM93_SCALE_ORDER.indexOf(scale);
    if (scaleIndex < 0 || scaleIndex > targetIndex) { metrics.invalidScaleCount++; continue; }
    const prepared = preparedCoverageByScale[scale];
    if (!prepared) { metrics.noCoverageCount++; continue; }

    const boundsStartedAt = performance.now();
    const bounds = geometryBounds(feature.geometry);
    metrics.featureBoundsMs += performance.now() - boundsStartedAt;
    if (!bounds || !boundsOverlap(bounds, prepared.bounds)) {
      metrics.boundsRejectedCount++;
      continue;
    }

    const geometryType = feature.geometry.type;
    const clipStartedAt = performance.now();
    if (geometryTypeIsPolygon(feature.geometry.type)) {
      metrics.polygonCoverageCandidateCount += prepared.components.reduce(
        (count, component) => count + (boundsOverlap(bounds, component.bounds) ? 1 : 0), 0,
      );
    }
    const clipped = clipFeatureToCoverage(feature, prepared, bounds);
    const clipMs = performance.now() - clipStartedAt;
    if (geometryType === 'Point' || geometryType === 'MultiPoint') {
      metrics.pointFeatureCount++;
      metrics.pointClipMs += clipMs;
    } else if (geometryType === 'LineString' || geometryType === 'MultiLineString') {
      metrics.lineFeatureCount++;
      metrics.lineClipMs += clipMs;
    } else if (geometryType === 'Polygon' || geometryType === 'MultiPolygon') {
      metrics.polygonFeatureCount++;
      metrics.polygonClipMs += clipMs;
    }
    metrics.outputFeatureCount += clipped.length;
    features.push(...clipped);
  }
  metrics.featureLoopMs = performance.now() - featureLoopStartedAt;

  return { features, coverageByScale, warnings, metrics };
}
