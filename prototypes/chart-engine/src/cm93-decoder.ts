/**
 * Independent CM93 V2 decoding primitives.
 *
 * This module deliberately contains no code or lookup tables copied from
 * GPL-licensed implementations. It parses the published text dictionaries,
 * provides bounded binary reads, and converts already-decoded CM93 coordinate
 * deltas into WGS84. The byte-substitution permutation is recovered from
 * cell-header length constraints; feature record decoding is a separate stage.
 */

const CM93_DECODE_MAP = new Uint8Array([
  0x61, 0x5c, 0x3f, 0xae, 0x4c, 0x4a, 0x2f, 0x1e, 0x24, 0x9e, 0x1c, 0xd6, 0x80, 0x0d, 0x73, 0x7e,
  0x37, 0xef, 0x41, 0xcb, 0xed, 0x93, 0x57, 0xf0, 0xf6, 0xad, 0xb8, 0xbc, 0x40, 0xdd, 0xcc, 0x95,
  0x97, 0x47, 0xfc, 0xab, 0xaa, 0x99, 0xf8, 0x88, 0xe4, 0xb3, 0x3e, 0x84, 0x21, 0x98, 0x83, 0x20,
  0xbf, 0x12, 0x9b, 0x35, 0x5e, 0xd7, 0x04, 0x50, 0x3b, 0xb4, 0xdf, 0x7f, 0x23, 0xec, 0xd4, 0x81,
  0x03, 0x31, 0xea, 0x8d, 0x6c, 0xba, 0x1d, 0x54, 0x8a, 0x22, 0xfd, 0xbd, 0xda, 0xbe, 0xa8, 0xc6,
  0x86, 0x36, 0x25, 0x74, 0xfb, 0x1b, 0x8b, 0xee, 0xac, 0xf5, 0x08, 0x7a, 0xca, 0x7b, 0x15, 0xa9,
  0x18, 0x5a, 0xc8, 0xd0, 0x2b, 0x05, 0x19, 0x91, 0x11, 0xf9, 0x8e, 0xe3, 0x71, 0x7c, 0x69, 0x68,
  0x72, 0xce, 0x16, 0x07, 0x14, 0xf1, 0xcd, 0x8c, 0xf2, 0xd3, 0xd8, 0x92, 0x2c, 0x49, 0xa6, 0xe1,
  0xe5, 0xc7, 0xbb, 0xdb, 0x67, 0x7d, 0x0b, 0x3a, 0x8f, 0x59, 0xc4, 0xe2, 0x56, 0x13, 0x39, 0xc1,
  0x9c, 0x77, 0x64, 0x75, 0x53, 0xfa, 0x2e, 0xde, 0xa2, 0xd1, 0x82, 0xa7, 0x48, 0xa5, 0x2d, 0x0f,
  0x3d, 0x38, 0x46, 0x0c, 0x4b, 0xe7, 0x6a, 0x5f, 0xc2, 0x1f, 0xd2, 0x60, 0x0a, 0x6d, 0xb9, 0x0e,
  0x5d, 0x10, 0x17, 0x4e, 0xa1, 0xcf, 0xfe, 0x62, 0xa3, 0x58, 0x42, 0x89, 0x5b, 0x85, 0x70, 0xd5,
  0xc9, 0x43, 0x06, 0x27, 0x96, 0x00, 0x78, 0xdc, 0x34, 0xaf, 0x30, 0x3c, 0xe0, 0x4f, 0xd9, 0x44,
  0xb7, 0x52, 0x87, 0x79, 0x02, 0xa0, 0xb5, 0x94, 0x28, 0xf4, 0xc0, 0xf7, 0x6b, 0x55, 0xb2, 0x65,
  0xe9, 0xeb, 0x01, 0x9f, 0x6e, 0x45, 0x9a, 0xc3, 0x63, 0x09, 0x9d, 0x32, 0x90, 0x33, 0xff, 0xb1,
  0x2a, 0x6f, 0x29, 0xf3, 0xa4, 0x51, 0x26, 0xb6, 0xb0, 0xc5, 0x76, 0xe8, 0x4d, 0x1a, 0xe6, 0x66,
]);

export type Cm93AttributeDefinition = {
  name: string;
  code: number;
  valueType: string;
  fields: string[];
};

export type Cm93ObjectDefinition = {
  name: string;
  code: number;
  geometry: string;
  attributeNames: string[];
  description: string;
  fields: string[];
};

export type Cm93Dictionary = {
  attributesByCode: Map<number, Cm93AttributeDefinition>;
  attributesByName: Map<string, Cm93AttributeDefinition>;
  objectsByCode: Map<number, Cm93ObjectDefinition>;
  objectsByName: Map<string, Cm93ObjectDefinition>;
};

export type Cm93DecodedFeature = {
  objectCode: number;
  objectName: string;
  geometry: GeoJSON.Geometry;
  properties: Record<string, string | number | boolean | null>;
};

export class Cm93DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Cm93DecodeError';
  }
}

