import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCm93QuiltFeatures, cm93ScaleForZoom, selectCm93ViewportCells } from './cm93-quilt.ts';

function cell(filename, path) {
  return { name: filename, webkitRelativePath: path, arrayBuffer: async () => new ArrayBuffer(0) };
}

test('uses OpenCPN-style display-scale breaks to choose CM93 detail', () => {
  assert.equal(cm93ScaleForZoom(2, 38.5), 'Z');
  assert.equal(cm93ScaleForZoom(4, 38.5), 'Z');
  assert.equal(cm93ScaleForZoom(6, 38.5), 'A');
  assert.equal(cm93ScaleForZoom(8, 38.5), 'B');
  assert.equal(cm93ScaleForZoom(8.723, 38.46), 'B');
  assert.equal(cm93ScaleForZoom(9.783, 38.508), 'C');
  assert.equal(cm93ScaleForZoom(10.3, 38.5), 'D');
  assert.equal(cm93ScaleForZoom(12.5, 38.5), 'E');
  assert.equal(cm93ScaleForZoom(14, 38.5), 'F');
  assert.equal(cm93ScaleForZoom(16, 38.5), 'G');
});

test('selects only cells matching the chosen scale and viewport grid when available', () => {
  const target = cell('03841050.D', 'cm93/03301020/D/03841050.D');
  const otherScale = cell('03841050.E', 'cm93/03301020/E/03841050.E');
  const result = selectCm93ViewportCells([target, otherScale], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 10.3);

  assert.equal(result.scale, 'D');
  assert.ok(result.files.every((file) => file.name.endsWith('.D')));
  assert.deepEqual(result.scaleCounts, { D: result.files.length });
});

test('falls back to the nearest coarser scale when no target-scale cells exist in the viewport', () => {
  const coarse = cell('03781044.C', 'cm93/03301020/C/03781044.C');
  const result = selectCm93ViewportCells([coarse], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 10.3);

  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, [coarse]);
  assert.deepEqual(result.scaleCounts, { C: 1 });
});

test('selects coarser candidate cells so M_COVR can fill uncovered regions', () => {
  const fine = cell('03841050.D', 'cm93/03301020/D/03841050.D');
  const coarse = cell('03781044.C', 'cm93/03301020/C/03781044.C');
  const result = selectCm93ViewportCells([fine, coarse], {
    west: -9.4, south: 38.4, east: -8.8, north: 38.9,
  }, 10.3);

  assert.deepEqual(result.files, [fine, coarse], 'include the requested scale and coarser candidate');
  assert.deepEqual(result.fillFallbackFiles, [], 'coarser candidates are not unconditionally overlaid');
  assert.deepEqual(result.scaleCounts, { D: 1, C: 1 });
});

test('does not substitute finer F cells for missing E-scale coverage', () => {
  const fineFallback = cell('03851051.F', 'cm93/03301020/F/03851051.F');
  const adjacentE = cell('03851052.E', 'cm93/03301020/E/03851052.E');
  const result = selectCm93ViewportCells([fineFallback, adjacentE], {
    west: -9.4, south: 38.5, east: -9.2, north: 38.7,
  }, 12.5);

  assert.ok(!result.files.some((file) => file.name === '03851051.F'));
  assert.ok(result.files.some((file) => file.name === '03851052.E'));
  assert.deepEqual(result.scaleCounts, { E: 1 });
});

test('prefers the requested E tile over a finer F tile in the same footprint', () => {
  const requested = cell('03851051.E', 'cm93/03301020/E/03851051.E');
  const finer = cell('03851051.F', 'cm93/03301020/F/03851051.F');
  const result = selectCm93ViewportCells([requested, finer], {
    west: -9.4, south: 38.5, east: -9.3, north: 38.6,
  }, 12.5);

  assert.ok(result.files.some((file) => file.name === '03851051.E'));
  assert.ok(!result.files.some((file) => file.name === '03851051.F'));
});

test('returns an empty selection when no scale has a cell in the viewport', () => {
  const result = selectCm93ViewportCells([], {
    west: -10, south: 37, east: -8, north: 39,
  }, 10.3);
  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, []);
});

