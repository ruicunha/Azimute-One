/**
 * Viewport-aware CM93 V2 cell selection for the experimental chart quilt.
 *
 * The viewport selects the requested scale plus coarser candidates. A separate
 * coverage-aware quilt stage uses decoded M_COVR polygons to allocate each
 * geographic region to the most detailed available scale and clips features
 * to that region. Filename/grid membership alone never grants render coverage.
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
  /** Scale requested by the current zoom; coverage decides the visible scale per location. */
  scale: Cm93ScaleCode;
  /** Requested-scale and coarser candidate cells, ordered from detailed to coarse. */
  files: Cm93CellFile[];
  /** Kept empty for compatibility; fine-scale fallback is intentionally disabled. */
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
  if (byPath.size === 0) {
    return { scale: targetScale, files: [], fillFallbackFiles: [], scaleCounts: {} };
  }

  const south = Math.max(-79.5, Math.min(bounds.south, bounds.north));
  const north = Math.min(80, Math.max(bounds.south, bounds.north));
  const west = Math.min(bounds.west, bounds.east);
  const east = Math.max(bounds.west, bounds.east);
  const longitudeSpan = Math.min(360, Math.max(0, east - west));
  const selected = new Map<string, Cm93CellFile>();

  // Like OpenCPN's CM93 quilt, gather the requested scale and progressively
  // smaller-scale (coarser) candidates. Coverage geometry, not filename-grid
  // membership, decides which scale is actually visible at each location.
  // Never substitute a finer cell for a missing requested-scale cell.
  for (let scaleIndex = targetIndex; scaleIndex >= 0; scaleIndex--) {
    const scale = CM93_SCALE_ORDER[scaleIndex];
    const step = CM93_SCALE_STEPS[scale];
    const firstLatitudeCell = Math.floor((south * 3 + 240) / step) * step;
    const lastLatitudeCell = Math.floor((north * 3 + 240) / step) * step;
    const firstLongitudeCell = Math.floor((normalizedLongitude(west) * 3) / step) * step;
    const lastLongitudeCell = Math.floor((normalizedLongitude(west) * 3 + longitudeSpan * 3) / step) * step;

    for (let latitudeCell = firstLatitudeCell; latitudeCell <= lastLatitudeCell; latitudeCell += step) {
      for (let longitudeCellUnwrapped = firstLongitudeCell; longitudeCellUnwrapped <= lastLongitudeCell; longitudeCellUnwrapped += step) {
        const longitudeCell = ((longitudeCellUnwrapped % 1080) + 1080) % 1080;
        const found = byPath.get(pathForCell(latitudeCell, longitudeCell, scale));
        if (found) {
          const key = (found.webkitRelativePath || found.name).toLowerCase();
          if (!selected.has(key)) selected.set(key, found);
        }
        if (selected.size >= maxCells) break;
      }
      if (selected.size >= maxCells) break;
    }
    if (selected.size >= maxCells) break;
  }

  const scaleCounts: Partial<Record<Cm93ScaleCode, number>> = {};
  for (const file of selected.values()) {
    const actualScale = (file.webkitRelativePath || file.name).split('.').pop()?.toUpperCase() as Cm93ScaleCode;
    scaleCounts[actualScale] = (scaleCounts[actualScale] ?? 0) + 1;
  }

  return {
    scale: targetScale,
    files: [...selected.values()],
    // Retained for diagnostic/API compatibility. Fine-scale fill fallbacks
    // are deliberately disabled; only M_COVR-aware coarse coverage can fill gaps.
    fillFallbackFiles: [],
    scaleCounts,
  };
}

/** Do not retain features from previous viewports or zoom levels. */
export function buildCm93QuiltFeatures(
  currentFeatures: GeoJSON.Feature[],
): GeoJSON.Feature[] {
  return currentFeatures;
}