/** Parse the pipe-delimited CM93OBJ.DIC and CM93ATTR.DIC text dictionaries. */
export function parseCm93Dictionaries(
  objectDictionary: string,
  attributeDictionary: string,
): Cm93Dictionary {
  const attributesByCode = new Map<number, Cm93AttributeDefinition>();
  const attributesByName = new Map<string, Cm93AttributeDefinition>();
  const objectsByCode = new Map<number, Cm93ObjectDefinition>();
  const objectsByName = new Map<string, Cm93ObjectDefinition>();

  for (const line of attributeDictionary.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    const fields = trimmed.split('|');
    if (fields.length < 3) continue;
    const code = Number.parseInt(fields[1], 10);
    if (!Number.isSafeInteger(code) || code < 0) continue;
    const definition = {
      name: fields[0].trim(),
      code,
      valueType: fields[2].trim(),
      fields,
    };
    attributesByCode.set(code, definition);
    attributesByName.set(definition.name.toUpperCase(), definition);
  }

  for (const line of objectDictionary.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;
    const fields = trimmed.split('|');
    if (fields.length < 5) continue;
    const code = Number.parseInt(fields[1], 10);
    if (!Number.isSafeInteger(code) || code < 0) continue;
    const attributeNames = fields.slice(5).map((value) => value.trim()).filter(Boolean);
    const definition = {
      name: fields[0].trim(),
      code,
      geometry: fields[2].trim(),
      description: fields[4].trim(),
      attributeNames,
      fields,
    };
    objectsByCode.set(code, definition);
    objectsByName.set(definition.name.toUpperCase(), definition);
  }

  if (objectsByCode.size === 0 || attributesByCode.size === 0) {
    throw new Cm93DecodeError('The CM93 dictionaries could not be parsed. Check that CM93OBJ.DIC and CM93ATTR.DIC are the original text dictionaries.');
  }

  return { attributesByCode, attributesByName, objectsByCode, objectsByName };
}

/**
 * A bounds-checked reader for the little-endian primitives used by the
 * independently documented portion of the decoder. It never mutates input.
 */
export class Cm93BinaryReader {
  private readonly view: DataView;
  private offsetValue = 0;

  constructor(bytes: Uint8Array, offset = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.seek(offset);
  }

  get offset(): number {
    return this.offsetValue;
  }

  get remaining(): number {
    return this.view.byteLength - this.offsetValue;
  }

  seek(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.view.byteLength) {
      throw new Cm93DecodeError(`Invalid CM93 byte offset: ${offset}.`);
    }
    this.offsetValue = offset;
  }

  readUint8(): number {
    this.ensure(1);
    return this.view.getUint8(this.offsetValue++);
  }

  readInt16LE(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offsetValue, true);
    this.offsetValue += 2;
    return value;
  }

  readUint16LE(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offsetValue, true);
    this.offsetValue += 2;
    return value;
  }

  readUint32LE(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offsetValue, true);
    this.offsetValue += 4;
    return value;
  }

  readInt32LE(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offsetValue, true);
    this.offsetValue += 4;
    return value;
  }

  readFloat32LE(): number {
    this.ensure(4);
    const value = this.view.getFloat32(this.offsetValue, true);
    this.offsetValue += 4;
    return value;
  }

  readFloat64LE(): number {
    this.ensure(8);
    const value = this.view.getFloat64(this.offsetValue, true);
    this.offsetValue += 8;
    return value;
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0) {
      throw new Cm93DecodeError(`Invalid CM93 byte length: ${length}.`);
    }
    this.ensure(length);
    const start = this.offsetValue;
    this.offsetValue += length;
    return new Uint8Array(this.view.buffer, this.view.byteOffset + start, length).slice();
  }

  private ensure(length: number): void {
    if (length > this.remaining) {
      throw new Cm93DecodeError(`CM93 cell is truncated at byte ${this.offsetValue}; need ${length} byte(s), have ${this.remaining}.`);
    }
  }
}

/**
 * Convert decoded cell-relative longitude/latitude offsets to WGS84.
 * The caller must supply the cell origin and scale factors established from
 * the corresponding CM93 cell header; no scale is guessed here.
 */
export function cm93OffsetsToWgs84(
  originLongitude: number,
  originLatitude: number,
  longitudeOffset: number,
  latitudeOffset: number,
  longitudeDegreesPerUnit: number,
  latitudeDegreesPerUnit: number,
): [number, number] {
  const values = [originLongitude, originLatitude, longitudeOffset, latitudeOffset, longitudeDegreesPerUnit, latitudeDegreesPerUnit];
  if (!values.every(Number.isFinite)) throw new Cm93DecodeError('CM93 coordinate values must be finite.');
  if (Math.abs(originLongitude) > 180 || Math.abs(originLatitude) > 90) {
    throw new Cm93DecodeError('CM93 cell origin is outside WGS84 longitude/latitude bounds.');
  }
  const longitude = originLongitude + longitudeOffset * longitudeDegreesPerUnit;
  const latitude = originLatitude + latitudeOffset * latitudeDegreesPerUnit;
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    throw new Cm93DecodeError('Decoded CM93 coordinate is outside WGS84 bounds; cell scale/origin may be wrong.');
  }
  return [longitude, latitude];
}


