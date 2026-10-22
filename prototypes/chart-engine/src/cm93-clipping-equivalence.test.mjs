import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCm93CoverageQuiltFeatures, cm93PointInCoverage } from './cm93-quilt-geometry.ts';

function subdividedRing(west, south, east, north, steps = 8) {
  const points = [];
  const sides = [
    [[west, south], [east, south]],
    [[east, south], [east, north]],
    [[east, north], [west, north]],
    [[west, north], [west, south]],
  ];
  for (const [[x1, y1], [x2, y2]] of sides) {
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      points.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t]);
    }
  }
  points.push(points[0]);
  return points;
}

const feature = (cm93Class, cm93Scale, geometry, extra = {}) => ({
  type: 'Feature',
  properties: { cm93Class, cm93Scale, ...extra },
  geometry,
});

function asMultiPolygon(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function containsGeometry(geometry, point) {
  return cm93PointInCoverage(point, asMultiPolygon(geometry));
}

function linePaths(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function totalLineLength(geometry) {
  return linePaths(geometry).reduce((sum, path) => {
    for (let i = 1; i < path.length; i++) {
      sum += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    }
    return sum;
  }, 0);
}

const fixture = [
  feature('_M_SOR', 'E', { type: 'Polygon', coordinates: [subdividedRing(0, 0, 10, 10)] }),
  feature('_M_SOR', 'F', { type: 'Polygon', coordinates: [subdividedRing(2, 2, 8, 8)] }),
  feature('DEPARE', 'E', { type: 'Polygon', coordinates: [subdividedRing(-1, -1, 11, 11)] }, { id: 'coarse-area' }),
  feature('DEPARE', 'F', { type: 'Polygon', coordinates: [subdividedRing(1, 1, 9, 9)] }, { id: 'fine-area' }),
  feature('DEPCNT', 'E', { type: 'LineString', coordinates: [[-1, 5], [11, 5]] }, { id: 'coarse-contour' }),
  feature('DEPCNT', 'F', { type: 'LineString', coordinates: [[-1, 3], [11, 3]] }, { id: 'fine-contour' }),
];

test('both CM93 clipping engines produce equivalent coverage and clipped geometry', () => {
  const current = buildCm93CoverageQuiltFeatures(fixture, 'F', 'polygon-clipping');
  const alternative = buildCm93CoverageQuiltFeatures(fixture, 'F', 'martinez-polygon-clipping');

  assert.deepEqual(current.warnings, []);
  assert.deepEqual(alternative.warnings, []);
  assert.deepEqual(Object.keys(current.coverageByScale).sort(), Object.keys(alternative.coverageByScale).sort());

  // Sample the full chart footprint away from exact boundaries to compare the
  // effective scale allocation, including the fine-scale hole in coarse coverage.
  for (let x = -0.73; x < 10.8; x += 0.37) {
    for (let y = -0.61; y < 10.7; y += 0.41) {
      for (const scale of Object.keys(current.coverageByScale)) {
        assert.equal(
          cm93PointInCoverage([x, y], current.coverageByScale[scale]),
          cm93PointInCoverage([x, y], alternative.coverageByScale[scale]),
          `coverage differs at scale ${scale}, point (${x}, ${y})`,
        );
      }
    }
  }

  for (const id of ['coarse-area', 'fine-area']) {
    const a = current.features.find((item) => item.properties?.id === id);
    const b = alternative.features.find((item) => item.properties?.id === id);
    assert.ok(a?.geometry && b?.geometry, `expected both engines to render ${id}`);
    for (let x = -0.83; x < 10.8; x += 0.31) {
      for (let y = -0.77; y < 10.7; y += 0.29) {
        assert.equal(
          containsGeometry(a.geometry, [x, y]),
          containsGeometry(b.geometry, [x, y]),
          `${id} differs at point (${x}, ${y})`,
        );
      }
    }
  }

  for (const id of ['coarse-contour', 'fine-contour']) {
    const a = current.features.find((item) => item.properties?.id === id);
    const b = alternative.features.find((item) => item.properties?.id === id);
    assert.ok(a?.geometry && b?.geometry, `expected both engines to render ${id}`);
    assert.equal(linePaths(a.geometry).length, linePaths(b.geometry).length, `${id} path count differs`);
    assert.ok(Math.abs(totalLineLength(a.geometry) - totalLineLength(b.geometry)) < 1e-7, `${id} clipped length differs`);
  }
});

test('coverage edge index drops redundant collinear vertices without changing chart geometry', () => {
  const result = buildCm93CoverageQuiltFeatures(fixture, 'F', 'martinez-polygon-clipping');
  assert.ok(result.metrics.coverageEdgeCount <= 24, `expected simplified edge index, got ${result.metrics.coverageEdgeCount} edges`);
  assert.ok(result.metrics.outputFeatureCount >= 4);
});
