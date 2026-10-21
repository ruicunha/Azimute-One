import test from 'node:test';
import assert from 'node:assert/strict';
import { cm93ScaleForZoom, selectCm93ViewportCells } from './cm93-quilt.ts';

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
  const coarse = cell('C', '03841044.C', 'cm93/03301020/C/03841044.C');
  const result = selectCm93ViewportCells([coarse], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 8);

  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, [coarse]);
  assert.deepEqual(result.scaleCounts, { C: 1 });
});

test('prefers a finer cell in one footprint and uses coarse fallback for an adjacent missing footprint', () => {
  const fine = cell('D', '03841050.D', 'cm93/03301020/D/03841050.D');
  const coarse = cell('03841044.C', '03841044.C', 'cm93/03301020/C/03841044.C');
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