export type Cm93CellHeader = {
  fileSize: number;
  headerLength: number;
  table1Length: number;
  table2Length: number;
  table1Offset: number;
  table2Offset: number;
  decodedHeader: Uint8Array;
};

function validateCellFilename(filename: string): void {
  const extension = filename.split('.').pop()?.toUpperCase();
  if (!extension || !/^[A-GZ]$/.test(extension)) {
    throw new Cm93DecodeError('Select a CM93 V2 cell file with an A–G or Z scale extension.');
  }
}

/**
 * Decode just the ten-byte length header. Accepting the known file size
 * separately makes this useful for corpus validation without retaining every
 * full chart cell in memory.
 */
export function decodeCm93CellHeader(
  encodedHeader: Uint8Array,
  fileSize: number,
  filename: string,
): Cm93CellHeader {
  validateCellFilename(filename);
  if (encodedHeader.byteLength < 10) throw new Cm93DecodeError('CM93 cell is too short to contain its length header.');
  if (!Number.isSafeInteger(fileSize) || fileSize < 10) throw new Cm93DecodeError('Invalid CM93 cell file size.');

  const decoded = new Uint8Array(10);
  for (let i = 0; i < 10; i++) decoded[i] = CM93_DECODE_MAP[encodedHeader[i]];
  const reader = new Cm93BinaryReader(decoded);
  const headerLength = reader.readUint16LE();
  const table1Length = reader.readUint32LE();
  const table2Length = reader.readUint32LE();
  if (headerLength < 10 || headerLength > fileSize) {
    throw new Cm93DecodeError(`Invalid CM93 header length ${headerLength} in ${filename}.`);
  }
  if (headerLength + table1Length + table2Length !== fileSize) {
    throw new Cm93DecodeError(
      `CM93 cell length mismatch in ${filename}: header ${headerLength} + table 1 ${table1Length} + table 2 ${table2Length} != file size ${fileSize}.`,
    );
  }

  return {
    fileSize,
    headerLength,
    table1Length,
    table2Length,
    table1Offset: headerLength,
    table2Offset: headerLength + table1Length,
    decodedHeader: decoded,
  };
}

/** Decode a complete cell and validate its header and table boundaries. */
export function decodeCm93Cell(bytes: Uint8Array, filename: string): Cm93CellHeader {
  const header = decodeCm93CellHeader(bytes.subarray(0, 10), bytes.byteLength, filename);
  const decoded = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) decoded[i] = CM93_DECODE_MAP[bytes[i]];
  return { ...header, decodedHeader: decoded.slice(0, header.headerLength) };
}


export type Cm93CellMetadata = {
  geographicBounds: { west: number; south: number; east: number; north: number };
  projectedBounds: { west: number; south: number; east: number; north: number };
  vectorRecordCount: number;
  vectorPointCount: number;
  point3dRecordCount: number;
  point3dPointCount: number;
  point2dCount: number;
  featureCount: number;
  relatedObjectPointerCount: number;
  attributeByteCount: number;
};

export type Cm93VectorRecord = { points: Array<[number, number]> };
export type Cm93Point3dRecord = { points: Array<[number, number, number]> };

export type Cm93VectorReference = { index: number; segmentUsage: number };

/**
 * Assemble only vector segments whose endpoints actually meet. CM93 feature
 * references can include several independent parts; concatenating every point
 * unconditionally invents lines across gaps in the source geometry.
 */
export function assembleCm93VectorPaths(
  vectors: Cm93VectorRecord[],
  references: Cm93VectorReference[],
): Array<Array<[number, number]>> {
  const paths: Array<Array<[number, number]>> = [];
  for (const reference of references) {
    const source = vectors[reference.index]?.points ?? [];
    const segment = (reference.segmentUsage & 4) !== 0 ? [...source].reverse() : [...source];
    const points = segment.filter((point, index) => {
      if (index === 0) return true;
      const previous = segment[index - 1];
      return point[0] !== previous[0] || point[1] !== previous[1];
    });
    if (points.length < 2) continue;

    const current = paths[paths.length - 1];
    const first = points[0];
    const last = current?.[current.length - 1];
    if (current && last && last[0] === first[0] && last[1] === first[1]) {
      current.push(...points.slice(1));
    } else {
      // Keep disconnected geometry separate instead of drawing a false bridge.
      paths.push(points);
    }
  }
  return paths;
}
export type Cm93GeometryReference =
  | { kind: 'area' | 'line'; vectors: Array<{ index: number; segmentUsage: number }> }
  | { kind: 'point'; index: number }
  | { kind: 'point3d'; index: number }
  | { kind: 'unknown' };

