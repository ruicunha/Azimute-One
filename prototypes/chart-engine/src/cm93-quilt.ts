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
  files: Cm93CellFile[];
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
      return { scale: targetScale, files: [...selected.values()], scaleCounts };
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