test('limits the number of selected cells for large viewports', () => {
  const result = selectCm93ViewportCells([], {
    west: -180, south: -70, east: 180, north: 70,
  }, 16, 12);
  assert.equal(result.files.length, 0);
});

test('does not truncate a detailed viewport at the old 180-cell limit', () => {
  const files = [];
  for (let latitudeCell = 240; latitudeCell <= 258; latitudeCell++) {
    for (let longitudeCell = 0; longitudeCell <= 18; longitudeCell++) {
      const cellLatitude = latitudeCell + 30;
      const rootLatitude = Math.floor((cellLatitude - 30) / 60) * 60 + 30;
      const rootLongitude = Math.floor(longitudeCell / 60) * 60;
      const root = String(rootLatitude).padStart(4, '0') + String(rootLongitude).padStart(4, '0');
      const filename = String(cellLatitude).padStart(4, '0') + String(longitudeCell).padStart(4, '0') + '.g';
      files.push(cell(filename, `cm93/${root}/g/${filename}`));
    }
  }
  const result = selectCm93ViewportCells(files, {
    west: 0, south: 0, east: 6, north: 6,
  }, 16, 1200);

  assert.equal(result.files.length, 361);
  assert.equal(result.scaleCounts.G, 361);
});

test('builds the quilt only from the current viewport selection', () => {
  const current = {
    type: 'Feature',
    properties: { cm93Class: 'BOYLAT', cm93SourceCell: 'fine-cell.g' },
    geometry: { type: 'Point', coordinates: [-9, 38] },
  };
  assert.deepEqual(buildCm93QuiltFeatures([current]), [current]);
});

test('an empty current selection cannot inherit stale features from a prior zoom', () => {
  assert.deepEqual(buildCm93QuiltFeatures([]), []);
});


test('does not select finer E/F/G cells as fill-only supplements at D scale', () => {
  const coarse = cell('03841050.D', 'cm93/03301020/D/03841050.D');
  const e = cell('03851052.E', 'cm93/03301020/E/03851052.E');
  const g = cell('03851052.G', 'cm93/03301020/G/03851052.G');
  const result = selectCm93ViewportCells([coarse, e, g], {
    west: -9.4, south: 38.5, east: -9.2, north: 38.7,
  }, 10.3);

  assert.ok(result.files.includes(coarse));
  assert.ok(!result.files.includes(e));
  assert.ok(!result.files.includes(g));
  assert.deepEqual(result.fillFallbackFiles, []);
  assert.deepEqual(result.scaleCounts, { D: 1 });
});

test('includes coarser D candidates in an E-scale quilt for coverage-aware fallback', () => {
  const coarse = cell('03841050.D', 'cm93/03301020/D/03841050.D');
  const detailed = cell('03851052.E', 'cm93/03301020/E/03851052.E');
  const result = selectCm93ViewportCells([coarse, detailed], {
    west: -9.4, south: 38.5, east: -9.2, north: 38.7,
  }, 12.5);

  assert.ok(result.files.includes(detailed), 'keep the requested-scale cell');
  assert.ok(result.files.includes(coarse), 'load the coarser cell for uncovered regions');
  assert.ok(!result.fillFallbackFiles.includes(coarse), 'coarser features are clipped by M_COVR, not fill-only tagged');
  assert.deepEqual(result.scaleCounts, { E: 1, D: 1 });
});

test('does not add finer G fill fallbacks when the requested E cell exists', () => {
  const e = cell('03851052.E', 'cm93/03301020/E/03851052.E');
  const g = cell('03851052.G', 'cm93/03301020/G/03851052.G');
  const result = selectCm93ViewportCells([e, g], {
    west: -9.4, south: 38.5, east: -9.2, north: 38.7,
  }, 12.5);

  assert.ok(result.files.includes(e), 'keep the requested-scale cell');
  assert.ok(!result.files.includes(g), 'finer cells are not used as fallback for E scale');
  assert.deepEqual(result.fillFallbackFiles, []);
});