export type Cm93FeatureRecord = {
  objectCode: number;
  geometryType: number;
  descriptorLength: number;
  geometry: Cm93GeometryReference;
  relatedObjectIndexes: number[];
  attributeCount: number;
  rawAttributes: Uint8Array;
};

export type Cm93ParsedCell = {
  header: Cm93CellHeader;
  metadata: Cm93CellMetadata;
  vectors: Cm93VectorRecord[];
  points3d: Cm93Point3dRecord[];
  points2d: Array<[number, number]>;
  features: Cm93FeatureRecord[];
};

function checkedCount(value: number, label: string, maximum = 2_000_000): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Cm93DecodeError(`Invalid CM93 ${label} count: ${value}.`);
  }
  return value;
}

/**
 * Parse the independently verified cell header, geometry tables and feature
 * record framing. Feature attributes remain raw bytes at this stage; typed
 * attribute decoding and map portrayal are deliberately separate steps.
 */
export function parseCm93Cell(bytes: Uint8Array, filename: string): Cm93ParsedCell {
  const header = decodeCm93CellHeader(bytes.subarray(0, 10), bytes.byteLength, filename);
  if (header.headerLength < 138) {
    throw new Cm93DecodeError(`CM93 header in ${filename} is shorter than the 128-byte cell metadata block.`);
  }

  const decoded = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) decoded[i] = CM93_DECODE_MAP[bytes[i]];
  header.decodedHeader = decoded.slice(0, header.headerLength);

  const headerReader = new Cm93BinaryReader(decoded, 10);
  const lonMin = headerReader.readFloat64LE();
  const latMin = headerReader.readFloat64LE();
  const lonMax = headerReader.readFloat64LE();
  const latMax = headerReader.readFloat64LE();
  const eastingMin = headerReader.readFloat64LE();
  const northingMin = headerReader.readFloat64LE();
  const eastingMax = headerReader.readFloat64LE();
  const northingMax = headerReader.readFloat64LE();

  const vectorRecordCount = checkedCount(headerReader.readUint16LE(), 'vector record');
  const vectorPointCount = checkedCount(headerReader.readInt32LE(), 'vector point');
  headerReader.readInt32LE(); // Reserved/auxiliary descriptor count.
  headerReader.readInt32LE(); // Reserved/auxiliary descriptor count.
  const point3dRecordCount = checkedCount(headerReader.readUint16LE(), '3D point record');
  const point3dPointCount = checkedCount(headerReader.readInt32LE(), '3D point');
  headerReader.readInt32LE(); // Reserved/auxiliary 3D count.
  const point2dCount = checkedCount(headerReader.readUint16LE(), '2D point');
  headerReader.readUint16LE(); // Auxiliary point count.
  headerReader.readUint16LE(); // Auxiliary point count.
  const featureCount = checkedCount(headerReader.readUint16LE(), 'feature record', 100_000);
  headerReader.readInt32LE(); // Auxiliary count.
  headerReader.readInt32LE(); // Auxiliary count.
  headerReader.readUint16LE(); // Auxiliary count.
  headerReader.readUint16LE(); // Auxiliary count.
  headerReader.readUint16LE(); // Auxiliary count.
  const relatedObjectPointerCount = checkedCount(headerReader.readInt32LE(), 'related-object pointer');
  headerReader.readInt32LE(); // Auxiliary count.
  headerReader.readUint16LE(); // Auxiliary count.
  const attributeByteCount = checkedCount(headerReader.readInt32LE(), 'attribute byte');
  headerReader.readInt32LE(); // Auxiliary count.

  const geographicValues = [lonMin, latMin, lonMax, latMax];
  const projectedValues = [eastingMin, northingMin, eastingMax, northingMax];
  if (!geographicValues.every(Number.isFinite) ||
      Math.abs(lonMin) > 360 || Math.abs(lonMax) > 360 ||
      Math.abs(latMin) > 90 || Math.abs(latMax) > 90 ||
      !projectedValues.every(Number.isFinite) || latMin > latMax) {
    throw new Cm93DecodeError(`Invalid coordinate bounds in CM93 cell ${filename}.`);
  }

  const metadata: Cm93CellMetadata = {
    geographicBounds: { west: lonMin, south: latMin, east: lonMax, north: latMax },
    projectedBounds: { west: eastingMin, south: northingMin, east: eastingMax, north: northingMax },
    vectorRecordCount,
    vectorPointCount,
    point3dRecordCount,
    point3dPointCount,
    point2dCount,
    featureCount,
    relatedObjectPointerCount,
    attributeByteCount,
  };

  const tableReader = new Cm93BinaryReader(decoded, header.headerLength);
  const vectors: Cm93VectorRecord[] = [];
  let actualVectorPoints = 0;
  for (let record = 0; record < vectorRecordCount; record++) {
    const pointCount = checkedCount(tableReader.readUint16LE(), 'points in vector record', 65_535);
    actualVectorPoints += pointCount;
    if (actualVectorPoints > vectorPointCount) {
      throw new Cm93DecodeError(`Vector point count exceeds the CM93 header total in ${filename}.`);
    }
    const points: Array<[number, number]> = [];
    for (let point = 0; point < pointCount; point++) {
      points.push([tableReader.readUint16LE(), tableReader.readUint16LE()]);
    }
    vectors.push({ points });
  }
  if (actualVectorPoints !== vectorPointCount) {
    throw new Cm93DecodeError(`Vector point count mismatch in CM93 cell ${filename}.`);
  }

  const points3d: Cm93Point3dRecord[] = [];
  let actual3dPoints = 0;
  for (let record = 0; record < point3dRecordCount; record++) {
    const pointCount = checkedCount(tableReader.readUint16LE(), 'points in 3D record', 65_535);
    actual3dPoints += pointCount;
    if (actual3dPoints > point3dPointCount) {
      throw new Cm93DecodeError(`3D point count exceeds the CM93 header total in ${filename}.`);
    }
    const points: Array<[number, number, number]> = [];
    for (let point = 0; point < pointCount; point++) {
      points.push([tableReader.readUint16LE(), tableReader.readUint16LE(), tableReader.readUint16LE()]);
    }
    points3d.push({ points });
  }
  if (actual3dPoints !== point3dPointCount) {
    throw new Cm93DecodeError(`3D point count mismatch in CM93 cell ${filename}.`);
  }

  const points2d: Array<[number, number]> = [];
  for (let point = 0; point < point2dCount; point++) {
    points2d.push([tableReader.readUint16LE(), tableReader.readUint16LE()]);
  }
  if (tableReader.offset !== header.table2Offset) {
    throw new Cm93DecodeError(
      `CM93 geometry table boundary mismatch in ${filename}: parsed to byte ${tableReader.offset}, expected ${header.table2Offset}.`,
    );
  }

  const featureReader = new Cm93BinaryReader(decoded, header.table2Offset);
  const table2End = header.table2Offset + header.table2Length;
  const features: Cm93FeatureRecord[] = [];
  let actualAttributeBytes = 0;
  for (let record = 0; record < featureCount; record++) {
    const recordStart = featureReader.offset;
    const objectCode = featureReader.readUint8();
    const geometryType = featureReader.readUint8();
    const descriptorLength = featureReader.readUint16LE();
    const recordEnd = recordStart + descriptorLength;
    if (descriptorLength < 4 || recordEnd > table2End) {
      throw new Cm93DecodeError(`Invalid feature descriptor length in ${filename} at byte ${recordStart}.`);
    }

    let geometry: Cm93GeometryReference = { kind: 'unknown' };
    const primitive = geometryType & 0x0f;
    if (primitive === 2 || primitive === 4) {
      const elementCount = checkedCount(featureReader.readUint16LE(), 'geometry element', 65_535);
      const vectorsForFeature: Array<{ index: number; segmentUsage: number }> = [];
      for (let element = 0; element < elementCount; element++) {
        const encodedIndex = featureReader.readUint16LE();
        const index = encodedIndex & 0x1fff;
        if (index >= vectors.length) {
          throw new Cm93DecodeError(`CM93 feature references missing vector ${index} in ${filename}.`);
        }
        vectorsForFeature.push({ index, segmentUsage: encodedIndex >>> 13 });
      }
      geometry = { kind: primitive === 4 ? 'area' : 'line', vectors: vectorsForFeature };
    } else if (primitive === 1) {
      const index = featureReader.readUint16LE();
      if (index >= points2d.length) throw new Cm93DecodeError(`CM93 feature references missing 2D point ${index} in ${filename}.`);
      geometry = { kind: 'point', index };
    } else if (primitive === 8) {
      const index = featureReader.readUint16LE();
      if (index >= points3d.length) throw new Cm93DecodeError(`CM93 feature references missing 3D point ${index} in ${filename}.`);
      geometry = { kind: 'point3d', index };
    }

    const relatedObjectIndexes: number[] = [];
    if ((geometryType & 0x10) !== 0) {
      const relatedCount = featureReader.readUint8();
      for (let related = 0; related < relatedCount; related++) {
        const index = featureReader.readUint16LE();
        if (index >= featureCount) throw new Cm93DecodeError(`CM93 feature references missing related object ${index} in ${filename}.`);
        relatedObjectIndexes.push(index);
      }
    }
    if ((geometryType & 0x20) !== 0) featureReader.readUint16LE();

    let attributeCount = 0;
    let rawAttributes = new Uint8Array();
    if ((geometryType & 0x80) !== 0) {
      attributeCount = featureReader.readUint8();
      const attributeLength = recordEnd - featureReader.offset;
      if (attributeLength < 0) throw new Cm93DecodeError(`CM93 feature fields exceed descriptor length in ${filename}.`);
      rawAttributes = featureReader.readBytes(attributeLength);
      actualAttributeBytes += attributeLength;
    }
    if (featureReader.offset > recordEnd) {
      throw new Cm93DecodeError(`CM93 feature fields exceed descriptor length in ${filename}.`);
    }
    featureReader.seek(recordEnd);
    features.push({ objectCode, geometryType, descriptorLength, geometry, relatedObjectIndexes, attributeCount, rawAttributes });
  }

  if (featureReader.offset !== table2End) {
    throw new Cm93DecodeError(
      `CM93 feature table boundary mismatch in ${filename}: parsed to byte ${featureReader.offset}, expected ${table2End}.`,
    );
  }
  if (actualAttributeBytes !== attributeByteCount) {
    throw new Cm93DecodeError(`Feature attribute byte count mismatch in ${filename}: parsed ${actualAttributeBytes}, header declares ${attributeByteCount}.`);
  }

  return { header, metadata, vectors, points3d, points2d, features };
}


