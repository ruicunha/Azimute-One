import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCm93CoverageQuiltFeatures, cm93PointInCoverage } from './cm93-quilt-geometry.ts';

const ring = (west, south, east, north) => [[west, south], [east, south], [east, north], [west, north], [west, south]];
const feature = (cm93Class, cm93Scale, geometry, extra = {}) => ({
  type: 'Feature',
  properties: { cm93Class, cm93Scale, ...extra },
  geometry,
});

test('coverage containment respects polygon holes and boundaries', () => {
  const coverage = [[
    ring(0, 0, 10, 10),
    ring(2, 2, 8, 8),
  ]];
  assert.equal(cm93PointInCoverage([1, 1], coverage), true);
  assert.equal(cm93PointInCoverage([5, 5], coverage), false);
  assert.equal(cm93PointInCoverage([2, 5], coverage), false, 'hole boundary belongs to the hole');
});

test('does not render a scale whose cells have no decoded M_COVR coverage', () => {
  const result = buildCm93CoverageQuiltFeatures([
    feature('DEPARE', 'E', { type: 'Polygon', coordinates: [ring(0, 0, 10, 10)] }),
  ], 'E');
  assert.deepEqual(result.features, []);
  assert.deepEqual(result.coverageByScale, {});
});

test('allocates M_COVR regions from detailed to coarse and clips all geometry types', () => {
  const features = [
    feature('_m_sor', 'D', { type: 'Polygon', coordinates: [ring(0, 0, 10, 10)] }),
    feature('_m_sor', 'E', { type: 'Polygon', coordinates: [ring(2, 2, 8, 8)] }),
    feature('DEPARE', 'D', { type: 'Polygon', coordinates: [ring(0, 0, 10, 10)] }, { DRVAL1: 30, DRVAL2: 50 }),
    feature('DEPARE', 'E', { type: 'Polygon', coordinates: [ring(1, 1, 9, 9)] }, { DRVAL1: 5, DRVAL2: 10 }),
    feature('DEPCNT', 'D', { type: 'LineString', coordinates: [[0, 5], [10, 5]] }, { VALDCO: 30 }),
    feature('DEPCNT', 'E', { type: 'LineString', coordinates: [[0, 4], [10, 4]] }, { VALDCO: 10 }),
    feature('BOYLAT', 'D', { type: 'Point', coordinates: [5, 5] }),
    feature('BOYLAT', 'D', { type: 'Point', coordinates: [1, 1] }),
    feature('BOYLAT', 'E', { type: 'Point', coordinates: [5, 5] }),
    feature('BOYLAT', 'E', { type: 'Point', coordinates: [1, 1] }),
    feature('M_PROD', 'E', { type: 'Polygon', coordinates: [ring(0, 0, 10, 10)] }),
  ];

  const result = buildCm93CoverageQuiltFeatures(features, 'E');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.features.some((item) => String(item.properties?.cm93Class).toUpperCase() === '_M_SOR'), false);
  assert.equal(result.features.some((item) => item.properties?.cm93Class === 'M_PROD'), false);

  const coarseArea = result.features.find((item) => item.properties?.cm93Class === 'DEPARE' && item.properties?.cm93Scale === 'D');
  assert.ok(coarseArea);
  assert.ok(coarseArea.geometry && ['Polygon', 'MultiPolygon'].includes(coarseArea.geometry.type));
  const coarseAreaCoordinates = coarseArea.geometry.type === 'Polygon'
    ? [coarseArea.geometry.coordinates]
    : coarseArea.geometry.type === 'MultiPolygon'
      ? coarseArea.geometry.coordinates
      : [];
  assert.equal(cm93PointInCoverage([1, 1], coarseAreaCoordinates), true);
  assert.equal(cm93PointInCoverage([5, 5], coarseAreaCoordinates), false, 'coarse fill must not cover the detailed E region');

  const fineArea = result.features.find((item) => item.properties?.cm93Class === 'DEPARE' && item.properties?.cm93Scale === 'E');
  assert.ok(fineArea?.geometry);
  const fineAreaCoordinates = fineArea.geometry.type === 'Polygon'
    ? [fineArea.geometry.coordinates]
    : fineArea.geometry.type === 'MultiPolygon'
      ? fineArea.geometry.coordinates
      : [];
  assert.equal(cm93PointInCoverage([5, 5], fineAreaCoordinates), true);
  assert.equal(cm93PointInCoverage([1, 1], fineAreaCoordinates), false, 'detailed fill must not leak outside its own coverage');

  const coarseLine = result.features.find((item) => item.properties?.cm93Class === 'DEPCNT' && item.properties?.cm93Scale === 'D');
  assert.equal(coarseLine?.geometry.type, 'MultiLineString', 'coarse contours should split around the detailed coverage hole');
  const coarseLines = coarseLine.geometry.type === 'MultiLineString' ? coarseLine.geometry.coordinates : [];
  assert.equal(coarseLines.length, 2);
  assert.ok(coarseLines.every((line) => line.every((point) => point[0] <= 2 || point[0] >= 8)));

  const fineLine = result.features.find((item) => item.properties?.cm93Class === 'DEPCNT' && item.properties?.cm93Scale === 'E');
  assert.ok(fineLine?.geometry.type === 'LineString' || fineLine?.geometry.type === 'MultiLineString');
  const fineLines = fineLine.geometry.type === 'LineString'
    ? [fineLine.geometry.coordinates]
    : fineLine.geometry.type === 'MultiLineString'
      ? fineLine.geometry.coordinates
      : [];
  assert.ok(fineLines.flat().every((point) => point[0] >= 2 && point[0] <= 8));

  const points = result.features.filter((item) => item.properties?.cm93Class === 'BOYLAT');
  assert.equal(points.some((item) => item.properties?.cm93Scale === 'D' && item.geometry.type === 'Point' && item.geometry.coordinates[0] === 5), false);
  assert.equal(points.some((item) => item.properties?.cm93Scale === 'D' && item.geometry.type === 'Point' && item.geometry.coordinates[0] === 1), true);
  assert.equal(points.some((item) => item.properties?.cm93Scale === 'E' && item.geometry.type === 'Point' && item.geometry.coordinates[0] === 5), true);
  assert.equal(points.some((item) => item.properties?.cm93Scale === 'E' && item.geometry.type === 'Point' && item.geometry.coordinates[0] === 1), false);
});


