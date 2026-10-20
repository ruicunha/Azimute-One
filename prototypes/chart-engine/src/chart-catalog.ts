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
 * Test chart collection. The selector is generic: it only considers each
 * record's footprint and zoom range, never chart names or provider.
 *
 * Coverage boxes and zoom ranges are proof-of-concept metadata, not official
 * navigational coverage. Replace them with footprints/compilation scales
 * extracted from each ENC catalogue when moving beyond this test collection.
 * maxZoom is exclusive.
 */
export const chartCatalog: ChartDefinition[] = [
  {
    id: 'noaa-gulf-overview',
    title: 'NOAA small-scale ENC — Gulf of Mexico',
    asset: 'sample-chart-small-scale.zip',
    coverage: [-98.5, 18.0, -80.0, 31.5],
    minZoom: 2,
    maxZoom: 5,
    scaleDenominator: 1200000,
  },
  {
    id: 'boston-harbor',
    title: 'Boston Harbor',
    asset: 'sample-chart.zip',
    coverage: [-71.30, 42.15, -70.55, 42.55],
    minZoom: 5,
    maxZoom: 7,
    scaleDenominator: 12000,
  },
  {
    id: 'boston-inner-harbor',
    title: 'Boston Inner Harbor',
    asset: 'sample-chart-inner-harbor.zip',
    coverage: [-71.12, 42.25, -70.95, 42.40],
    minZoom: 7,
    maxZoom: 19,
    scaleDenominator: 5000,
  },
  {
    id: 'new-york-approaches',
    title: 'New York approaches — US4NY13M',
    asset: 'sample-chart-new-york-approaches.zip',
    // Approximate test bounds; validate against the ENC's own metadata.
    coverage: [-74.25, 40.35, -73.55, 40.95],
    minZoom: 4,
    maxZoom: 7,
    scaleDenominator: 80000,
  },
  {
    id: 'new-york-harbor',
    title: 'New York Harbor — US5NY14M',
    asset: 'sample-chart-new-york-harbor.zip',
    // Approximate test bounds; validate against the ENC's own metadata.
    coverage: [-74.15, 40.45, -73.75, 40.85],
    minZoom: 7,
    maxZoom: 11,
    scaleDenominator: 20000,
  },
  {
    id: 'chs-training',
    title: 'CHS fictitious training ENC',
    asset: 'sample-chart-chs.zip',
    // Broad Canadian extent for selecting this test asset. Tighten this to
    // the cell's actual extent when the catalogue is generated from the data.
    coverage: [-141.0, 41.0, -52.0, 84.0],
    minZoom: 4,
    maxZoom: 11,
    scaleDenominator: 50000,
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
    return intersects && zoom >= chart.minZoom && zoom < chart.maxZoom;
  });
}
