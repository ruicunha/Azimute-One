export type ChartDefinition = {
  id: string;
  title: string;
  asset: string;
  coverage: [west: number, south: number, east: number, north: number];
  minZoom: number;
  maxZoom: number;
  scaleDenominator: number;
};

/**
 * Proof-of-concept chart collection.
 *
 * The selector reads coverage and scale ranges from these records; it does not
 * contain knowledge of Boston, NOAA, or any particular chart identifier.
 * Replace/add records to test other chart footprints and scale combinations.
 * maxZoom is exclusive so adjacent scale bands do not select both charts.
 */
export const chartCatalog: ChartDefinition[] = [
  {
    id: 'boston-harbor',
    title: 'Boston Harbor (overview scale)',
    asset: 'sample-chart.zip',
    coverage: [-71.30, 42.15, -70.55, 42.55],
    minZoom: 5,
    maxZoom: 7,
    scaleDenominator: 12000,
  },
  {
    id: 'boston-inner-harbor',
    title: 'Boston Inner Harbor (larger scale)',
    asset: 'sample-chart-inner-harbor.zip',
    coverage: [-71.12, 42.25, -70.95, 42.40],
    minZoom: 7,
    maxZoom: 19,
    scaleDenominator: 5000,
  },
];

export function selectChartsForViewport(
  charts: ChartDefinition[],
  viewport: { west: number; south: number; east: number; north: number },
  zoom: number,
): ChartDefinition[] {
  return charts.filter((chart) => {
    const [west, south, east, north] = chart.coverage;
    const intersects =
      viewport.west <= east &&
      viewport.east >= west &&
      viewport.south <= north &&
      viewport.north >= south;
    const scaleMatches = zoom >= chart.minZoom && zoom < chart.maxZoom;
    return intersects && scaleMatches;
  });
}
