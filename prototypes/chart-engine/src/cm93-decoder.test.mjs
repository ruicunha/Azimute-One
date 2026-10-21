import test from 'node:test';
import assert from 'node:assert/strict';
import { Cm93BinaryReader, Cm93DecodeError, cm93OffsetsToWgs84, decodeCm93CellHeader, decodeCm93FeatureAttributes, parseCm93Dictionaries } from './cm93-decoder.ts';

const firstCellHeader = Uint8Array.from([
  0x48, 0xc5, 0x49, 0x73, 0xc5, 0xc5, 0x74, 0x40, 0xc5, 0xc5,
]);

test('decodes and validates a real CM93 V2 cell header', () => {
  const header = decodeCm93CellHeader(firstCellHeader, 2752, '00900000.A');
  assert.equal(header.headerLength, 138);
  assert.equal(header.table1Length, 1826);
  assert.equal(header.table2Length, 788);
  assert.equal(header.table1Offset, 138);
  assert.equal(header.table2Offset, 1964);
  assert.equal(header.fileSize, 2752);
});

test('rejects a CM93 header whose table lengths do not match the file size', () => {
  assert.throws(
    () => decodeCm93CellHeader(firstCellHeader, 2753, '00900000.A'),
    /cell length mismatch/,
  );
});

test('rejects non-CM93 scale extensions and truncated headers', () => {
  assert.throws(() => decodeCm93CellHeader(firstCellHeader, 2752, 'chart.000'), /scale extension/);
  assert.throws(() => decodeCm93CellHeader(firstCellHeader.slice(0, 9), 2752, '00900000.A'), /too short/);
});

test('binary reader uses little-endian values and checks bounds', () => {
  const reader = new Cm93BinaryReader(Uint8Array.from([0x34, 0x12, 0x78, 0x56, 0x34, 0x12]));
  assert.equal(reader.readUint16LE(), 0x1234);
  assert.equal(reader.readUint32LE(), 0x12345678);
  assert.throws(() => reader.readUint8(), Cm93DecodeError);
});

test('dictionary parser resolves object classes and attribute definitions', () => {
  const dictionary = parseCm93Dictionaries(
    'BCNLAT|7|P|8|Beacon, lateral|BCNSHP|CATLAM|OBJNAM',
    'BCNSHP|103|aBYTE|1|4\nOBJNAM|120|aSTRING',
  );
  assert.equal(dictionary.objectsByCode.get(7)?.name, 'BCNLAT');
  assert.deepEqual(dictionary.objectsByCode.get(7)?.attributeNames, ['BCNSHP', 'CATLAM', 'OBJNAM']);
  assert.equal(dictionary.attributesByCode.get(103)?.valueType, 'aBYTE');
});

test('coordinate conversion rejects impossible WGS84 coordinates', () => {
  const point = cm93OffsetsToWgs84(-9, 38, 1, 2, 0.01, 0.01);
  assert.ok(Math.abs(point[0] - (-8.99)) < 1e-9);
  assert.ok(Math.abs(point[1] - 38.02) < 1e-9);
  assert.throws(() => cm93OffsetsToWgs84(179, 89, 1000, 1000, 1, 1), /outside WGS84 bounds/);
});

test('decodes common CM93 string and integer attributes using dictionary types', () => {
  const dictionary = parseCm93Dictionaries(
    'LIGHTS|55|P|8|Light|CATLIT|OBJNAM',
    'CPDATE|150|aSTRING\\nCSCALE|151|aLONG',
  );
  const raw = Uint8Array.from([
    150, ...new TextEncoder().encode('20050629'), 0,
    151, 0xc0, 0xc6, 0x2d, 0x00,
  ]);
  const attributes = decodeCm93FeatureAttributes(raw, 2, dictionary);
  assert.deepEqual(attributes.map((attribute) => [attribute.name, attribute.value]), [
    ['CPDATE', '20050629'],
    ['CSCALE', 3000000],
  ]);
  assert.ok(attributes.every((attribute) => attribute.supported));
});
