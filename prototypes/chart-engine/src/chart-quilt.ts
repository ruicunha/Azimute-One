import type { ChartDefinition } from './chart-catalog';

export type GeographicViewport = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type QuiltCell = {
  column: number;
  row: number;
  chartId: string | null;
};

export type QuiltPlan = {
  /** The chart best suited to the viewport centre and current display scale. */
  referenceChartId: string | null;
  /** Unique charts needed to cover the sampled viewport, in render preference order. */
  charts: ChartDefinition[];
  /** A coarse coverage plan. This is selection metadata, not a clipping geometry. */
  cells: QuiltCell[];
};

type Point = { longitude: number; latitude: number };

function covers(chart: ChartDefinition, point: Point): boolean {
  const [west, south, east, north] = chart.coverage;
  return point.longitude >= west && point.longitude <= east &&
    point.latitude >= south && point.latitude <= north;
}

/**
 * Plan a chart quilt from geographic coverage and compilation scale.
 *
 * The centre chart is the reference chart. Each sample in a coarse viewport
 * grid then uses that chart when it covers the sample, or the most scale-
 * appropriate available chart as a fallback. This prevents a scale filter
 * from leaving uncovered viewport areas merely because no chart is within a
 * narrow zoom band.
 *
 * Coverage is currently represented by catalogue bounding boxes and sampled
 * points. A production quilt must use real ENC coverage polygons and clip
 * portrayal to per-chart quilt regions before overlapping charts are rendered.
 */
export function planChartQuilt(
  charts: ChartDefinition[],
  viewport: GeographicViewport,
  zoom: number,
  latitude: number,
  zoomForScale: (scaleDenominator: number, latitude: number) => number,
  gridSize = 7,
): QuiltPlan {
  const candidates = charts.filter((chart) => {
    const [west, south, east, north] = chart.coverage;
    return viewport.west <= east && viewport.east >= west &&
      viewport.south <= north && viewport.north >= south;
  });

  const scaleError = (chart: ChartDefinition, pointLatitude: number) =>
    Math.abs(zoom - zoomForScale(chart.scaleDenominator, pointLatitude));

  const centre = {
    longitude: (viewport.west + viewport.east) / 2,
    latitude: (viewport.south + viewport.north) / 2,
  };
  const reference = candidates
    .filter((chart) => covers(chart, centre))
    .sort((a, b) => scaleError(a, centre.latitude) - scaleError(b, centre.latitude)
      || a.scaleDenominator - b.scaleDenominator)[0] ?? null;

  const selected = new Map<string, ChartDefinition>();
  const cells: QuiltCell[] = [];
  const safeGridSize = Math.max(1, Math.floor(gridSize));

  for (let row = 0; row < safeGridSize; row += 1) {
    for (let column = 0; column < safeGridSize; column += 1) {
      const point = {
        longitude: viewport.west + ((column + 0.5) / safeGridSize) * (viewport.east - viewport.west),
        latitude: viewport.north - ((row + 0.5) / safeGridSize) * (viewport.north - viewport.south),
      };
      const covering = candidates.filter((chart) => covers(chart, point));
      const chosen = (reference && covering.some((chart) => chart.id === reference.id)
        ? reference
        : covering.sort((a, b) => scaleError(a, point.latitude) - scaleError(b, point.latitude)
          || a.scaleDenominator - b.scaleDenominator)[0]) ?? null;

      if (chosen) selected.set(chosen.id, chosen);
      cells.push({ column, row, chartId: chosen?.id ?? null });
    }
  }

  // Include the reference even if the coarse sample grid misses a narrow
  // portion of its footprint; it remains the scale anchor for this viewport.
  if (reference) selected.set(reference.id, reference);

  const orderedCharts = [...selected.values()].sort((a, b) => {
    if (a.id === reference?.id) return -1;
    if (b.id === reference?.id) return 1;
    return scaleError(a, centre.latitude) - scaleError(b, centre.latitude);
  });

  return {
    referenceChartId: reference?.id ?? null,
    charts: orderedCharts,
    cells,
  };
}
