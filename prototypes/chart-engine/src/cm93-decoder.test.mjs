import test from 'node:test';
import assert from 'node:assert/strict';
import { Cm93BinaryReader, Cm93DecodeError, cm93OffsetsToWgs84, decodeCm93CellHeader, decodeCm93FeatureAttributes, assembleCm93VectorPaths, cm93CellToGeoJSON, cm93RingsToPolygonCoordinates, cm93GridPointToWgs84, parseCm93Dictionaries } from './cm93-decoder.ts';

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
    'CPDATE|150|aSTRING\nCSCALE|151|aLONG',
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

test('converts CM93 16-bit grid endpoints using the cell Mercator bounds', () => {
  const metadata = {
    geographicBounds: { west: 0, south: -60, east: 20, north: -40 },
    projectedBounds: {
      west: 0,
      south: -8400068.5658788,
      east: 2226477.4513319735,
      north: -4866133.821880401,
    },
    vectorRecordCount: 0,
    vectorPointCount: 0,
    point3dRecordCount: 0,
    point3dPointCount: 0,
    point2dCount: 0,
    featureCount: 0,
    relatedObjectPointerCount: 0,
    attributeByteCount: 0,
  };
  const southwest = cm93GridPointToWgs84(metadata, 0, 0);
  const northeast = cm93GridPointToWgs84(metadata, 65535, 65535);
  assert.ok(Math.abs(southwest[0]) < 1e-8);
  assert.ok(Math.abs(southwest[1] - (-60)) < 1e-6);
  assert.ok(Math.abs(northeast[0] - 20) < 1e-6);
  assert.ok(Math.abs(northeast[1] - (-40)) < 1e-6);
});

test('assembles decoded CM93 point features and typed attributes into GeoJSON', () => {
  const dictionary = parseCm93Dictionaries(
    'BCNLAT|7|P|8|Beacon, lateral|OBJNAM',
    'CPDATE|150|aSTRING',
  );
  const rawAttributes = Uint8Array.from([150, ...new TextEncoder().encode('20050629'), 0]);
  const cell = {
    header: {
      fileSize: 2752,
      headerLength: 138,
      table1Length: 1826,
      table2Length: 788,
      table1Offset: 138,
      table2Offset: 1964,
      decodedHeader: new Uint8Array(138),
    },
    metadata: {
      geographicBounds: { west: 0, south: -60, east: 20, north: -40 },
      projectedBounds: {
        west: 0,
        south: -8400068.5658788,
        east: 2226477.4513319735,
        north: -4866133.821880401,
      },
      vectorRecordCount: 0,
      vectorPointCount: 0,
      point3dRecordCount: 0,
      point3dPointCount: 0,
      point2dCount: 1,
      featureCount: 1,
      relatedObjectPointerCount: 0,
      attributeByteCount: rawAttributes.length,
    },
    vectors: [],
    points3d: [],
    points2d: [[32767, 32767]],
    features: [{
      objectCode: 7,
      geometryType: 0x81,
      descriptorLength: 16,
      geometry: { kind: 'point', index: 0 },
      relatedObjectIndexes: [],
      attributeCount: 1,
      rawAttributes,
    }],
  };
  const result = cm93CellToGeoJSON(cell, dictionary);
  assert.equal(result.geojson.features.length, 1);
  assert.equal(result.omittedGeometryCount, 0);
  assert.equal(result.geojson.features[0].properties?.cm93Class, 'BCNLAT');
  assert.equal(result.geojson.features[0].properties?.CPDATE, '20050629');
  assert.equal(result.geojson.features[0].geometry?.type, 'Point');
  const coordinates = result.geojson.features[0].geometry?.type === 'Point'
    ? result.geojson.features[0].geometry.coordinates
    : [];
  assert.ok(Math.abs(coordinates[0] - 10) < 1e-3);
  assert.ok(coordinates[1] > -52 && coordinates[1] < -50);
});


test('keeps disconnected CM93 vector segments as separate paths', () => {
  const vectors = [
    { points: [[0, 0], [1, 1]] },
    { points: [[1, 1], [2, 2]] },
    { points: [[10, 10], [11, 11]] },
  ];
  const paths = assembleCm93VectorPaths(vectors, [
    { index: 0, segmentUsage: 0 },
    { index: 1, segmentUsage: 0 },
    { index: 2, segmentUsage: 0 },
  ]);
  assert.deepEqual(paths, [
    [[0, 0], [1, 1], [2, 2]],
    [[10, 10], [11, 11]],
  ]);
});

test('honours the segment reverse flag while joining connected vectors', () => {
  const vectors = [
    { points: [[0, 0], [1, 1]] },
    { points: [[2, 2], [1, 1]] },
  ];
  const paths = assembleCm93VectorPaths(vectors, [
    { index: 0, segmentUsage: 0 },
    { index: 1, segmentUsage: 4 },
  ]);
  assert.deepEqual(paths, [[[0, 0], [1, 1], [2, 2]]]);
});

test('does not invent a bridge between separated vector endpoints', () => {
  const vectors = [
    { points: [[0, 0], [1, 1]] },
    { points: [[3, 3], [4, 4]] },
  ];
  const paths = assembleCm93VectorPaths(vectors, [
    { index: 0, segmentUsage: 0 },
    { index: 1, segmentUsage: 0 },
  ]);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].at(-1)?.[0], 1);
  assert.equal(paths[1][0][0], 3);
});


test('preserves holes in CM93 area rings instead of filling them as separate polygons', () => {
  const outer = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const hole = [[2, 2], [2, 8], [8, 8], [8, 2], [2, 2]];
  const polygons = cm93RingsToPolygonCoordinates([outer, hole]);
  assert.equal(polygons.length, 1);
  assert.equal(polygons[0].length, 2, 'outer boundary and interior hole should share one polygon');
});

test('keeps an island nested inside a hole as a separate polygon', () => {
  const outer = [[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]];
  const hole = [[2, 2], [2, 18], [18, 18], [18, 2], [2, 2]];
  const island = [[5, 5], [15, 5], [15, 15], [5, 15], [5, 5]];
  const polygons = cm93RingsToPolygonCoordinates([outer, hole, island]);
  assert.equal(polygons.length, 2);
  assert.equal(polygons[0].length, 2);
  assert.equal(polygons[1].length, 1);
});