test('polygon clipping only intersects coverage components whose bounds overlap the feature', () => {
  const features = [
    feature('_m_sor', 'G', { type: 'Polygon', coordinates: [ring(0, 0, 10, 10)] }),
    feature('_m_sor', 'G', { type: 'Polygon', coordinates: [ring(20, 0, 30, 10)] }),
    feature('_m_sor', 'G', { type: 'Polygon', coordinates: [ring(40, 0, 50, 10)] }),
    feature('DEPARE', 'G', { type: 'Polygon', coordinates: [ring(-1, -1, 51, 11)] }, { id: 'all-components' }),
    feature('DEPARE', 'G', { type: 'Polygon', coordinates: [ring(1, 1, 9, 9)] }, { id: 'first-component' }),
  ];

  const result = buildCm93CoverageQuiltFeatures(features, 'G');
  const allComponents = result.features.find((item) => item.properties?.id === 'all-components');
  const firstComponent = result.features.find((item) => item.properties?.id === 'first-component');

  assert.ok(allComponents?.geometry?.type === 'MultiPolygon');
  assert.equal(allComponents.geometry.coordinates.length, 3, 'all disconnected coverage components remain represented');
  assert.ok(firstComponent?.geometry?.type === 'Polygon');
  assert.equal(result.metrics.polygonCoverageComponentCount, 3);
  assert.equal(result.metrics.polygonCoverageCandidateCount, 4, 'one feature checks three components; the local feature checks only one');
  assert.equal(cm93PointInCoverage([5, 5], [firstComponent.geometry.coordinates]), true);
  assert.equal(cm93PointInCoverage([25, 5], [firstComponent.geometry.coordinates]), false);
});
