import test from 'node:test';
import assert from 'node:assert/strict';
import { clipCm93FeaturesToBounds, cm93ScaleForZoom, mergeCm93QuiltFeatures, selectCm93ViewportCells } from './cm93-quilt.ts';

function cell(scale, filename, path) {
  return { name: filename, webkitRelativePath: path, arrayBuffer: async () => new ArrayBuffer(0) };
}

test('selects progressively finer provisional CM93 scales as zoom increases', () => {
  assert.equal(cm93ScaleForZoom(2), 'Z');
  assert.equal(cm93ScaleForZoom(4), 'A');
  assert.equal(cm93ScaleForZoom(5), 'B');
  assert.equal(cm93ScaleForZoom(6), 'C');
  assert.equal(cm93ScaleForZoom(8), 'D');
  assert.equal(cm93ScaleForZoom(10), 'E');
  assert.equal(cm93ScaleForZoom(12), 'F');
  assert.equal(cm93ScaleForZoom(14), 'G');
});

test('selects only cells matching the chosen scale and viewport grid when available', () => {
  const target = cell('D', '03841050.D', 'cm93/03301020/D/03841050.D');
  const otherScale = cell('E', '03841050.E', 'cm93/03301020/E/03841050.E');
  const result = selectCm93ViewportCells([target, otherScale], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 8);

  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, [target]);
  assert.deepEqual(result.scaleCounts, { D: 1 });
});

test('falls back to the nearest coarser cell when the target-scale cell is missing', () => {
  const coarse = cell('C', '03781044.C', 'cm93/03301020/C/03781044.C');
  const result = selectCm93ViewportCells([coarse], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 8);

  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, [coarse]);
  assert.deepEqual(result.scaleCounts, { C: 1 });
});

test('prefers a finer cell in one footprint and uses coarse fallback for an adjacent missing footprint', () => {
  const fine = cell('D', '03841050.D', 'cm93/03301020/D/03841050.D');
  const coarse = cell('C', '03781044.C', 'cm93/03301020/C/03781044.C');
  const result = selectCm93ViewportCells([fine, coarse], {
    west: -9.4, south: 38.4, east: -8.8, north: 38.9,
  }, 8);

  assert.ok(result.files.includes(fine));
  assert.ok(result.files.includes(coarse));
  assert.equal(result.scale, 'D');
  assert.equal(result.scaleCounts.D, 1);
  assert.equal(result.scaleCounts.C, 1);
});

test('returns an empty selection when no scale has a cell in the viewport', () => {
  const result = selectCm93ViewportCells([], {
    west: -10, south: 37, east: -8, north: 39,
  }, 8);
  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, []);
});

test('limits the number of selected cells for large viewports', () => {
  const result = selectCm93ViewportCells([], {
    west: -180, south: -70, east: 180, north: 70,
  }, 14, 12);
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
      files.push(cell('G', filename, `cm93/${root}/g/${filename}`));
    }
  }
  const result = selectCm93ViewportCells(files, {
    west: 0, south: 0, east: 6, north: 6,
  }, 14, 1200);

  assert.equal(result.files.length, 361);
  assert.equal(result.scaleCounts.G, 361);
});

test('does not carry stale previous-scale features into the current viewport quilt', () => {
  const previousCoarse = {
    type: 'Feature',
    properties: { cm93Class: 'DEPCNT', cm93SourceCell: 'cm93/02100000/c/02460000.c' },
    geometry: { type: 'LineString', coordinates: [[-9, 38], [-8.9, 38.1]] },
  };
  const currentFine = {
    type: 'Feature',
    properties: { cm93Class: 'DEPCNT', cm93SourceCell: 'cm93/02100000/g/02460000.g' },
    geometry: { type: 'LineString', coordinates: [[-9, 38], [-8.95, 38.05]] },
  };

  const merged = mergeCm93QuiltFeatures(
    [currentFine],
    [previousCoarse],
    new Set(['cm93/02100000/g/02460000.g']),
  );
  assert.deepEqual(merged, [currentFine]);
  assert.ok(!merged.includes(previousCoarse));
});

test('returns an empty current quilt instead of resurrecting stale prior-render data', () => {
  const previous = {
    type: 'Feature',
    properties: { cm93Class: 'DEPCNT', cm93SourceCell: 'cm93/02100000/c/02460000.c' },
    geometry: { type: 'LineString', coordinates: [[-9, 38], [-8.9, 38.1]] },
  };
  assert.deepEqual(mergeCm93QuiltFeatures([], [previous], new Set()), []);
});

test('does not retain unrecognized prior-render features', () => {
  const legacy = {
    type: 'Feature',
    properties: { cm93Class: 'DEPARE', cm93SourceCell: 'coarse-cell.c' },
    geometry: { type: 'Polygon', coordinates: [] },
  };
  assert.deepEqual(mergeCm93QuiltFeatures([], [legacy], new Set(['fine-cell.g'])), []);
});

test('provides an ordered coarser fallback chain for a target footprint', () => {
  const fine = cell('D', '03841050.D', 'cm93/03301020/d/03841050.d');
  const coarse = cell('C', '03781044.C', 'cm93/03301020/c/03781044.c');
  const result = selectCm93ViewportCells([fine, coarse], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 8);

  const group = result.candidateGroups.find((item) => item.candidates.some((candidate) => candidate.file === fine));
  assert.ok(group);
  assert.equal(group.candidates[0].file, fine);
  assert.equal(group.candidates[0].scale, 'D');
  assert.equal(group.candidates[1].file, coarse);
  assert.equal(group.candidates[1].scale, 'C');
});

test('clips coarser fallback lines to the uncovered target footprint', () => {
  const coarseFeature = {
    type: 'Feature',
    properties: { cm93Class: 'DEPCNT' },
    geometry: { type: 'LineString', coordinates: [[-10, 38], [-8, 39]] },
  };
  const clipped = clipCm93FeaturesToBounds([coarseFeature], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  });

  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].geometry.type, 'LineString');
  for (const [longitude, latitude] of clipped[0].geometry.coordinates) {
    assert.ok(longitude >= -9.3 - 1e-8 && longitude <= -8.9 + 1e-8);
    assert.ok(latitude >= 38.5 - 1e-8 && latitude <= 38.9 + 1e-8);
  }
});

test('does not return coarse fallback geometry wholly outside its target footprint', () => {
  const coarseFeature = {
    type: 'Feature',
    properties: { cm93Class: 'DEPCNT' },
    geometry: { type: 'LineString', coordinates: [[-10, 36], [-9.5, 36.5]] },
  };
  assert.deepEqual(clipCm93FeaturesToBounds([coarseFeature], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }), []);
});
