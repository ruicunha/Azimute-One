/**
 * Viewport-aware CM93 V2 cell selection for the experimental chart quilt.
 *
 * The viewport prefers the requested scale. For the one-degree E/F/G grids,
 * a missing target cell may use the next available finer cell in that same
 * footprint. This avoids blank tiles without layering unrelated coarser
 * chart polygons over finer data. Coarser fallback remains viewport-wide
 * because those cells span multiple fine-grid footprints and require M_COVR
 * coverage geometry before they can be safely mixed.
 */
export type Cm93CellFile = {
  name: string;
  webkitRelativePath?: string;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export type Cm93ViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export const CM93_SCALE_ORDER = ['Z', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type Cm93ScaleCode = typeof CM93_SCALE_ORDER[number];

export const CM93_SCALE_STEPS: Record<Cm93ScaleCode, number> = {
  Z: 120,
  A: 60,
  B: 30,
  C: 12,
  D: 3,
  E: 1,
  F: 1,
  G: 1,
};

/** Delay finer-scale transitions until the map is sufficiently zoomed in. */
export function cm93ScaleForZoom(zoom: number): Cm93ScaleCode {
  if (zoom < 3.5) return 'Z';
  if (zoom < 4.5) return 'A';
  if (zoom < 5.5) return 'B';
  if (zoom < 7.5) return 'C';
  if (zoom < 9.5) return 'D';
  if (zoom < 11.5) return 'E';
  if (zoom < 13.5) return 'F';
  return 'G';
}

function normalizedLongitude(longitude: number): number {
  return ((longitude % 360) + 360) % 360;
}

function pathForCell(latitudeCell: number, longitudeCell: number, scale: string): string {
  const cellLatitude = latitudeCell + 30;
  const rootLatitude = Math.floor((cellLatitude - 30) / 60) * 60 + 30;
  const rootLongitude = Math.floor(longitudeCell / 60) * 60;
  const root = String(rootLatitude).padStart(4, '0') + String(rootLongitude).padStart(4, '0');
  const filename = String(cellLatitude).padStart(4, '0') + String(longitudeCell).padStart(4, '0') + '.' + scale.toLowerCase();
  return '/' + root.toLowerCase() + '/' + scale.toLowerCase() + '/' + filename;
}

export type Cm93ViewportSelection = {
  /** Scale requested by the current zoom; per-cell fine fallback may be present. */
  scale: Cm93ScaleCode;
  /** Primary cells selected at the requested scale, or coarser fallback scale. */
  files: Cm93CellFile[];
  /** Coarser and finer fallback cells used only for area fills, never points or lines. */
  fillFallbackFiles: Cm93CellFile[];
  scaleCounts: Partial<Record<Cm93ScaleCode, number>>;
};

export function selectCm93ViewportCells(
  files: Cm93CellFile[],
  bounds: Cm93ViewportBounds,
  zoom: number,
  maxCells = 1200,
): Cm93ViewportSelection {
  const targetScale = cm93ScaleForZoom(zoom);
  const targetIndex = CM93_SCALE_ORDER.indexOf(targetScale);
  const byPath = new Map<string, Cm93CellFile>();
  for (const file of files) {
    const pathParts = (file.webkitRelativePath || file.name).toLowerCase().split('/');
    byPath.set('/' + pathParts.slice(-3).join('/'), file);
  }

  const south = Math.max(-79.5, Math.min(bounds.south, bounds.north));
  const north = Math.min(80, Math.max(bounds.south, bounds.north));
  const west = Math.min(bounds.west, bounds.east);
  const east = Math.max(bounds.west, bounds.east);
  const longitudeSpan = Math.min(360, Math.max(0, east - west));

  for (let scaleIndex = targetIndex; scaleIndex >= 0; scaleIndex--) {
    const scale = CM93_SCALE_ORDER[scaleIndex];
    const step = CM93_SCALE_STEPS[scale];
    const firstLatitudeCell = Math.floor((south * 3 + 240) / step) * step;
    const lastLatitudeCell = Math.floor((north * 3 + 240) / step) * step;
    const firstLongitudeCell = Math.floor((normalizedLongitude(west) * 3) / step) * step;
    const lastLongitudeCell = Math.floor((normalizedLongitude(west) * 3 + longitudeSpan * 3) / step) * step;
    const selected = new Map<string, Cm93CellFile>();

    for (let latitudeCell = firstLatitudeCell; latitudeCell <= lastLatitudeCell; latitudeCell += step) {
      for (let longitudeCellUnwrapped = firstLongitudeCell; longitudeCellUnwrapped <= lastLongitudeCell; longitudeCellUnwrapped += step) {
        const longitudeCell = ((longitudeCellUnwrapped % 1080) + 1080) % 1080;
        let found = byPath.get(pathForCell(latitudeCell, longitudeCell, scale));

        // E/F/G use the same one-degree filename grid. If the requested tile
        // is absent, use the next available finer tile in exactly that
        // footprint, rather than concluding that other E tiles cover the gap.
        if (!found && scale === targetScale && (targetScale === 'E' || targetScale === 'F')) {
          const firstFineIndex = targetIndex + 1;
          for (let fineIndex = firstFineIndex; fineIndex < CM93_SCALE_ORDER.length; fineIndex++) {
            const finerScale = CM93_SCALE_ORDER[fineIndex];
            found = byPath.get(pathForCell(latitudeCell, longitudeCell, finerScale));
            if (found) break;
          }
        }

        if (found) {
          const key = (found.webkitRelativePath || found.name).toLowerCase();
          if (!selected.has(key)) selected.set(key, found);
        }
        if (selected.size >= maxCells) break;
      }
      if (selected.size >= maxCells) break;
    }

    if (selected.size > 0) {
      const scaleCounts: Partial<Record<Cm93ScaleCode, number>> = {};
      for (const file of selected.values()) {
        const actualScale = (file.webkitRelativePath || file.name).split('.').pop()?.toUpperCase() as Cm93ScaleCode;
        scaleCounts[actualScale] = (scaleCounts[actualScale] ?? 0) + 1;
      }

      // A detailed CM93 cell can exist without an area polygon at a given
      // position. Keep available coarser cells as fill-only underlays so the
      // detailed chart is not allowed to turn missing coverage into blank water.
      // App paints fills coarse-to-fine, and these cells never contribute points
      // or lines, so the underlay is visible only where finer polygons are absent.
      const fillFallbackFiles = new Map<string, Cm93CellFile>();
      const coarseSouth = Math.max(-79.5, Math.min(bounds.south, bounds.north));
      const coarseNorth = Math.min(80, Math.max(bounds.south, bounds.north));
      const coarseWest = Math.min(bounds.west, bounds.east);
      const coarseEast = Math.max(bounds.west, bounds.east);
      const coarseLongitudeSpan = Math.min(360, Math.max(0, coarseEast - coarseWest));
      for (let coarseIndex = targetIndex - 1; coarseIndex >= 0; coarseIndex--) {
        const coarseScale = CM93_SCALE_ORDER[coarseIndex];
        const coarseStep = CM93_SCALE_STEPS[coarseScale];
        const firstCoarseLatitudeCell = Math.floor((coarseSouth * 3 + 240) / coarseStep) * coarseStep;
        const lastCoarseLatitudeCell = Math.floor((coarseNorth * 3 + 240) / coarseStep) * coarseStep;
        const firstCoarseLongitudeCell = Math.floor((normalizedLongitude(coarseWest) * 3) / coarseStep) * coarseStep;
        const lastCoarseLongitudeCell = Math.floor((normalizedLongitude(coarseWest) * 3 + coarseLongitudeSpan * 3) / coarseStep) * coarseStep;

        for (let latitudeCell = firstCoarseLatitudeCell; latitudeCell <= lastCoarseLatitudeCell; latitudeCell += coarseStep) {
          for (let longitudeCellUnwrapped = firstCoarseLongitudeCell; longitudeCellUnwrapped <= lastCoarseLongitudeCell; longitudeCellUnwrapped += coarseStep) {
            const longitudeCell = ((longitudeCellUnwrapped % 1080) + 1080) % 1080;
            const found = byPath.get(pathForCell(latitudeCell, longitudeCell, coarseScale));
            if (!found) continue;
            const key = (found.webkitRelativePath || found.name).toLowerCase();
            if (!selected.has(key)) fillFallbackFiles.set(key, found);
            if (selected.size + fillFallbackFiles.size >= maxCells) break;
          }
          if (selected.size + fillFallbackFiles.size >= maxCells) break;
        }
        if (selected.size + fillFallbackFiles.size >= maxCells) break;
      }

      // Finer-grid cells may also contain useful area polygons where the
      // requested-scale cell is missing. Keep those as fill-only supplements too.
      if (targetIndex >= CM93_SCALE_ORDER.indexOf('D') && targetScale !== 'G') {
        const fineScales = CM93_SCALE_ORDER.slice(Math.max(targetIndex + 1, CM93_SCALE_ORDER.indexOf('E'))).reverse();
        const fineSouth = Math.max(-79.5, Math.min(bounds.south, bounds.north));
        const fineNorth = Math.min(80, Math.max(bounds.south, bounds.north));
        const fineWest = Math.min(bounds.west, bounds.east);
        const fineEast = Math.max(bounds.west, bounds.east);
        const fineLongitudeSpan = Math.min(360, Math.max(0, fineEast - fineWest));
        const firstFineLatitudeCell = Math.floor(fineSouth * 3 + 240);
        const lastFineLatitudeCell = Math.floor(fineNorth * 3 + 240);
        const firstFineLongitudeCell = Math.floor(normalizedLongitude(fineWest) * 3);
        const lastFineLongitudeCell = Math.floor(normalizedLongitude(fineWest) * 3 + fineLongitudeSpan * 3);

        for (let latitudeCell = firstFineLatitudeCell; latitudeCell <= lastFineLatitudeCell; latitudeCell++) {
          for (let longitudeCellUnwrapped = firstFineLongitudeCell; longitudeCellUnwrapped <= lastFineLongitudeCell; longitudeCellUnwrapped++) {
            const longitudeCell = ((longitudeCellUnwrapped % 1080) + 1080) % 1080;
            for (const fineScale of fineScales) {
              const found = byPath.get(pathForCell(latitudeCell, longitudeCell, fineScale));
              if (!found) continue;
              const key = (found.webkitRelativePath || found.name).toLowerCase();
              if (!selected.has(key)) fillFallbackFiles.set(key, found);
              break;
            }
            if (selected.size + fillFallbackFiles.size >= maxCells) break;
          }
          if (selected.size + fillFallbackFiles.size >= maxCells) break;
        }
      }
      return { scale: targetScale, files: [...selected.values()], fillFallbackFiles: [...fillFallbackFiles.values()], scaleCounts };
    }
  }

  return { scale: targetScale, files: [], fillFallbackFiles: [], scaleCounts: {} };
}

/** Do not retain features from previous viewports or zoom levels. */
export function buildCm93QuiltFeatures(
  currentFeatures: GeoJSON.Feature[],
): GeoJSON.Feature[] {
  return currentFeatures;
}
