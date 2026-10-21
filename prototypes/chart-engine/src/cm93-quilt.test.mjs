import test from 'node:test';
import assert from 'node:assert/strict';
import { cm93ScaleForZoom, selectCm93ViewportCells } from './cm93-quilt.ts';

test('selects progressively finer provisional CM93 scales as zoom increases', () => {
  assert.equal(cm93ScaleForZoom(2), 'Z');
  assert.equal(cm93ScaleForZoom(3.5), 'A');
  assert.equal(cm93ScaleForZoom(4.5), 'B');
  assert.equal(cm93ScaleForZoom(6), 'C');
  assert.equal(cm93ScaleForZoom(8), 'D');
  assert.equal(cm93ScaleForZoom(10), 'E');
  assert.equal(cm93ScaleForZoom(12), 'F');
  assert.equal(cm93ScaleForZoom(14), 'G');
});

test('selects only cells matching the chosen scale and viewport grid', () => {
  const target = {
    name: '03841050.D',
    webkitRelativePath: 'cm93/03301020/D/03841050.D',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const otherScale = {
    name: '03841050.E',
    webkitRelativePath: 'cm93/03301020/E/03841050.E',
    arrayBuffer: async () => new ArrayBuffer(0),
  };
  const result = selectCm93ViewportCells([target, otherScale], {
    west: -9.3, south: 38.5, east: -8.9, north: 38.9,
  }, 8);

  assert.equal(result.scale, 'D');
  assert.deepEqual(result.files, [target]);
});

test('returns an empty selection when no cell exists at the chosen scale', () => {
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