export type Cm93DecodedAttribute = {
  code: number;
  name: string | null;
  value: string | number | number[] | null;
  valueType: string | null;
  supported: boolean;
};

/** Decode the common CM93 attribute encodings using the selected cell's dictionary. */
export function decodeCm93FeatureAttributes(
  rawAttributes: Uint8Array,
  attributeCount: number,
  dictionary: Cm93Dictionary,
): Cm93DecodedAttribute[] {
  checkedCount(attributeCount, 'feature attribute', 255);
  const reader = new Cm93BinaryReader(rawAttributes);
  const attributes: Cm93DecodedAttribute[] = [];
  const readCString = (): string => {
    const bytes: number[] = [];
    while (reader.remaining > 0) {
      const value = reader.readUint8();
      if (value === 0) return new TextDecoder().decode(Uint8Array.from(bytes));
      bytes.push(value);
    }
    throw new Cm93DecodeError('CM93 string attribute is missing its null terminator.');
  };

  for (let index = 0; index < attributeCount; index++) {
    if (reader.remaining < 1) {
      throw new Cm93DecodeError(`CM93 attribute block ended before attribute ${index + 1} of ${attributeCount}.`);
    }
    const code = reader.readUint8();
    const definition = dictionary.attributesByCode.get(code);
    if (!definition) {
      attributes.push({ code, name: null, value: null, valueType: null, supported: false });
      break; // Unknown value width means later attribute boundaries cannot be trusted.
    }

    let value: string | number | number[] | null;
    let supported = true;
    switch (definition.valueType) {
      case 'aSTRING':
        value = readCString();
        break;
      case 'aBYTE':
        value = reader.readUint8();
        break;
      case 'aLIST': {
        const length = reader.readUint8();
        if (length > reader.remaining) throw new Cm93DecodeError(`CM93 list attribute ${definition.name} exceeds its record boundary.`);
        const values: number[] = [];
        for (let item = 0; item < length; item++) values.push(reader.readUint8());
        value = values;
        break;
      }
      case 'aWORD10':
        value = reader.readUint16LE() / 10;
        break;
      case 'aFLOAT':
        value = reader.readFloat32LE();
        break;
      case 'aLONG':
        value = reader.readInt32LE();
        break;
      case 'aCMPLX':
        reader.readBytes(3); // CM93 complex values carry a three-byte prefix.
        value = readCString();
        break;
      case 'aNotUsed':
      default:
        value = null;
        supported = false;
        attributes.push({ code, name: definition.name, value, valueType: definition.valueType, supported });
        return attributes; // Do not guess the width of an unsupported value.
    }
    attributes.push({ code, name: definition.name, value, valueType: definition.valueType, supported });
  }
  return attributes;
}


