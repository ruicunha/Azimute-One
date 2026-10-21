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

/**
 * Safe boundary for raw cell input until the independent record framing and
 * substitution permutation are verified. A CM93 file is not S-57 and must
 * never be passed to the S-57 parser.
 */
export function decodeCm93Cell(_bytes: Uint8Array, filename: string): never {
  const extension = filename.split('.').pop()?.toUpperCase();
  if (!extension || !/^[A-GZ]$/.test(extension)) {
    throw new Cm93DecodeError('Select a CM93 V2 cell file with an A–G or Z scale extension.');
  }
  throw new Cm93DecodeError(
    'CM93 V2 cell framing and its byte-substitution mapping are not yet independently verified. The file was not decoded. The current milestone includes dictionary parsing and checked binary/coordinate primitives; no chart features are emitted until a verified decoder can be tested against this dataset.',
  );
}
