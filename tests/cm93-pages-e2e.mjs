import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.AZIMUTE_PAGES_URL ?? 'https://ruicunha.github.io/Azimute-One/';
const datasetDir = process.env.CM93_DATASET_DIR;
const outputDir = path.resolve('artifacts/cm93-pages-e2e');
if (!datasetDir) throw new Error('CM93_DATASET_DIR is required.');

await fs.mkdir(outputDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
const consoleErrors = [];
const result = {
  url: baseUrl,
  startedAt: new Date().toISOString(),
  checks: {},
  pageErrors: errors,
  consoleErrors,
};

try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
  result.httpStatus = response?.status() ?? null;
  if (!response?.ok()) throw new Error(`Pages returned HTTP ${response?.status() ?? 'no response'}`);
  await page.getByText('Inspect CM93 V2 directory', { exact: true }).waitFor({ timeout: 60000 });
  await page.locator('input[webkitdirectory]').setInputFiles(datasetDir, { timeout: 120000 });
  await page.getByText('CM93 V2 structure recognized', { exact: true }).waitFor({ timeout: 180000 });
  result.checks.pagesLoads = true;
  result.checks.cm93DatasetRecognized = true;
  result.datasetInventory = await page.locator('.cm93-summary').innerText();
  await page.screenshot({ path: path.join(outputDir, 'dataset-recognized.png'), fullPage: true });

  await page.getByRole('button', { name: 'Render CM93 dataset overview' }).click();
  await page.getByText(/^Rendered [0-9,]+ features from [0-9,]+\/[0-9,]+ CM93 [A-Z]-scale cells\./, { timeout: 600000 }).waitFor();
  result.checks.cm93OverviewRendered = true;
  result.renderStatus = await page.locator('body').innerText();
  await page.screenshot({ path: path.join(outputDir, 'overview-rendered.png'), fullPage: true });

  // The overview fits the map to the dataset and enables automatic CM93 detail.
  // Wait for a viewport quilt update, which exercises the persistent cache worker.
  try {
    await page.getByRole('button', { name: 'Copy performance diagnostics (JSON)' }).waitFor({ timeout: 180000 });
    result.checks.quiltDiagnosticsAvailable = true;
    result.performanceDiagnosticsText = await page.locator('body').innerText();
  } catch {
    result.checks.quiltDiagnosticsAvailable = false;
    result.performanceDiagnosticsNote = 'Overview rendered, but no viewport quilt diagnostics appeared before the timeout.';
  }

  if (!result.checks.quiltDiagnosticsAvailable) {
    throw new Error('CM93 overview rendered but viewport quilt diagnostics were not produced; cache-path validation is incomplete.');
  }
  result.firstRunCacheDiagnostics = result.performanceDiagnosticsText
    .split(/\r?\n/)
    .filter((line) => /Persistent quilt cache:|Cache stages \(ms\):|Last update timings:|Cache hits \/ misses:/.test(line));

  // Reload without closing the browser context: IndexedDB must survive the
  // reload. Re-import the same directory so the selected cells and cache key
  // are identical, then verify the actual persistent-hit path is exercised.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByText('Inspect CM93 V2 directory', { exact: true }).waitFor({ timeout: 60000 });
  await page.locator('input[webkitdirectory]').setInputFiles(datasetDir, { timeout: 120000 });
  await page.getByText('CM93 V2 structure recognized', { exact: true }).waitFor({ timeout: 180000 });
  await page.getByRole('button', { name: 'Render CM93 dataset overview' }).click();
  await page.getByText(/^Rendered [0-9,]+ features from [0-9,]+\/[0-9,]+ CM93 [A-Z]-scale cells\./, { timeout: 600000 }).waitFor();
  const indexedDbHit = page.getByText(/INDEXEDDB HIT — reused persistent processed geometry/);
  await indexedDbHit.waitFor({ timeout: 180000 });
  result.checks.indexedDbCacheHitAfterReload = true;
  result.secondRunPerformanceDiagnosticsText = await page.locator('body').innerText();
  result.secondRunCacheDiagnostics = result.secondRunPerformanceDiagnosticsText
    .split(/\r?\n/)
    .filter((line) => /Persistent quilt cache:|Cache stages \(ms\):|Last update timings:|Cache hits \/ misses:/.test(line));
  await page.screenshot({ path: path.join(outputDir, 'persistent-cache-hit.png'), fullPage: true });

  // Benchmark real zoom transitions on the deployed map. Capture the structured
  // diagnostics from the app clipboard so every sample includes viewport zoom,
  // cell mix, cache source, worker/geometry stages and MapLibre lifecycle timings.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const diagnosticsButton = page.getByRole('button', { name: 'Copy performance diagnostics (JSON)' });
  const captureDiagnostics = async (label) => {
    await diagnosticsButton.click();
    await page.getByText('CM93 performance diagnostics copied.', { exact: true }).waitFor({ timeout: 10000 });
    const report = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    const sample = {
      label,
      capturedAt: report.capturedAt,
      viewport: report.viewport,
      performance: report.performance,
      cache: report.cache ? {
        hits: report.cache.hits,
        misses: report.cache.misses,
        entries: report.cache.entries,
        estimatedBytes: report.cache.estimatedBytes,
      } : null,
    };
    await fs.writeFile(path.join(outputDir, `zoom-${label}.json`), JSON.stringify(report, null, 2));
    return sample;
  };
  const mapCanvas = page.locator('.maplibregl-canvas').first();
  const canvasBounds = await mapCanvas.boundingBox();
  if (!canvasBounds) throw new Error('MapLibre canvas was not visible for zoom-transition benchmark.');
  const mapPoint = {
    x: canvasBounds.x + canvasBounds.width / 2,
    y: canvasBounds.y + canvasBounds.height / 2,
  };
  await page.mouse.move(mapPoint.x, mapPoint.y);
  result.zoomTransitions = [];
  result.zoomTransitions.push(await captureDiagnostics('overview-before-zoom'));
  const overviewZoom = result.zoomTransitions[0].viewport?.zoom;
  await page.mouse.wheel(0, -720);
  await page.waitForTimeout(2500);
  const closeupFirst = await captureDiagnostics('closeup-first-pass');
  if (closeupFirst.viewport?.zoom === overviewZoom) {
    throw new Error(`Zoom-transition benchmark did not change map zoom (still ${overviewZoom}).`);
  }
  result.zoomTransitions.push(closeupFirst);
  // Return to the same overview and repeat the same zoom gesture. This helps
  // distinguish cold viewport work from reuse of the same processed cell quilt.
  await page.mouse.wheel(0, 720);
  await page.waitForTimeout(1800);
  await page.mouse.wheel(0, -720);
  await page.waitForTimeout(2500);
  const closeupRepeat = await captureDiagnostics('closeup-repeat-pass');
  result.zoomTransitions.push(closeupRepeat);
  result.checks.zoomTransitionBenchmark = true;
  result.zoomTransitionComparison = {
    firstPass: {
      zoom: closeupFirst.viewport?.zoom,
      scaleAndCellMix: closeupFirst.performance?.targetScaleAndCellMix,
      viewportCellCount: closeupFirst.performance?.viewportCellCount,
      quiltCacheSource: closeupFirst.performance?.quiltCacheSource,
      quiltCacheHit: closeupFirst.performance?.quiltCacheHit,
      timingsMs: closeupFirst.performance?.timingsMs,
      cacheTimingsMs: closeupFirst.performance?.cacheTimingsMs,
    },
    repeatPass: {
      zoom: closeupRepeat.viewport?.zoom,
      scaleAndCellMix: closeupRepeat.performance?.targetScaleAndCellMix,
      viewportCellCount: closeupRepeat.performance?.viewportCellCount,
      quiltCacheSource: closeupRepeat.performance?.quiltCacheSource,
      quiltCacheHit: closeupRepeat.performance?.quiltCacheHit,
      timingsMs: closeupRepeat.performance?.timingsMs,
      cacheTimingsMs: closeupRepeat.performance?.cacheTimingsMs,
    },
    interpretation: 'Compare matching zoom and cell mixes. A cache hit reuses processed geometry, but GeoJSON preparation, source updates and MapLibre lifecycle/render work may still dominate. Timings are lifecycle proxies, not isolated GPU timings.',
  };
  await page.screenshot({ path: path.join(outputDir, 'zoom-transition-closeup.png'), fullPage: true });

  // Layer-isolation smoke experiment: keep the same loaded viewport and
  // toggle one portrayal category at a time. Record interaction-to-screenshot
  // wall time as a responsiveness proxy (not as a pure MapLibre/GPU metric).
  // The application exposes these controls specifically for portrayal testing.
  result.layerIsolation = [];
  const layerCases = [
    { label: 'Area fills', file: 'layer-test-no-fills.png' },
    { label: 'Lines (coastlines, contours, structures)', file: 'layer-test-no-lines.png' },
    { label: 'Navigational symbols', file: 'layer-test-no-symbols.png' },
    { label: 'Feature labels', file: 'layer-test-no-feature-labels.png' },
    { label: 'Depth contour labels', file: 'layer-test-no-depth-labels.png' },
  ];
  for (const layerCase of layerCases) {
    const checkbox = page.getByRole('checkbox', { name: layerCase.label, exact: true });
    const before = await checkbox.isChecked();
    const startedAt = Date.now();
    await checkbox.setChecked(!before);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outputDir, layerCase.file), fullPage: false });
    result.layerIsolation.push({
      layer: layerCase.label,
      toggledOff: before,
      interactionToScreenshotMs: Date.now() - startedAt,
      note: 'Responsiveness proxy only; not an isolated MapLibre/GPU render duration.',
    });
    await checkbox.setChecked(before);
    await page.waitForTimeout(250);
  }
  result.checks.layerVisibilityControlsRespond = result.layerIsolation.length === layerCases.length;

  if (errors.length) throw new Error(`Browser raised page errors: ${errors.join(' | ')}`);
  await page.screenshot({ path: path.join(outputDir, 'final-state.png'), fullPage: true });
} catch (error) {
  result.failure = error instanceof Error ? error.stack ?? error.message : String(error);
  try {
    const pages = browser.contexts().flatMap((context) => context.pages());
    if (pages[0]) await pages[0].screenshot({ path: path.join(outputDir, 'failure.png'), fullPage: true });
  } catch {}
  throw error;
} finally {
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
