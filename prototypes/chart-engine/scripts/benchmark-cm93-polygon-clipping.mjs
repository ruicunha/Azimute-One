import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { unzipSync } from 'fflate';
import polygonClipping from 'polygon-clipping';
import martinez from 'martinez-polygon-clipping';
import {
  cm93CellToGeoJSON,
  parseCm93Cell,
  parseCm93Dictionaries,
} from '../src/cm93-decoder.ts';
import { selectCm93ViewportCells } from '../src/cm93-quilt.ts';
import { buildCm93CoverageQuiltFeatures } from '../src/cm93-quilt-geometry.ts';

const datasetPath = process.env.CM93_ZIP ?? '.benchmark/cm93_200705_Small.zip';
const outputPath = process.env.CM93_BENCHMARK_OUTPUT ?? '.benchmark/polygon-clipping-benchmark.json';
const viewport = {
  west: -9.304332,
  south: 38.657623,
  east: -9.290277,
  north: 38.662717,
};
const zoom = 16.254;
const repetitions = 3;

const zipBytes = new Uint8Array(await readFile(datasetPath));
const entries = unzipSync(zipBytes);
const normalizedEntries = Object.entries(entries).map(([path, bytes]) => ({
  path: path.replace(/\\/g, '/'),
  lowerPath: path.replace(/\\/g, '/').toLowerCase(),
  bytes,
}));
const findDictionary = (name) => {
  const entry = normalizedEntries.find((item) => item.lowerPath.endsWith('/' + name.toLowerCase()) || item.lowerPath === name.toLowerCase());
  if (!entry) throw new Error(`Dataset is missing ${name}`);
  return new TextDecoder().decode(entry.bytes);
};
const dictionary = parseCm93Dictionaries(findDictionary('CM93OBJ.DIC'), findDictionary('CM93ATTR.DIC'));
const cellFiles = normalizedEntries
  .filter(({ lowerPath }) => /\.[a-gz]$/i.test(lowerPath) && /\/([a-gz])\/[^/]+\.[a-gz]$/i.test(lowerPath))
  .map(({ path, bytes }) => ({
    name: basename(path),
    webkitRelativePath: path,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }));

if (!cellFiles.length) throw new Error('No CM93 cell files found in the sample archive.');
const selection = selectCm93ViewportCells(cellFiles, viewport, zoom, 1200);
if (!selection.files.length) throw new Error('No CM93 cells selected for the configured viewport.');

const decodedFeatures = [];
const failedCells = [];
for (const file of selection.files) {
  try {
    const cell = parseCm93Cell(new Uint8Array(await file.arrayBuffer()), file.name);
    const scale = (file.webkitRelativePath || file.name).split('.').pop()?.toUpperCase() ?? 'A';
    decodedFeatures.push(...cm93CellToGeoJSON(cell, dictionary).geojson.features.map((feature) => ({
      ...feature,
      properties: { ...(feature.properties ?? {}), cm93Scale: scale },
    })));
  } catch (error) {
    failedCells.push({ file: file.name, error: String(error) });
  }
}
if (!decodedFeatures.length) throw new Error('Selected CM93 cells decoded to zero features.');

const quilt = buildCm93CoverageQuiltFeatures(decodedFeatures, selection.scale);
const coverageByScale = quilt.coverageByScale;

function geometryBounds(geometry) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let found = false;
  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      bounds.minX = Math.min(bounds.minX, value[0]);
      bounds.minY = Math.min(bounds.minY, value[1]);
      bounds.maxX = Math.max(bounds.maxX, value[0]);
      bounds.maxY = Math.max(bounds.maxY, value[1]);
      found = true;
      return;
    }
    for (const child of value) visit(child);
  };
  visit(geometry.coordinates);
  return found ? bounds : null;
}
function overlaps(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
function polygonCoordinates(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return null;
}
function areaOfMultiPolygon(multiPolygon) {
  const ringArea = (ring) => {
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area / 2);
  };
  return multiPolygon.reduce((sum, polygon) => {
    if (!polygon.length) return sum;
    return sum + ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0);
  }, 0);
}
function symmetricDifferenceArea(a, b) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return areaOfMultiPolygon(b);
  if (!b.length) return areaOfMultiPolygon(a);
  const leftOnly = polygonClipping.difference(a, b);
  const rightOnly = polygonClipping.difference(b, a);
  return areaOfMultiPolygon(leftOnly) + areaOfMultiPolygon(rightOnly);
}
function candidateCoverageFor(feature, coverage) {
  const bounds = geometryBounds(feature.geometry);
  if (!bounds) return [];
  return coverage.filter((polygon) => {
    const polygonBounds = geometryBounds({ type: 'Polygon', coordinates: polygon });
    return polygonBounds && overlaps(bounds, polygonBounds);
  });
}
function clipWith(algorithm, subject, coverage) {
  if (!coverage.length) return [];
  try {
    return algorithm.intersection(subject, coverage) ?? [];
  } catch {
    return null;
  }
}

function isCoverageFeature(feature) {
  const name = String(feature.properties?.cm93Class ?? '').toUpperCase();
  return name === '_M_SOR' || name === 'M_COVR';
}

