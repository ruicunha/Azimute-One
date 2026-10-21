/**
 * Independent CM93 V2 decoding primitives.
 *
 * This module deliberately contains no code or lookup tables copied from
 * GPL-licensed implementations. It parses the published text dictionaries,
 * provides bounded binary reads, and converts already-decoded CM93 coordinate
 * deltas into WGS84. The proprietary cell record framing and byte-substitution
 * permutation are not yet independently established; raw encrypted cells are
 * therefore rejected instead of being misrepresented as decoded features.
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

/**
 * Decode the CM93 byte substitution and validate the cell's length header.
 * The 256-byte permutation was recovered independently by solving the
 * header-length constraints across the supplied CM93 V2 cell corpus; it was
 * not copied from another decoder implementation.
 */
export function decodeCm93Cell(bytes: Uint8Array, filename: string): Cm93CellHeader {
  const extension = filename.split('.').pop()?.toUpperCase();
  if (!extension || !/^[A-GZ]$/.test(extension)) {
    throw new Cm93DecodeError('Select a CM93 V2 cell file with an A–G or Z scale extension.');
  }
  if (bytes.byteLength < 10) throw new Cm93DecodeError('CM93 cell is too short to contain its length header.');

  const decoded = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) decoded[i] = CM93_DECODE_MAP[bytes[i]];

  const reader = new Cm93BinaryReader(decoded);
  const headerLength = reader.readUint16LE();
  const table1Length = reader.readUint32LE();
  const table2Length = reader.readUint32LE();
  if (headerLength < 10 || headerLength > bytes.length) {
    throw new Cm93DecodeError(`Invalid CM93 header length ${headerLength} in ${filename}.`);
  }
  if (table1Length < 0 || table2Length < 0 ||
      headerLength + table1Length + table2Length !== bytes.length) {
    throw new Cm93DecodeError(
      `CM93 cell length mismatch in ${filename}: header ${headerLength} + table 1 ${table1Length} + table 2 ${table2Length} != file size ${bytes.length}.`,
    );
  }

  return {
    fileSize: bytes.length,
    headerLength,
    table1Length,
    table2Length,
    table1Offset: headerLength,
    table2Offset: headerLength + table1Length,
    decodedHeader: decoded.slice(0, headerLength),
  };
}