const CM93_MERCATOR_RADIUS_METERS = 6_378_388;

/**
 * Convert a CM93 cell's 16-bit grid coordinate to longitude/latitude.
 * CM93's projected header bounds use a spherical Mercator radius of 6,378,388 m.
 */
export function cm93GridPointToWgs84(
  metadata: Cm93CellMetadata,
  x: number,
  y: number,
): [number, number] {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 65_535 || y < 0 || y > 65_535) {
    throw new Cm93DecodeError('CM93 grid coordinates must be unsigned 16-bit values.');
  }
  const bounds = metadata.projectedBounds;
  const circumference = 2 * Math.PI * CM93_MERCATOR_RADIUS_METERS;
  let deltaEasting = bounds.east - bounds.west;
  if (deltaEasting < 0) deltaEasting += circumference;
  const easting = bounds.west + (x / 65_535) * deltaEasting;
  const northing = bounds.south + (y / 65_535) * (bounds.north - bounds.south);
  const rawLongitude = (easting / CM93_MERCATOR_RADIUS_METERS) * (180 / Math.PI);
  const longitude = ((rawLongitude + 540) % 360) - 180;
  const latitude = (2 * Math.atan(Math.exp(northing / CM93_MERCATOR_RADIUS_METERS)) - Math.PI / 2) * (180 / Math.PI);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(latitude) > 90) {
    throw new Cm93DecodeError('CM93 grid point could not be converted to WGS84.');
  }
  return [longitude, latitude];
}


