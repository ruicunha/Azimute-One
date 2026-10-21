/**
 * Viewport-aware CM93 V2 cell selection for the experimental chart quilt.
 *
 * Scale thresholds are provisional display-scale heuristics and intended for
 * browser evaluation, not authoritative navigation portrayal. Each target
 * cell independently falls back to the closest available coarser cell.
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

/**
 * Delay finer-scale transitions until the map is sufficiently zoomed in.
 * These are deliberately tunable after observing the actual CM93 portrayal.
 */
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
  /** The scale requested by the current zoom, not necessarily every cell's scale. */
  scale: Cm93ScaleCode;
  /** A non-overlapping-by-path set of selected cells, including per-cell fallbacks. */
  files: Cm93CellFile[];
  /** Number of selected cells at each actual scale. */
  scaleCounts: Partial<Record<Cm93ScaleCode, number>>;
};

export function selectCm93ViewportCells(
  files: Cm93CellFile[],
  bounds: Cm93ViewportBounds,
  zoom: number,
  maxCells = 300,
): Cm93ViewportSelection {
  const targetScale = cm93ScaleForZoom(zoom);
  const targetIndex = CM93_SCALE_ORDER.indexOf(targetScale);
  const targetStep = CM93_SCALE_STEPS[targetScale];
  const byPath = new Map<string, Cm93CellFile>();
  for (const file of files) {
    const pathParts = (file.webkitRelativePath || file.name).toLowerCase().split('/');
    byPath.set('/' + pathParts.slice(-3).join('/'), file);
  }

  const south = Math.max(-79.5, Math.min(bounds.south, bounds.north));
  const north = Math.min(80, Math.max(bounds.south, bounds.north));
  const west = Math.min(bounds.west, bounds.east);
  const east = Math.max(bounds.west, bounds.east);
  const firstLatitudeCell = Math.floor((south * 3 + 240) / targetStep) * targetStep;
  const lastLatitudeCell = Math.floor((north * 3 + 240) / targetStep) * targetStep;
  const longitudeSpan = Math.min(360, Math.max(0, east - west));
  const firstLongitudeCell = Math.floor((normalizedLongitude(west) * 3) / targetStep) * targetStep;
  const lastLongitudeCell = Math.floor((normalizedLongitude(west) * 3 + longitudeSpan * 3) / targetStep) * targetStep;
  const selected = new Map<string, { file: Cm93CellFile; scale: Cm93ScaleCode }>();

  for (let latitudeCell = firstLatitudeCell; latitudeCell <= lastLatitudeCell; latitudeCell += targetStep) {
    for (let longitudeCellUnwrapped = firstLongitudeCell; longitudeCellUnwrapped <= lastLongitudeCell; longitudeCellUnwrapped += targetStep) {
      const longitudeCell = ((longitudeCellUnwrapped % 1080) + 1080) % 1080;
      const centerLatitude = (latitudeCell + targetStep / 2 - 240) / 3;
      const centerLongitude = normalizedLongitude((longitudeCellUnwrapped + targetStep / 2) / 3);
      let chosen: { file: Cm93CellFile; scale: Cm93ScaleCode } | undefined;

      // Start at the requested scale and walk toward coarser scales. For each
      // target footprint, use the finest cell that actually exists there.
      for (let scaleIndex = targetIndex; scaleIndex >= 0; scaleIndex--) {
        const scale = CM93_SCALE_ORDER[scaleIndex];
        const step = CM93_SCALE_STEPS[scale];
        const candidateLatitudeCell = Math.floor((centerLatitude * 3 + 240) / step) * step;
        const candidateLongitudeCell = Math.floor((centerLongitude * 3) / step) * step;
        const candidatePath = pathForCell(candidateLatitudeCell, candidateLongitudeCell, scale);
        const found = byPath.get(candidatePath);
        if (found) {
          chosen = { file: found, scale };
          break;
        }
      }

      if (chosen) {
        const key = (chosen.file.webkitRelativePath || chosen.file.name).toLowerCase();
        if (!selected.has(key)) selected.set(key, chosen);
      }
      if (selected.size >= maxCells) {
        const result = [...selected.values()];
        const scaleCounts: Partial<Record<Cm93ScaleCode, number>> = {};
        for (const item of result) scaleCounts[item.scale] = (scaleCounts[item.scale] ?? 0) + 1;
        return { scale: targetScale, files: result.map((item) => item.file), scaleCounts };
      }
    }
  }

  const result = [...selected.values()];
  const scaleCounts: Partial<Record<Cm93ScaleCode, number>> = {};
  for (const item of result) scaleCounts[item.scale] = (scaleCounts[item.scale] ?? 0) + 1;
  return { scale: targetScale, files: result.map((item) => item.file), scaleCounts };
}
