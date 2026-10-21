/**
 * Viewport-aware CM93 V2 cell selection for the experimental chart quilt.
 *
 * Scale thresholds are provisional and intended for browser evaluation, not
 * authoritative navigation portrayal.
 */
export type Cm93CellFile = {
  name: string;
  webkitRelativePath?: string;
};

export type Cm93ViewportBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export const CM93_SCALE_STEPS: Record<string, number> = {
  Z: 120,
  A: 60,
  B: 30,
  C: 12,
  D: 3,
  E: 1,
  F: 1,
  G: 1,
};

export function cm93ScaleForZoom(zoom: number): string {
  if (zoom < 3) return 'Z';
  if (zoom < 4) return 'A';
  if (zoom < 5) return 'B';
  if (zoom < 7) return 'C';
  if (zoom < 9) return 'D';
  if (zoom < 11) return 'E';
  if (zoom < 13) return 'F';
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

export function selectCm93ViewportCells(
  files: Cm93CellFile[],
  bounds: Cm93ViewportBounds,
  zoom: number,
  maxCells = 300,
): { scale: string; files: Cm93CellFile[] } {
  const scale = cm93ScaleForZoom(zoom);
  const step = CM93_SCALE_STEPS[scale];
  const byPath = new Map<string, Cm93CellFile>();
  for (const file of files) {
    const pathParts = (file.webkitRelativePath || file.name).toLowerCase().split('/');
    byPath.set('/' + pathParts.slice(-3).join('/'), file);
  }

  const south = Math.max(-79.5, Math.min(bounds.south, bounds.north));
  const north = Math.min(80, Math.max(bounds.south, bounds.north));
  const west = Math.min(bounds.west, bounds.east);
  const east = Math.max(bounds.west, bounds.east);
  const firstLatitudeCell = Math.floor((south * 3 + 240) / step) * step;
  const lastLatitudeCell = Math.floor((north * 3 + 240) / step) * step;
  const longitudeSpan = Math.min(360, Math.max(0, east - west));
  const firstLongitudeCell = Math.floor((normalizedLongitude(west) * 3) / step) * step;
  const lastLongitudeCell = Math.floor((normalizedLongitude(west) * 3 + longitudeSpan * 3) / step) * step;
  const selected = new Map<string, Cm93CellFile>();

  for (let latitudeCell = firstLatitudeCell; latitudeCell <= lastLatitudeCell; latitudeCell += step) {
    for (let longitudeCellUnwrapped = firstLongitudeCell; longitudeCellUnwrapped <= lastLongitudeCell; longitudeCellUnwrapped += step) {
      const longitudeCell = ((longitudeCellUnwrapped % 1080) + 1080) % 1080;
      const path = pathForCell(latitudeCell, longitudeCell, scale);
      const found = byPath.get(path);
      if (found) selected.set(found.webkitRelativePath || found.name, found);
      if (selected.size >= maxCells) return { scale, files: [...selected.values()] };
    }
  }

  // If the selected scale has no cells in this viewport, try no other scale
  // here: callers can report the gap and retain their coarse overview.
  return { scale, files: [...selected.values()] };
}