/**
 * Convert closed area rings into GeoJSON polygons using containment rather
 * than treating every ring as an independent filled area. CM93 area records
 * may contain outer boundaries and interior holes in the same record.
 */
export function cm93RingsToPolygonCoordinates(
  inputRings: Array<Array<[number, number]>>,
): GeoJSON.Position[][][] {
  const rings = inputRings.filter((ring) => {
    if (ring.length < 4) return false;
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  }).map((coordinates) => ({
    coordinates: coordinates as GeoJSON.Position[],
    area: Math.abs(coordinates.reduce((sum, point, index) => {
      const next = coordinates[(index + 1) % coordinates.length];
      return sum + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2),
    parent: -1,
    depth: 0,
  })).filter((ring) => ring.area > 0);

  const contains = (ring: GeoJSON.Position[], point: [number, number]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      const crosses = ((a[1] > point[1]) !== (b[1] > point[1])) &&
        (point[0] < ((b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]));
      if (crosses) inside = !inside;
    }
    return inside;
  };

  // A ring's first vertex is on its own boundary, but should lie strictly
  // inside any enclosing ring. Choose the smallest enclosing ring as parent.
  for (let i = 0; i < rings.length; i++) {
    const point = rings[i].coordinates[0] as [number, number];
    let parent = -1;
    let parentArea = Infinity;
    for (let j = 0; j < rings.length; j++) {
      if (i === j || rings[j].area <= rings[i].area) continue;
      if (rings[j].area < parentArea && contains(rings[j].coordinates, point)) {
        parent = j;
        parentArea = rings[j].area;
      }
    }
    rings[i].parent = parent;
  }

  const depthOf = (index: number, visiting = new Set<number>()): number => {
    if (rings[index].parent < 0) return 0;
    if (visiting.has(index)) return 0;
    visiting.add(index);
    return 1 + depthOf(rings[index].parent, visiting);
  };
  rings.forEach((ring, index) => { ring.depth = depthOf(index); });

  const polygons: GeoJSON.Position[][][] = [];
  const outerPolygonIndex = new Map<number, number>();
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].depth % 2 !== 0) continue;
    outerPolygonIndex.set(i, polygons.length);
    polygons.push([rings[i].coordinates]);
  }
  for (let i = 0; i < rings.length; i++) {
    if (rings[i].depth % 2 === 0) continue;
    let ancestor = rings[i].parent;
    while (ancestor >= 0 && rings[ancestor].depth % 2 !== 0) ancestor = rings[ancestor].parent;
    const polygonIndex = ancestor >= 0 ? outerPolygonIndex.get(ancestor) : undefined;
    if (polygonIndex !== undefined) polygons[polygonIndex].push(rings[i].coordinates);
  }
  return polygons;
}

export type Cm93GeoJsonResult = {
  geojson: GeoJSON.FeatureCollection;
  omittedGeometryCount: number;
  warnings: string[];
};

