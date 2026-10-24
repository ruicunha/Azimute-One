import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
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
  // Stub clipboard I/O inside this isolated browser context. This makes the
  // diagnostics capture deterministic in headless CI without relying on OS
  // clipboard permissions; it does not modify the deployed application.
  await context.addInitScript(() => {
    let clipboardText = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          clipboardText = text;
          window.__azimuteClipboardText = text;
          window.dispatchEvent(new CustomEvent('azimute-diagnostics-copied'));
        },
        readText: async () => clipboardText,
      },
    });
  });
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
  await page.getByText(/^Rendered [0-9,]+ features from [0-9,]+\/[0-9,]+ CM93 [A-Z]-scale cells\./).waitFor({ timeout: 600000 });
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
  await page.getByText(/^Rendered [0-9,]+ features from [0-9,]+\/[0-9,]+ CM93 [A-Z]-scale cells\./).waitFor({ timeout: 600000 });
  const indexedDbHit = page.getByText(/INDEXEDDB HIT — reused persistent processed geometry/);
  await indexedDbHit.waitFor({ timeout: 180000 });
  result.checks.indexedDbCacheHitAfterReload = true;
  result.secondRunPerformanceDiagnosticsText = await page.locator('body').innerText();
  result.secondRunCacheDiagnostics = result.secondRunPerformanceDiagnosticsText
    .split(/\r?\n/)
    .filter((line) => /Persistent quilt cache:|Cache stages \(ms\):|Last update timings:|Cache hits \/ misses:/.test(line));
  await page.screenshot({ path: path.join(outputDir, 'persistent-cache-hit.png'), fullPage: true });

  // Capture a structured report for the persistent-cache reload itself. The
  // body-text summary above is useful for humans, but the JSON timings let us
  // compare compression/decompression cost across cache-format experiments.
  await page.evaluate(() => { window.__azimuteClipboardText = ''; });
  await page.getByRole('button', { name: 'Copy performance diagnostics (JSON)' }).click();
  await page.waitForFunction(() => typeof window.__azimuteClipboardText === 'string' && window.__azimuteClipboardText.length > 0, { timeout: 15000 });
  result.persistentCacheReloadDiagnostics = JSON.parse(await page.evaluate(() => window.__azimuteClipboardText));
  await fs.writeFile(
    path.join(outputDir, 'persistent-cache-reload.json'),
    JSON.stringify(result.persistentCacheReloadDiagnostics, null, 2),
  );

  // Benchmark real zoom transitions on the deployed map. Capture the structured
  // diagnostics from the app clipboard so every sample includes viewport zoom,
  // cell mix, cache source, worker/geometry stages and MapLibre lifecycle timings.
  const diagnosticsButton = page.getByRole('button', { name: 'Copy performance diagnostics (JSON)' });
  const captureDiagnostics = async (label) => {
    await page.evaluate(() => { window.__azimuteClipboardText = ''; });
    await diagnosticsButton.click();
    // The app's visible status message is transient and may be outside the
    // viewport/hidden in CI. Wait for the actual clipboard payload instead.
    await page.waitForFunction(() => typeof window.__azimuteClipboardText === 'string' && window.__azimuteClipboardText.length > 0, { timeout: 15000 });
    const report = JSON.parse(await page.evaluate(() => window.__azimuteClipboardText));
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
  result.zoomTransitions = [];
  result.zoomTransitions.push(await captureDiagnostics('overview-before-zoom'));
  const overviewZoom = result.zoomTransitions[0].viewport?.zoom;

  // The overview can be centered over open ocean, where labels and depth
  // contours correctly have no pixels to render. Pan to Boston, a chart-rich
  // location in the bundled CM93 sample, before measuring portrayal layers.
  // MapLibre's Web Mercator world-pixel transform lets the test move the map
  // through real pointer input without reaching into application internals.
  const hoverMap = async () => {
    await mapCanvas.hover({ position: { x: canvasBounds.width / 2, y: canvasBounds.height / 2 } });
  };
  const wheelZoom = async (deltaY, count) => {
    await hoverMap();
    for (let i = 0; i < count; i += 1) {
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1500);
  };
  const mercatorY = (latitude) => {
    const radians = latitude * Math.PI / 180;
    return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
  };
  const currentCenter = result.zoomTransitions[0].viewport?.center;
  if (!currentCenter || typeof overviewZoom !== 'number') {
    throw new Error('Overview diagnostics did not include the map center and zoom needed for chart-rich navigation.');
  }
  const target = { longitude: -71.06, latitude: 42.36 };
  const worldPixels = 512 * (2 ** overviewZoom);
  let longitudeDelta = target.longitude - currentCenter.longitude;
  if (longitudeDelta > 180) longitudeDelta -= 360;
  if (longitudeDelta < -180) longitudeDelta += 360;
  const dragX = -longitudeDelta / 360 * worldPixels;
  const dragY = (mercatorY(currentCenter.latitude) - mercatorY(target.latitude)) * worldPixels;
  const dragStart = { x: canvasBounds.x + canvasBounds.width / 2, y: canvasBounds.y + canvasBounds.height / 2 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + dragX, dragStart.y + dragY, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1000);
  const chartArea = await captureDiagnostics('chart-area-before-zoom');
  const chartCenter = chartArea.viewport?.center;
  if (!chartCenter || Math.abs(chartCenter.longitude - target.longitude) > 3 || Math.abs(chartCenter.latitude - target.latitude) > 3) {
    throw new Error(`Could not center chart-rich viewport near Boston: expected ${target.latitude},${target.longitude}; got ${chartCenter?.latitude},${chartCenter?.longitude}.`);
  }
  result.chartRichViewport = { target, actualCenter: chartCenter, overviewZoom };

  // Labels and depth contours have higher minimum zooms, so make the benchmark
  // a genuine close-up rather than assuming 18 wheel events are sufficient.
  await wheelZoom(-180, 50);
  const closeupFirst = await captureDiagnostics('closeup-first-pass');
  if ((closeupFirst.viewport?.zoom ?? overviewZoom) < 10.5) {
    throw new Error(`Chart-rich benchmark did not reach portrayal detail scale: overview ${overviewZoom}, close-up ${closeupFirst.viewport?.zoom}.`);
  }
  result.zoomTransitions.push(closeupFirst);

  // Return to the original overview, capture it to prove that the map really
  // moved, then revisit the exact same close-up viewport. This tests cache
  // reuse instead of merely copying the last successful report twice.
  await wheelZoom(180, 50);
  const overviewRepeat = await captureDiagnostics('overview-before-repeat');
  if (Math.abs((overviewRepeat.viewport?.zoom ?? Number.NaN) - overviewZoom) > 0.35) {
    throw new Error(`Zoom-transition benchmark did not return to overview: expected ${overviewZoom}, got ${overviewRepeat.viewport?.zoom}.`);
  }
  result.zoomTransitions.push(overviewRepeat);
  await wheelZoom(-180, 50);
  const closeupRepeat = await captureDiagnostics('closeup-repeat-pass');
  if (Math.abs((closeupRepeat.viewport?.zoom ?? Number.NaN) - (closeupFirst.viewport?.zoom ?? Number.NaN)) > 0.35) {
    throw new Error(`Repeated close-up viewport differs from first pass: ${closeupFirst.viewport?.zoom} vs ${closeupRepeat.viewport?.zoom}.`);
  }
  if (closeupFirst.capturedAt && closeupFirst.capturedAt === closeupRepeat.capturedAt) {
    throw new Error('Repeated close-up returned the same capture timestamp; the test may be reading a stale diagnostics payload.');
  }
  if (closeupRepeat.performance?.quiltCacheHit !== true) {
    throw new Error(`Repeated close-up did not reuse the processed quilt (cache source: ${closeupRepeat.performance?.quiltCacheSource ?? 'unknown'}).`);
  }
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

  // Capture a real map-click report at the close-up viewport. This report
  // identifies the clicked coordinates and the CM93 cells/coverage selected
  // there, which helps distinguish sparse chart data from a rendering defect.
  await hoverMap();
  await page.mouse.click(mapPoint.x, mapPoint.y);
  await page.getByText('Last click report ready. Click another point to replace it with fresh diagnostics.', { exact: true }).waitFor({ timeout: 30000 });
  await page.evaluate(() => { window.__azimuteClipboardText = ''; });
  await page.getByRole('button', { name: 'Copy last map-click debug', exact: true }).click();
  await page.waitForFunction(() => typeof window.__azimuteClipboardText === 'string' && window.__azimuteClipboardText.length > 0, { timeout: 15000 });
  result.mapClickDiagnostics = JSON.parse(await page.evaluate(() => window.__azimuteClipboardText));
  if (result.mapClickDiagnostics?.reportType !== 'Azimute One CM93 map-click diagnostic') {
    throw new Error('Map click did not produce the expected structured CM93 diagnostic report.');
  }
  result.checks.mapClickDiagnosticsAvailable = true;
  await fs.writeFile(path.join(outputDir, 'closeup-map-click.json'), JSON.stringify(result.mapClickDiagnostics, null, 2));

  // Layer-isolation smoke experiment. Wait for the map canvas image to remain
  // identical across three consecutive captures before/after each toggle. This
  // avoids the old fixed 500 ms delay, which could capture either too early or
  // unnecessarily late. Screenshot polling adds overhead, so this remains a
  // canvas-stability responsiveness metric, not a pure MapLibre/GPU render time.
  result.layerIsolation = [];
  const layerCases = [
    { label: 'Area fills', file: 'layer-test-no-fills.png' },
    { label: 'Lines (coastlines, contours, structures)', file: 'layer-test-no-lines.png' },
    { label: 'Navigational symbols', file: 'layer-test-no-symbols.png' },
    { label: 'Feature labels', file: 'layer-test-no-feature-labels.png' },
    { label: 'Depth contour labels', file: 'layer-test-no-depth-labels.png' },
  ];
  const canvasHash = async () => createHash('sha256').update(await mapCanvas.screenshot()).digest('hex');
  const waitForStableCanvas = async (timeoutMs = 10000) => {
    const startedAt = Date.now();
    let previousHash = null;
    let stableSamples = 0;
    let samples = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const currentHash = await canvasHash();
      samples += 1;
      stableSamples = currentHash === previousHash ? stableSamples + 1 : 1;
      if (stableSamples >= 3) {
        return { hash: currentHash, stableMs: Date.now() - startedAt, samples };
      }
      previousHash = currentHash;
      await page.waitForTimeout(100);
    }
    throw new Error(`Map canvas did not stabilize within ${timeoutMs} ms after a portrayal-layer change.`);
  };
  for (const layerCase of layerCases) {
    const checkbox = page.getByRole('checkbox', { name: layerCase.label, exact: true });
    const before = await checkbox.isChecked();
    const stableBefore = await waitForStableCanvas();
    const startedAt = Date.now();
    await checkbox.setChecked(!before);
    const stableAfter = await waitForStableCanvas();
    const toggleToStableCanvasMs = Date.now() - startedAt;
    await page.screenshot({ path: path.join(outputDir, layerCase.file), fullPage: false });
    // Record the app's structured diagnostics while the category is hidden.
    // These source-update timings are not used as the toggle duration.
    await page.evaluate(() => { window.__azimuteClipboardText = ''; });
    await diagnosticsButton.click();
    await page.waitForFunction(() => typeof window.__azimuteClipboardText === 'string' && window.__azimuteClipboardText.length > 0, { timeout: 15000 });
    const hiddenLayerDiagnostics = JSON.parse(await page.evaluate(() => window.__azimuteClipboardText));
    const visibilityKey = ({
      'Area fills': 'fills',
      'Lines (coastlines, contours, structures)': 'lines',
      'Navigational symbols': 'symbols',
      'Feature labels': 'labels',
      'Depth contour labels': 'depthLabels',
    })[layerCase.label];
    if (hiddenLayerDiagnostics.performance?.renderLayerVisibility?.[visibilityKey] !== !before) {
      throw new Error(`Layer isolation state mismatch for ${layerCase.label}: expected ${visibilityKey}=${!before}.`);
    }
    await fs.writeFile(path.join(outputDir, `layer-diagnostics-${visibilityKey}.json`), JSON.stringify(hiddenLayerDiagnostics, null, 2));
    result.layerIsolation.push({
      layer: layerCase.label,
      visibilityKey,
      toggledOff: before,
      renderLayerVisibility: hiddenLayerDiagnostics.performance.renderLayerVisibility,
      canvasChanged: stableBefore.hash !== stableAfter.hash,
      canvasHashBefore: stableBefore.hash,
      canvasHashAfter: stableAfter.hash,
      toggleToStableCanvasMs,
      stableCanvasSamplesBefore: stableBefore.samples,
      stableCanvasSamplesAfter: stableAfter.samples,
      note: 'Canvas stability is measured by three consecutive identical canvas screenshots. Duration includes screenshot polling overhead and is not a pure MapLibre/GPU render time; canvasChanged=false means the current viewport showed no pixel change for this toggle.',
    });
    await checkbox.setChecked(before);
    await waitForStableCanvas();
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
