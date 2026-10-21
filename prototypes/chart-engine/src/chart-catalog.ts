export type ChartDefinition = {
  id: string;
  title: string;
  asset: string;
  coverage: [west: number, south: number, east: number, north: number];
  /** ENC compilation scale denominator, e.g. 12000 for 1:12,000. */
  scaleDenominator: number;
};

/**
 * Test chart collection. Coverage boxes are approximate POC metadata, not
 * official navigational coverage. Replace them with cell extents extracted
 * from ENC metadata before using a larger catalogue.
 */
export const chartCatalog: ChartDefinition[] = [
  {
    id: 'noaa-gulf-overview',
    title: 'NOAA small-scale ENC — Gulf of Mexico',
    asset: 'sample-chart-small-scale.zip',
    coverage: [-98.5, 18.0, -80.0, 31.5],
    scaleDenominator: 1200000,
  },
  {
    id: 'boston-harbor',
    title: 'Boston Harbor',
    asset: 'sample-chart.zip',
    coverage: [-71.30, 42.15, -70.55, 42.55],
    scaleDenominator: 12000,
  },
  {
    id: 'boston-inner-harbor',
    title: 'Boston Inner Harbor',
    asset: 'sample-chart-inner-harbor.zip',
    coverage: [-71.12, 42.25, -70.95, 42.40],
    scaleDenominator: 5000,
  },
  {
    id: 'new-york-approaches',
    title: 'New York approaches — US4NY13M',
    asset: 'sample-chart-new-york-approaches.zip',
    // Approximate test bounds; validate against the ENC's own metadata.
    coverage: [-74.25, 40.35, -73.55, 40.95],
    scaleDenominator: 80000,
  },
  {
    id: 'new-york-harbor',
    title: 'New York Harbor — US5NY14M',
    asset: 'sample-chart-new-york-harbor.zip',
    // Approximate test bounds; validate against the ENC's own metadata.
    coverage: [-74.15, 40.45, -73.75, 40.85],
    scaleDenominator: 20000,
  },
  {
    id: 'chs-training',
    title: 'CHS fictitious training ENC',
    asset: 'sample-chart-chs.zip',
    // Broad Canadian extent for selecting this test asset. Tighten this to
    // the cell's actual extent when the catalogue is generated from the data.
    coverage: [-141.0, 41.0, -52.0, 84.0],
    scaleDenominator: 50000,
  },
];

/**
 * Approximate the zoom at which a chart's compilation scale is displayed at
 * 96 CSS DPI. MapLibre's world-tile model uses 512 CSS-pixel tiles.
 *
 * This is a display-scale estimate, not a substitute for the chart's own
 * metadata or a calibrated physical display.
 */
export function zoomForChartScale(scaleDenominator: number, latitude: number): number {
  const earthCircumference = 40075016.68557849;
  const tileSize = 512;
  const cssPixelsPerMetre = 96 / 0.0254;
  const latitudeFactor = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  return Math.log2(
    (earthCircumference * latitudeFactor * cssPixelsPerMetre) /
      (tileSize * scaleDenominator),
  );
}

export function selectChartsForViewport(
  charts: ChartDefinition[],
  viewport: { west: number; south: number; east: number; north: number },
  zoom: number,
  latitude: number,
  scaleToleranceZoomLevels = 1,
): ChartDefinition[] {
  return charts.filter((chart) => {
    const [west, south, east, north] = chart.coverage;
    const intersects =
      viewport.west <= east &&
      viewport.east >= west &&
      viewport.south <= north &&
      viewport.north >= south;
    if (!intersects) return false;

    // Allow a one-zoom-level overlap around scale transitions. This prevents
    // abrupt gaps when adjacent charts have different compilation scales and
    // allows multiple cells with distinct footprints to be loaded together.
    const targetZoom = zoomForChartScale(chart.scaleDenominator, latitude);
    return Math.abs(zoom - targetZoom) <= scaleToleranceZoomLevels;
  });
}