/** Assemble decoded CM93 records into GeoJSON, without applying chart portrayal rules. */
export function cm93CellToGeoJSON(cell: Cm93ParsedCell, dictionary: Cm93Dictionary): Cm93GeoJsonResult {
  const features: GeoJSON.Feature[] = [];
  const warnings: string[] = [];
  let omittedGeometryCount = 0;

  const toCoordinates = (points: Array<[number, number]>): GeoJSON.Position[] =>
    points.map(([x, y]) => cm93GridPointToWgs84(cell.metadata, x, y));

  for (let recordIndex = 0; recordIndex < cell.features.length; recordIndex++) {
    const record = cell.features[recordIndex];
    let geometry: GeoJSON.Geometry | null = null;
    if (record.geometry.kind === 'point') {
      const point = cell.points2d[record.geometry.index];
      if (point) geometry = { type: 'Point', coordinates: cm93GridPointToWgs84(cell.metadata, point[0], point[1]) };
    } else if (record.geometry.kind === 'point3d') {
      const pointRecord = cell.points3d[record.geometry.index];
      if (pointRecord?.points.length) {
        geometry = {
          type: 'MultiPoint',
          coordinates: pointRecord.points.map(([x, y]) => cm93GridPointToWgs84(cell.metadata, x, y)),
        };
      }
    } else if (record.geometry.kind === 'line') {
      const paths = assembleCm93VectorPaths(cell.vectors, record.geometry.vectors)
        .filter((path) => path.length >= 2);
      if (paths.length === 1) {
        geometry = { type: 'LineString', coordinates: toCoordinates(paths[0]) };
      } else if (paths.length > 1) {
        geometry = { type: 'MultiLineString', coordinates: paths.map(toCoordinates) };
      }
    } else if (record.geometry.kind === 'area') {
      // Only closed rings are safe to fill. Open or disconnected fragments are
      // omitted instead of being implicitly closed into misleading polygons.
      const rings = assembleCm93VectorPaths(cell.vectors, record.geometry.vectors);
      const polygons = cm93RingsToPolygonCoordinates(rings).map((polygon) => polygon.map(toCoordinates));
      if (polygons.length === 1) {
        geometry = { type: 'Polygon', coordinates: polygons[0] };
      } else if (polygons.length > 1) {
        geometry = { type: 'MultiPolygon', coordinates: polygons };
      }
    }

    if (!geometry) {
      omittedGeometryCount++;
      continue;
    }

    const classDefinition = dictionary.objectsByCode.get(record.objectCode);
    const properties: Record<string, string | number | boolean | null | number[]> = {
      cm93ObjectCode: record.objectCode,
      cm93Class: classDefinition?.name ?? `UNKNOWN_${record.objectCode}`,
      cm93GeometryType: record.geometryType,
      cm93RecordIndex: recordIndex,
      cm93RelatedObjectIndexes: record.relatedObjectIndexes,
      cm93RelatedChild: false,
    };
    try {
      for (const attribute of decodeCm93FeatureAttributes(record.rawAttributes, record.attributeCount, dictionary)) {
        if (attribute.supported && attribute.name) properties[attribute.name] = attribute.value;
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'A CM93 attribute block could not be decoded.');
    }
    features.push({ type: 'Feature', id: features.length, geometry, properties });
  }

  // Related-object pointers can split one navigational mark and its attributes
  // across several records. Correlate only explicitly linked point records whose
  // positions agree; proximity alone is never enough to merge chart objects.
  const featureByRecord = new Map<number, GeoJSON.Feature>();
  for (const feature of features) {
    const index = Number(feature.properties?.cm93RecordIndex);
    if (Number.isInteger(index)) featureByRecord.set(index, feature);
  }
  const parent = new Map<number, number>();
  const rootOf = (index: number): number => {
    const current = parent.get(index);
    if (current === undefined) { parent.set(index, index); return index; }
    if (current === index) return index;
    const root = rootOf(current);
    parent.set(index, root);
    return root;
  };
  const join = (left: number, right: number) => {
    const leftRoot = rootOf(left);
    const rightRoot = rootOf(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const samePoint = (left: GeoJSON.Feature, right: GeoJSON.Feature): boolean => {
    if (left.geometry.type !== 'Point' || right.geometry.type !== 'Point') return false;
    const a = left.geometry.coordinates;
    const b = right.geometry.coordinates;
    return Math.abs(a[0] - b[0]) <= 0.0003 && Math.abs(a[1] - b[1]) <= 0.0003;
  };
  for (const [recordIndex, feature] of featureByRecord) {
    const record = cell.features[recordIndex];
    for (const relatedIndex of record.relatedObjectIndexes) {
      const relatedFeature = featureByRecord.get(relatedIndex);
      if (relatedFeature && samePoint(feature, relatedFeature)) join(recordIndex, relatedIndex);
    }
  }
  const groups = new Map<number, GeoJSON.Feature[]>();
  for (const [recordIndex, feature] of featureByRecord) {
    const root = rootOf(recordIndex);
    const group = groups.get(root) ?? [];
    group.push(feature);
    groups.set(root, group);
  }
  const classPriority = (feature: GeoJSON.Feature): number => {
    const name = String(feature.properties?.cm93Class ?? '');
    if (name.startsWith('BOY')) return 4;
    if (name.startsWith('BCN')) return 3;
    if (name === 'LIGHTS') return 2;
    return 1;
  };
  const detailAttributes = ['SIGPER', 'SIGGRP', 'HEIGHT', 'VALNMR', 'COLOUR', 'CATLIT'];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((left, right) => classPriority(right) - classPriority(left));
    const primary = group[0];
    const properties = primary.properties ?? {};
    for (const related of group.slice(1)) {
      for (const [name, value] of Object.entries(related.properties ?? {})) {
        if (name.startsWith('cm93') || value === null || value === undefined || value === '') continue;
        if (properties[name] === undefined || properties[name] === null || properties[name] === '') properties[name] = value;
      }
      if (related.properties) related.properties.cm93RelatedChild = true;
    }
    const labelParts: string[] = [];
    const objectName = properties.OBJNAM;
    if (typeof objectName === 'string' && objectName.trim()) labelParts.push(objectName.trim());
    for (const attributeName of detailAttributes) {
      const value = properties[attributeName];
      if (value === undefined || value === null || value === '') continue;
      const displayName: Record<string, string> = { SIGPER: 'period', SIGGRP: 'group', HEIGHT: 'height', VALNMR: 'range', COLOUR: 'colour', CATLIT: 'light' };
      const suffix = attributeName === 'SIGPER' ? 's' : attributeName === 'HEIGHT' ? 'm' : '';
      labelParts.push(displayName[attributeName] + ' ' + String(value) + suffix);
    }
    if (labelParts.length) properties.cm93DetailLabel = labelParts.join(' · ');
    properties.cm93RelatedCount = group.length - 1;
    primary.properties = properties;
  }

  return {
    geojson: { type: 'FeatureCollection', features },
    omittedGeometryCount,
    warnings: [...new Set(warnings)],
  };
}
