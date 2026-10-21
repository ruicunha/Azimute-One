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
  /** Selected cells include the finest available cell for each target footprint. */
  files: Cm93CellFile[];
  /** Number of selected cells at each actual scale. */
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

      // Start at the requested scale and walk toward coarser scales. A missing
      // target cell therefore falls back to the nearest available coarser cell.
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
      if (selected.size >= maxCells) break;
    }
    if (selected.size >= maxCells) break;
  }

  const result = [...selected.values()];
  const scaleCounts: Partial<Record<Cm93ScaleCode, number>> = {};
  for (const item of result) scaleCounts[item.scale] = (scaleCounts[item.scale] ?? 0) + 1;
  return { scale: targetScale, files: result.map((item) => item.file), scaleCounts };
}

type Cm93CellFootprint = { south: number; north: number; west: number; east: number };

function cm93CellFootprint(sourceCell: string): Cm93CellFootprint | null {
  const match = sourceCell.toLowerCase().match(/(\d{4})(\d{4})\.([zabcdefg])$/);
  if (!match) return null;
  const latitudeCell = Number(match[1]) - 30;
  const longitudeCell = Number(match[2]);
  const scale = match[3].toUpperCase() as Cm93ScaleCode;
  const step = CM93_SCALE_STEPS[scale];
  return {
    south: latitudeCell,
    north: latitudeCell + step,
    west: longitudeCell,
    east: longitudeCell + step,
  };
}

/**
 * A prior cell can be discarded only when current, usable cell coverage
 * replaces its entire footprint. Any overlap is not enough: a finer cell may
 * cover just one part of a coarser cell, and discarding the whole coarse cell
 * would create holes in the quilt.
 *
 * Coordinates are in CM93 grid units. Shifted longitude copies account for
 * the 1080-unit wrap at 360 degrees.
 */
function footprintFullyCoveredBySelected(
  footprint: Cm93CellFootprint,
  selected: Cm93CellFootprint[],
): boolean {
  const latitudeCuts = new Set<number>([footprint.south, footprint.north]);
  for (const candidate of selected) {
    const south = Math.max(footprint.south, candidate.south);
    const north = Math.min(footprint.north, candidate.north);
    if (south < north) {
      latitudeCuts.add(south);
      latitudeCuts.add(north);
    }
  }
  const sortedLatitudes = [...latitudeCuts].sort((a, b) => a - b);

  for (let index = 0; index < sortedLatitudes.length - 1; index++) {
    const bandSouth = sortedLatitudes[index];
    const bandNorth = sortedLatitudes[index + 1];
    if (bandSouth >= bandNorth) continue;
    const midLatitude = (bandSouth + bandNorth) / 2;
    const intervals: Array<[number, number]> = [];

    for (const candidate of selected) {
      if (candidate.south > midLatitude || candidate.north < midLatitude) continue;
      for (const shift of [-1080, 0, 1080]) {
        const west = Math.max(footprint.west, candidate.west + shift);
        const east = Math.min(footprint.east, candidate.east + shift);
        if (west < east) intervals.push([west, east]);
      }
    }

    intervals.sort((a, b) => a[0] - b[0]);
    let coveredUntil = footprint.west;
    for (const [west, east] of intervals) {
      if (west > coveredUntil) break;
      coveredUntil = Math.max(coveredUntil, east);
      if (coveredUntil >= footprint.east) break;
    }
    if (coveredUntil < footprint.east) return false;
  }
  return sortedLatitudes.length > 1;
}

/**
 * Merge current usable features with prior-scale fallback features.
 *
 * selectedCellKeys must contain only cells that produced usable features in
 * the current render. Empty or failed cells do not replace prior coverage.
 * A previous cell is removed only if the current usable footprints cover its
 * entire footprint, rather than merely touching any part of it.
 */
export function mergeCm93QuiltFeatures(
  currentFeatures: GeoJSON.Feature[],
  previousFeatures: GeoJSON.Feature[],
  selectedCellKeys: Set<string>,
): GeoJSON.Feature[] {
  const selectedFootprints = [...selectedCellKeys]
    .map(cm93CellFootprint)
    .filter((footprint): footprint is Cm93CellFootprint => footprint !== null);
  const fallback = previousFeatures.filter((feature) => {
    const sourceCell = feature.properties?.cm93SourceCell;
    if (typeof sourceCell !== 'string' || selectedCellKeys.has(sourceCell.toLowerCase())) return false;
    const previousFootprint = cm93CellFootprint(sourceCell);
    // Preserve unrecognized legacy keys; without a known footprint we cannot
    // prove that current data fully replaces them.
    return !previousFootprint || !footprintFullyCoveredBySelected(previousFootprint, selectedFootprints);
  });
  return [...currentFeatures, ...fallback];
}
