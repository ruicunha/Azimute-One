/**
 * Viewport-aware CM93 V2 cell selection for the experimental chart quilt.
 *
 * The viewport renders one chart scale at a time. If no cells exist at the
 * requested scale anywhere in the viewport, selection falls back to the
 * nearest coarser scale available. Mixing scales without CM93 coverage
 * polygons causes overlapping depth areas and is not a valid quilt.
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
  /** Scale requested by the current zoom; fallback is used only if it is absent. */
  scale: Cm93ScaleCode;
  /** Cells from exactly one scale, so chart layers cannot overlap across scales. */
  files: Cm93CellFile[];
  /** Number of selected cells at each actual scale (at most one scale key). */
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

  // Try one scale across the whole viewport at a time. A coarser chart may be
  // used only when the requested scale has no cells in this viewport at all.
  // Per-footprint mixing is unsafe without decoded CM93 coverage geometry.
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
        const candidatePath = pathForCell(latitudeCell, longitudeCell, scale);
        const found = byPath.get(candidatePath);
        if (found) {
          const key = (found.webkitRelativePath || found.name).toLowerCase();
          if (!selected.has(key)) selected.set(key, found);
        }
        if (selected.size >= maxCells) break;
      }
      if (selected.size >= maxCells) break;
    }

    if (selected.size > 0) {
      return {
        scale: targetScale,
        files: [...selected.values()],
        scaleCounts: { [scale]: selected.size },
      };
    }
  }

  return { scale: targetScale, files: [], scaleCounts: {} };
}

/** Do not retain features from previous viewports or zoom levels. */
export function buildCm93QuiltFeatures(
  currentFeatures: GeoJSON.Feature[],
): GeoJSON.Feature[] {
  return currentFeatures;
}