const polygonCases = decodedFeatures.flatMap((feature) => {
  // Match the production quilt: coverage records define the coverage mask;
  // they are not themselves clipped as chart features.
  if (isCoverageFeature(feature)) return [];
  if (!feature.geometry || !['Polygon', 'MultiPolygon'].includes(feature.geometry.type)) return [];
  const scale = String(feature.properties?.cm93Scale ?? '').toUpperCase();
  const coverage = coverageByScale[scale];
  if (!coverage?.length) return [];
  const subject = polygonCoordinates(feature.geometry);
  if (!subject) return [];
  const candidates = candidateCoverageFor(feature, coverage);
  if (!candidates.length) return [];
  return [{ feature, subject, candidates }];
});

if (!polygonCases.length) throw new Error('No polygon clipping cases were found in selected cells.');

function runBatch(algorithm, cases) {
  const started = performance.now();
  let empty = 0;
  let errors = 0;
  const outputs = [];
  for (const item of cases) {
    const result = clipWith(algorithm, item.subject, item.candidates);
    if (result === null) {
      errors++;
      outputs.push(null);
    } else {
      if (!result.length) empty++;
      outputs.push(result);
    }
  }
  return { elapsedMs: performance.now() - started, emptyResults: empty, errors, outputs };
}

// Warm both implementations once, then alternate execution order to reduce order bias.
runBatch(polygonClipping, polygonCases);
runBatch(martinez, polygonCases);
const currentRuns = [];
const alternativeRuns = [];
for (let i = 0; i < repetitions; i++) {
  const first = i % 2 === 0 ? 'current' : 'alternative';
  const current = first === 'current' ? runBatch(polygonClipping, polygonCases) : null;
  const alternative = first === 'alternative' ? runBatch(martinez, polygonCases) : null;
  if (current) currentRuns.push(current);
  if (alternative) alternativeRuns.push(alternative);
  if (!current) currentRuns.push(runBatch(polygonClipping, polygonCases));
  if (!alternative) alternativeRuns.push(runBatch(martinez, polygonCases));
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const currentMedian = median(currentRuns.map((run) => run.elapsedMs));
const alternativeMedian = median(alternativeRuns.map((run) => run.elapsedMs));

let compared = 0;
let mismatched = 0;
let comparisonErrors = 0;
let totalSymmetricDifferenceArea = 0;
let maxSymmetricDifferenceArea = 0;
const currentReference = runBatch(polygonClipping, polygonCases);
const alternativeReference = runBatch(martinez, polygonCases);
for (let i = 0; i < polygonCases.length; i++) {
  const a = currentReference.outputs[i];
  const b = alternativeReference.outputs[i];
  if (a === null || b === null) {
    comparisonErrors++;
    continue;
  }
  try {
    const difference = symmetricDifferenceArea(a, b);
    compared++;
    totalSymmetricDifferenceArea += difference;
    maxSymmetricDifferenceArea = Math.max(maxSymmetricDifferenceArea, difference);
    if (difference > 1e-12) mismatched++;
  } catch {
    comparisonErrors++;
  }
}

const report = {
  reportType: 'Azimute One CM93 polygon clipping library benchmark',
  generatedAt: new Date().toISOString(),
  dataset: { archive: basename(datasetPath), zipBytes: zipBytes.byteLength, archiveCellCount: cellFiles.length },
  viewport: { ...viewport, zoom, targetScale: selection.scale },
  selection: { selectedCellCount: selection.files.length, scaleCounts: selection.scaleCounts, decodedFeatureCount: decodedFeatures.length, failedCells },
  quilt: { outputFeatureCount: quilt.features.length, metrics: quilt.metrics, coverageComponentCount: Object.values(coverageByScale).reduce((sum, item) => sum + (item?.length ?? 0), 0) },
  benchmark: {
    polygonCaseCount: polygonCases.length,
    repetitions,
    current: { library: 'polygon-clipping', elapsedMs: currentRuns.map((run) => Number(run.elapsedMs.toFixed(3))), medianMs: Number(currentMedian.toFixed(3)), errors: currentReference.errors, emptyResults: currentReference.emptyResults },
    alternative: { library: 'martinez-polygon-clipping', elapsedMs: alternativeRuns.map((run) => Number(run.elapsedMs.toFixed(3))), medianMs: Number(alternativeMedian.toFixed(3)), errors: alternativeReference.errors, emptyResults: alternativeReference.emptyResults },
    speedup: Number((currentMedian / alternativeMedian).toFixed(3)),
    geometryComparison: {
      comparedFeatureCount: compared,
      mismatchedFeatureCount: mismatched,
      comparisonErrorCount: comparisonErrors,
      totalSymmetricDifferenceAreaDegreesSquared: totalSymmetricDifferenceArea,
      maxSymmetricDifferenceAreaDegreesSquared: maxSymmetricDifferenceArea,
      note: 'Symmetric-difference area is computed with polygon-clipping; small floating-point differences may occur. Review any nonzero mismatch before considering a library replacement.',
    },
  },
};
await writeFile(outputPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
