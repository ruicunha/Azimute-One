import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { addChartLayers, removeChart } from '@s57-parser/maplibre';
import { parseS57, toGeoJSON } from '@s57-parser/s57';
import { unzipSync } from 'fflate';
import { chartCatalog, zoomForChartScale, type ChartDefinition } from './chart-catalog';
import { planChartQuilt } from './chart-quilt';
import { inspectCm93Files, type Cm93DatasetSummary } from './cm93-dataset';
import { cm93CellToGeoJSON, decodeCm93FeatureAttributes, parseCm93Cell, parseCm93Dictionaries, type Cm93Dictionary } from './cm93-decoder';
import { selectCm93ViewportCells } from './cm93-quilt';

type Status = 'loading' | 'ready' | 'error' | 'idle';

type RasterChartMetadata = {
  name: string;
  bounds: [number, number, number, number];
  minzoom: number;
  maxzoom: number;
  tileCount?: number;
};

const emptyStyle: maplibregl.StyleSpecification = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {},
  layers: [{ id: 'water-background', type: 'background', paint: { 'background-color': '#b9dce5' } }],
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function findCell(bytes: Uint8Array, filename: string): { name: string; bytes: Uint8Array } {
  if (filename.toLowerCase().endsWith('.000')) return { name: filename, bytes };
  const entries = unzipSync(bytes);
  const cellEntry = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith('.000'));
  if (!cellEntry) throw new Error('No .000 S-57 cell was found in that ZIP. Select an ENC exchange-set ZIP or a .000 file.');
  return { name: cellEntry[0].split('/').pop() ?? cellEntry[0], bytes: cellEntry[1] };
}


function findCm93CellForPosition(files: File[], latitude: number, longitude: number): File | undefined {
  const scales = [
    { code: 'G', step: 1 },
    { code: 'F', step: 1 },
    { code: 'E', step: 1 },
    { code: 'D', step: 3 },
    { code: 'C', step: 12 },
    { code: 'B', step: 30 },
    { code: 'A', step: 60 },
    { code: 'Z', step: 120 },
  ];
  const normalizedLongitude = ((longitude + 360) % 360 + 360) % 360;
  const longitudeUnits = normalizedLongitude * 3;
  const latitudeUnits = latitude * 3 + 240;
  const lookup = new Map(files.map((file) => [
    (file.webkitRelativePath || file.name).toLowerCase(),
    file,
  ]));
  for (const scale of scales) {
    const lonCell = Math.floor(longitudeUnits / scale.step) * scale.step;
    const latCell = Math.floor(latitudeUnits / scale.step) * scale.step;
    const cellLat = latCell + 30;
    const rootLat = Math.floor((cellLat - 30) / 60) * 60 + 30;
    const rootLon = Math.floor(lonCell / 60) * 60;
    const root = String(rootLat).padStart(4, '0') + String(rootLon).padStart(4, '0');
    const filename = String(cellLat).padStart(4, '0') + String(lonCell).padStart(4, '0') + '.' + scale.code.toLowerCase();
    const suffix = '/' + root.toLowerCase() + '/' + scale.code.toLowerCase() + '/' + filename;
    const found = [...lookup.entries()].find(([path]) => path.endsWith(suffix));
    if (found) return found[1];
  }
  return undefined;
}

const cm93QuiltLayerIds = [
  'cm93-quilt-labels', 'cm93-quilt-depth-labels', 'cm93-quilt-icons',
  'cm93-quilt-lines', 'cm93-quilt-points', 'cm93-quilt-fill',
];

const cm93KnownLineClasses = [
  'DEPCNT', 'COALNE', 'SLCONS', 'TSSBND', 'TSSLPT', 'RIVERS', 'CANALS',
];
const cm93PointLabelClasses = [
  'LIGHTS', 'BCNLAT', 'BCNCAR', 'BCNSAW', 'BCNSPP',
  'BOYLAT', 'BOYCAR', 'BOYISD', 'BOYSAW', 'BOYSPP', 'BOYINB',
  'LNDMRK', 'WRECKS', 'UWTROC',
];

const cm93ClassDescriptions: Record<string, string> = {
  LIGHTS: 'Lights — navigational lights and light characteristics',
  BCNLAT: 'Lateral beacon — marks channel edges',
  BCNCAR: 'Cardinal beacon — marks safe water by compass direction',
  BCNSAW: 'Safe-water beacon — marks navigable water around it',
  BCNSPP: 'Special-purpose beacon — marks a special area or feature',
  BOYLAT: 'Lateral buoy — marks channel edges',
  BOYCAR: 'Cardinal buoy — marks safe water by compass direction',
  BOYISD: 'Isolated-danger buoy — marks a nearby hazard',
  BOYSAW: 'Safe-water buoy — marks navigable water around it',
  BOYSPP: 'Special-purpose buoy — marks a special area or feature',
  BOYINB: 'Installation buoy — associated with an offshore installation',
  LNDMRK: 'Landmark — conspicuous object on land',
  WRECKS: 'Wreck — sunken or stranded vessel',
  UWTROC: 'Underwater rock — submerged rocky hazard',
  DEPCNT: 'Depth contour — line joining equal depths',
  DEPARE: 'Depth area — water area with a depth range',
  DRGARE: 'Dredged area — maintained depth area',
  COALNE: 'Coastline — boundary between land and water',
  LNDARE: 'Land area',
  SLCONS: 'Shoreline construction — quay, seawall, or similar structure',
  TSSBND: 'Traffic separation scheme boundary',
  TSSLPT: 'Traffic separation scheme lane part',
};

function cm93ClassIcon(name: string): string {
  if (name === 'LIGHTS') return '✦';
  if (name.startsWith('BOY')) return name === 'BOYCAR' || name === 'BOYISD' ? '◆' : '◇';
  if (name.startsWith('BCN')) return name === 'BCNCAR' ? '▲' : '△';
  if (name === 'LNDMRK' || name === 'UWTROC') return '▲';
  if (name === 'WRECKS') return '×';
  return '•';
}

function addCm93PortrayalLayers(map: MapLibreMap, source: string, prefix: string, visiblePointClasses: string[]): void {
  map.addLayer({
    id: prefix + '-lines', type: 'line', source, minzoom: 2,
    filter: ['all',
      ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]],
      ['in', ['get', 'cm93Class'], ['literal', cm93KnownLineClasses]],
    ],
    paint: {
      'line-color': ['match', ['get', 'cm93Class'],
        'DEPCNT', '#70a9c3', 'COALNE', '#8ea9a8', 'SLCONS', '#7b8f91',
        'TSSBND', '#b58b69', 'TSSLPT', '#b58b69', '#83a6b5'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.35, 8, 0.7, 13, 1.25, 16, 1.6],
      'line-opacity': ['match', ['get', 'cm93Class'], 'DEPCNT', 0.95, 0.82],
    },
  });
  map.addLayer({
    id: prefix + '-icons', type: 'symbol', source, minzoom: 3,
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'cm93RelatedChild'], true], ['in', ['get', 'cm93Class'], ['literal', visiblePointClasses]]],
    layout: {
      'text-field': ['match', ['get', 'cm93Class'],
        'LIGHTS', '✦',
        'BCNCAR', '▲', 'BCNLAT', '△', 'BCNSAW', '○', 'BCNSPP', '◇',
        'BOYCAR', '◆', 'BOYISD', '◆', 'BOYLAT', '◇', 'BOYSAW', '○',
        'BOYSPP', '◇', 'BOYINB', '◇', 'LNDMRK', '▲', 'WRECKS', '×',
        'UWTROC', '▲', '•'],
      'text-font': ['Open Sans Semibold', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 3, 8, 8, 10, 13, 13, 16, 16],
      'text-allow-overlap': false,
    },
    paint: {
      'text-color': ['match', ['get', 'cm93Class'],
        'LIGHTS', '#d49a19', 'BCNCAR', '#d94b36', 'BOYCAR', '#d94b36',
        'WRECKS', '#c43c35', 'UWTROC', '#c43c35', 'LNDMRK', '#8c5a36', '#327f9e'],
      'text-halo-color': '#f7f4e9', 'text-halo-width': 1.1,
    },
  });
  map.addLayer({
    id: prefix + '-labels', type: 'symbol', source, minzoom: 12,
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'cm93RelatedChild'], true], ['in', ['get', 'cm93Class'], ['literal', cm93PointLabelClasses]], ['in', ['get', 'cm93Class'], ['literal', visiblePointClasses]]],
    layout: {
      'text-field': ['coalesce', ['get', 'cm93DetailLabel'], ['case',
        ['==', ['get', 'cm93Class'], 'LIGHTS'],
        ['concat', ['coalesce', ['to-string', ['get', 'OBJNAM']], 'Light'], ' ', ['coalesce', ['to-string', ['get', 'SIGPER']], ''], 's'],
        ['has', 'OBJNAM'], ['to-string', ['get', 'OBJNAM']],
        ['has', 'VALNMR'], ['concat', ['to-string', ['get', 'VALNMR']], ' m'],
        ['has', 'COLOUR'], ['to-string', ['get', 'COLOUR']],
        '']],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 12],
      'text-offset': [0, 1.1], 'text-anchor': 'top',
      'text-optional': true, 'text-max-width': 10,
    },
    paint: { 'text-color': '#36566a', 'text-halo-color': '#f7f4e9', 'text-halo-width': 1.2 },
  });
  map.addLayer({
    id: prefix + '-depth-labels', type: 'symbol', source, minzoom: 10,
    filter: ['all', ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]], ['==', ['get', 'cm93Class'], 'DEPCNT'], ['has', 'VALDCO']],
    layout: {
      'symbol-placement': 'line',
      'text-field': ['concat', ['to-string', ['get', 'VALDCO']], ' m'],
      'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
      'text-size': 10, 'text-max-angle': 30, 'text-allow-overlap': false,
    },
    paint: { 'text-color': '#426f87', 'text-halo-color': '#eaf4f6', 'text-halo-width': 1.2 },
  });
}

function clearCm93Quilt(map: MapLibreMap): void {
  for (const layerId of cm93QuiltLayerIds) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource('cm93-quilt')) map.removeSource('cm93-quilt');
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const cm93DirectoryInput = useRef<HTMLInputElement>(null);
  const cm93FilesRef = useRef<File[]>([]);
  const cm93DictionaryRef = useRef<Cm93Dictionary | null>(null);
  const cm93DecodedCacheRef = useRef(new Map<string, ReturnType<typeof cm93CellToGeoJSON>['geojson']['features']>());
  const cm93QuiltRequestRef = useRef(0);
  const cm93AutoEnabledRef = useRef(false);
  const cm93OverviewScaleRef = useRef<string | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const activeChartIds = useRef(new Set<string>());
  const loadingChartIds = useRef(new Set<string>());
  const desiredChartIds = useRef(new Set<string>());
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('Overview ready. Pan and zoom to select charts from the catalogue.');
  const [chartName, setChartName] = useState('World overview');
  const [featureCount, setFeatureCount] = useState<number | null>(null);
  const [source, setSource] = useState('Natural Earth overview');
  const [selectedCharts, setSelectedCharts] = useState<string[]>([]);
  const [cmapMetadata, setCmapMetadata] = useState<RasterChartMetadata | null>(null);
  const [cmapVisible, setCmapVisible] = useState(false);
  const [cm93Summary, setCm93Summary] = useState<Cm93DatasetSummary | null>(null);
  const [cm93AutoEnabled, setCm93AutoEnabled] = useState(false);
  const [cm93PointClassCounts, setCm93PointClassCounts] = useState<Array<{ name: string; count: number }>>([]);
  const [visibleCm93PointClasses, setVisibleCm93PointClasses] = useState<string[]>([]);
  const visibleCm93PointClassesRef = useRef<string[]>([]);
  const [cm93QuiltStats, setCm93QuiltStats] = useState<{ scale: string; cells: number; features: number; cached: number; failed: number; classes: string[] } | null>(null);
  const [cm93DictionaryStats, setCm93DictionaryStats] = useState<{ objects: number; attributes: number } | null>(null);
  const [cm93CellStats, setCm93CellStats] = useState<{ checked: number; valid: number; features: number; vectors: number; vectorPoints: number; classes: string[]; attributes: string[]; failures: string[]; example?: { name: string; headerLength: number; table1Length: number; table2Length: number; bounds: string; vectorRecordCount: number; vectorPointCount: number; point2dCount: number; featureCount: number } } | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: emptyStyle,
      center: [0, 20],
      zoom: 1.5,
      minZoom: 1,
      maxZoom: 18,
    });

    map.on('load', () => {
      map.addSource('world-land', {
        type: 'geojson',
        data: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson',
      });
      map.addLayer({ id: 'world-land-fill', type: 'fill', source: 'world-land', paint: { 'fill-color': '#d9d6c8' } });
      map.addLayer({ id: 'world-land-outline', type: 'line', source: 'world-land', paint: { 'line-color': '#9caa9d', 'line-width': 0.7 } });
      // An optional MBTiles dataset is converted to static XYZ tiles during the
      // Pages build. If it is not configured, the vector-only prototype is unchanged.
      void fetch(`${import.meta.env.BASE_URL}cmap-tiles/metadata.json`)
        .then((response) => {
          if (!response.ok) throw new Error('No raster chart is configured.');
          return response.json() as Promise<RasterChartMetadata>;
        })
        .then((metadata) => {
          if (mapRef.current !== map) return;
          map.addSource('cmap-raster', {
            type: 'raster',
            tiles: [`${import.meta.env.BASE_URL}cmap-tiles/{z}/{x}/{y}.png`],
            tileSize: 256,
            minzoom: metadata.minzoom,
            maxzoom: metadata.maxzoom,
            bounds: metadata.bounds,
          });
          map.addLayer({
            id: 'cmap-raster-layer',
            type: 'raster',
            source: 'cmap-raster',
            layout: { visibility: 'none' },
            paint: { 'raster-opacity': 0.96 },
          });
          setCmapMetadata(metadata);
        })
        .catch(() => {
          // Raster charts are optional; missing metadata should not affect ENC use.
        });
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'nautical' as never }), 'bottom-left');
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      activeChartIds.current.clear();
      loadingChartIds.current.clear();
      desiredChartIds.current.clear();
    };
  }, []);

  const addChart = useCallback(async (
    input: Uint8Array,
    filename: string,
    sourceLabel: string,
    layerId: string,
    isAutomatic: boolean,
  ) => {
    const map = mapRef.current;
    if (!map) throw new Error('Map is not ready yet.');
    const cell = findCell(input, filename);
    if (!map.isStyleLoaded()) await new Promise<void>((resolve) => map.once('load', resolve));

    const dataset = parseS57(toArrayBuffer(cell.bytes));
    const geojson = toGeoJSON(dataset);
    const featureTotal = (geojson as { features?: unknown[] }).features?.length ?? null;

    // A fetch may finish after the user has panned elsewhere. Do not add a
    // chart that is no longer selected by the current viewport.
    if (isAutomatic && !desiredChartIds.current.has(layerId)) return;
    if (map.getSource(layerId)) removeChart(map, layerId);
    map.addSource(layerId, {
      type: 'geojson',
      data: geojson as never,
      tolerance: 1,
      maxzoom: 14,
      buffer: 0,
    });
    addChartLayers(map, layerId);
    activeChartIds.current.add(layerId);
    setFeatureCount(featureTotal);
    setSource(sourceLabel);
    setChartName(isAutomatic ? cell.name : cell.name);
    setStatus('ready');
    setMessage(isAutomatic ? 'Chart selected by the viewport quilt planner.' : 'ENC loaded. Pan and zoom to explore the chart.');
  }, []);

  const loadCatalogChart = useCallback(async (chart: ChartDefinition) => {
    const layerId = `enc-${chart.id}`;
    if (activeChartIds.current.has(layerId) || loadingChartIds.current.has(layerId)) return;
    loadingChartIds.current.add(layerId);
    setStatus('loading');
    setMessage(`Loading ${chart.title}…`);
    try {
      const developmentUrls: Record<string, string> = {
        'sample-chart-small-scale.zip': '/noaa-small-scale',
        'sample-chart.zip': '/noaa-chart',
        'sample-chart-inner-harbor.zip': '/noaa-inner-harbor',
        'sample-chart-new-york-approaches.zip': '/noaa-ny-approaches',
        'sample-chart-new-york-harbor.zip': '/noaa-ny-harbor',
      };
      const url = import.meta.env.DEV
        ? developmentUrls[chart.asset]
        : `${import.meta.env.BASE_URL}${chart.asset}`;
      if (!url) throw new Error(`No chart URL configured for asset ${chart.asset}.`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load ${chart.title} (HTTP ${response.status}).`);
      await addChart(new Uint8Array(await response.arrayBuffer()), chart.asset, 'Chart catalogue', layerId, true);
    } catch (error) {
      if (desiredChartIds.current.has(layerId)) {
        setStatus('error');
        setMessage(error instanceof Error ? error.message : `Could not load ${chart.title}.`);
      }
    } finally {
      loadingChartIds.current.delete(layerId);
      if (loadingChartIds.current.size === 0 && desiredChartIds.current.size === 0) {
        setStatus('idle');
      }
    }
  }, [addChart]);

  const syncCharts = useCallback(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const bounds = map.getBounds();
    const quilt = planChartQuilt(
      chartCatalog,
      { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() },
      map.getZoom(),
      map.getCenter().lat,
      zoomForChartScale,
    );
    const candidates = quilt.charts;
    const nextIds = new Set(candidates.map((chart) => `enc-${chart.id}`));
    desiredChartIds.current = nextIds;

    // Remove cells outside the viewport/scale selection so chart data and
    // layers are not retained after they are no longer needed.
    for (const id of activeChartIds.current) {
      if (!nextIds.has(id)) {
        removeChart(map, id);
        activeChartIds.current.delete(id);
      }
    }

    setSelectedCharts(candidates.map((chart) => chart.title));
    if (candidates.length === 0) {
      setStatus('idle');
      setChartName('World overview');
      setFeatureCount(null);
      setSource('Natural Earth overview');
      setMessage('No catalogue chart covers the sampled viewport. Showing the lightweight overview.');
      return;
    }

    for (const chart of candidates) void loadCatalogChart(chart);
  }, [loadCatalogChart]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.on('moveend', syncCharts);
    map.on('load', syncCharts);
    return () => {
      map.off('moveend', syncCharts);
      map.off('load', syncCharts);
    };
  }, [syncCharts]);

  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await addChart(bytes, file.name, 'Local file', 'enc-manual', false);
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not parse this ENC file.');
    }
  };

  useEffect(() => {
    // Chromium-based browsers expose directory selection via webkitdirectory.
    // Set it imperatively to avoid relying on non-standard React DOM typings.
    cm93DirectoryInput.current?.setAttribute('webkitdirectory', '');
    cm93DirectoryInput.current?.setAttribute('directory', '');
  }, []);

  const onCm93Directory = async (files?: FileList | null) => {
    if (!files?.length) return;
    try {
      const summary = inspectCm93Files(files);
      const fileList = Array.from(files);
      cm93AutoEnabledRef.current = false;
      setCm93AutoEnabled(false);
      cm93QuiltRequestRef.current++;
      cm93DecodedCacheRef.current.clear();
      cm93OverviewScaleRef.current = null;
      setCm93QuiltStats(null);
      if (mapRef.current) {
        clearCm93Quilt(mapRef.current);
        for (const layerId of ['cm93-cell-labels', 'cm93-cell-depth-labels', 'cm93-cell-icons', 'cm93-cell-points', 'cm93-cell-lines', 'cm93-cell-fill']) {
          if (mapRef.current.getLayer(layerId)) mapRef.current.removeLayer(layerId);
        }
        if (mapRef.current.getSource('cm93-active-cell')) mapRef.current.removeSource('cm93-active-cell');
      }
      cm93FilesRef.current = fileList;
      const findTextFile = async (name: string) => {
        const file = fileList.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
        return file ? file.text() : null;
      };
      const [objectDictionary, attributeDictionary] = await Promise.all([
        findTextFile('CM93OBJ.DIC'),
        findTextFile('CM93ATTR.DIC'),
      ]);
      let dictionary: Cm93Dictionary | null = null;
      let dictionaryStats: { objects: number; attributes: number } | null = null;
      if (objectDictionary !== null && attributeDictionary !== null) {
        dictionary = parseCm93Dictionaries(objectDictionary, attributeDictionary);
        dictionaryStats = { objects: dictionary.objectsByCode.size, attributes: dictionary.attributesByCode.size };
      }
      const cellFiles = fileList.filter((file) => /\.[A-GZ]$/i.test(file.name))
        .sort((left, right) => (left.webkitRelativePath || left.name).localeCompare(right.webkitRelativePath || right.name));
      const sample = cellFiles.slice(0, Math.min(12, cellFiles.length));
      const failures: string[] = [];
      let valid = 0;
      let features = 0;
      let vectors = 0;
      let vectorPoints = 0;
      const classCounts = new Map<string, number>();
      const attributeCounts = new Map<string, number>();
      let example: { name: string; headerLength: number; table1Length: number; table2Length: number; bounds: string; vectorRecordCount: number; vectorPointCount: number; point2dCount: number; featureCount: number } | undefined;
      for (const file of sample) {
        try {
          const cell = parseCm93Cell(new Uint8Array(await file.arrayBuffer()), file.name);
          valid++;
          features += cell.features.length;
          vectors += cell.vectors.length;
          vectorPoints += cell.metadata.vectorPointCount;
          for (const feature of cell.features) {
            const objectName = dictionary?.objectsByCode.get(feature.objectCode)?.name ?? 'Object ' + feature.objectCode;
            classCounts.set(objectName, (classCounts.get(objectName) ?? 0) + 1);
            if (dictionary && feature.attributeCount > 0) {
              try {
                for (const attribute of decodeCm93FeatureAttributes(feature.rawAttributes, feature.attributeCount, dictionary)) {
                  if (attribute.supported && attribute.name) attributeCounts.set(attribute.name, (attributeCounts.get(attribute.name) ?? 0) + 1);
                }
              } catch {
                // Keep the geometry sample usable if an uncommon attribute encoding is not yet supported.
              }
            }
          }
          if (!example) example = {
            name: file.webkitRelativePath || file.name,
            headerLength: cell.header.headerLength,
            table1Length: cell.header.table1Length,
            table2Length: cell.header.table2Length,
            bounds: [cell.metadata.geographicBounds.west, cell.metadata.geographicBounds.south, cell.metadata.geographicBounds.east, cell.metadata.geographicBounds.north].join(', '),
            vectorRecordCount: cell.metadata.vectorRecordCount,
            vectorPointCount: cell.metadata.vectorPointCount,
            point2dCount: cell.metadata.point2dCount,
            featureCount: cell.metadata.featureCount,
          };
        } catch (error) {
          failures.push((file.webkitRelativePath || file.name) + ': ' + (error instanceof Error ? error.message : 'header validation failed'));
        }
      }
      const classes = [...classCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([name, count]) => name + ' (' + count + ')');
      const attributes = [...attributeCounts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([name, count]) => name + ' (' + count + ')');
      const cellStats = { checked: sample.length, valid, features, vectors, vectorPoints, classes, attributes, failures, example };
      setCm93CellStats(cellStats);
      cm93DictionaryRef.current = dictionary;
      setCm93DictionaryStats(dictionaryStats);
      setCm93Summary(summary);
      setMessage(summary.isLikelyCm93V2
        ? 'CM93 V2 dataset recognized: ' + summary.regionCount + ' regions, ' + summary.fileCount.toLocaleString() + ' files. Cell headers validated: ' + valid + '/' + sample.length + '; ' + (dictionaryStats?.objects.toLocaleString() ?? 'unparsed') + ' object classes and ' + (dictionaryStats?.attributes.toLocaleString() ?? 'unparsed') + ' attributes.'
        : 'The selected directory does not look like a complete CM93 V2 dataset. Review the validation details below.');
      setStatus(summary.isLikelyCm93V2 && sample.length > 0 && valid === sample.length ? 'ready' : 'error');
      setChartName(summary.isLikelyCm93V2 ? 'CM93 V2 — ' + summary.rootName : 'Unrecognized CM93 dataset');
      setSource('CM93 V2 directory');
      setFeatureCount(null);
    } catch (error) {
      setCm93Summary(null);
      setCm93DictionaryStats(null);
      setCm93CellStats(null);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not inspect the selected CM93 directory.');
    }
  };


  const renderCm93CellAtMapCenter = async () => {
    const map = mapRef.current;
    const dictionary = cm93DictionaryRef.current;
    if (!map || !dictionary) {
      setStatus('error');
      setMessage('Select a valid CM93 V2 directory with both dictionaries first.');
      return;
    }
    try {
      const center = map.getCenter();
      const file = findCm93CellForPosition(cm93FilesRef.current, center.lat, center.lng);
      if (!file) {
        setStatus('error');
        setMessage('No CM93 cell was found for the current map centre at any available scale. Pan to another area and try again.');
        return;
      }
      setStatus('loading');
      setMessage('Decoding ' + (file.webkitRelativePath || file.name) + '…');
      const cell = parseCm93Cell(new Uint8Array(await file.arrayBuffer()), file.name);
      const result = cm93CellToGeoJSON(cell, dictionary);
      if (!map.isStyleLoaded()) await new Promise<void>((resolve) => map.once('load', resolve));
      for (const layerId of ['cm93-cell-labels', 'cm93-cell-depth-labels', 'cm93-cell-icons', 'cm93-cell-points', 'cm93-cell-lines', 'cm93-cell-fill']) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      if (map.getSource('cm93-active-cell')) map.removeSource('cm93-active-cell');
      map.addSource('cm93-active-cell', { type: 'geojson', data: result.geojson as never });
      map.addLayer({
        id: 'cm93-cell-fill', type: 'fill', source: 'cm93-active-cell',
        filter: ['all', ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]], ['in', ['get', 'cm93Class'], ['literal', ['DEPARE', 'DRGARE', 'LNDARE', 'UNSARE']]]],
        paint: {
          'fill-color': ['match', ['get', 'cm93Class'],
            'DEPARE', '#d5e8ec', 'DRGARE', '#d5e8ec', 'LNDARE', '#d9d6c8',
            'UNSARE', '#d5e8ec', '#e5e0cb'],
          'fill-opacity': 0.52, 'fill-opacity-transition': { duration: 180, delay: 0 },
        },
      });
      addCm93PortrayalLayers(map, 'cm93-active-cell', 'cm93-cell', visibleCm93PointClassesRef.current);



      const bounds = cell.metadata.geographicBounds;
      if (bounds.west <= bounds.east) {
        map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 40, maxZoom: 13, duration: 600 });
      }
      setFeatureCount(result.geojson.features.length);
      setCm93PointClassCounts([...result.geojson.features.reduce((counts, feature) => { if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint') { const name = String(feature.properties?.cm93Class ?? 'UNKNOWN'); counts.set(name, (counts.get(name) ?? 0) + (feature.geometry.type === 'MultiPoint' ? feature.geometry.coordinates.length : 1)); } return counts; }, new Map<string, number>())].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count));
      setChartName(file.name);
      setSource('CM93 V2 decoded cell');
      setStatus('ready');
      setMessage('Rendered ' + result.geojson.features.length + ' decoded features from ' + file.name +
        (result.omittedGeometryCount ? '; omitted ' + result.omittedGeometryCount + ' unsupported/invalid geometries' : '') +
        (result.warnings.length ? '; some attributes could not be decoded' : '') + '.');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not decode and render the CM93 cell.');
    }
  };

  const renderCm93Overview = async () => {
    const map = mapRef.current;
    const dictionary = cm93DictionaryRef.current;
    if (!map || !dictionary || !cm93Summary) {
      setStatus('error');
      setMessage('Select a valid CM93 V2 directory with both dictionaries first.');
      return;
    }

    // Use one coarse scale for the initial whole-dataset test. Combining all
    // scales would duplicate features and create a much larger map source.
    const scaleOrder = ['Z', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const getCellParts = (file: File) => {
      const path = file.webkitRelativePath || file.name;
      const parts = path.split('/');
      const filename = parts[parts.length - 1] || '';
      return {
        scale: (parts[parts.length - 2] || '').toUpperCase(),
        extension: filename.includes('.') ? filename.split('.').pop()!.toUpperCase() : '',
      };
    };
    const allCellFiles = cm93FilesRef.current.filter((file) => {
      const parts = getCellParts(file);
      return scaleOrder.includes(parts.scale) && parts.extension === parts.scale;
    });
    const scale = scaleOrder.find((code) => allCellFiles.some((file) => getCellParts(file).scale === code));
    if (!scale) {
      setStatus('error');
      setMessage('No CM93 chart-cell files were found in the selected directory.');
      return;
    }
    const files = allCellFiles.filter((file) => getCellParts(file).scale === scale)
      .sort((left, right) => (left.webkitRelativePath || left.name).localeCompare(right.webkitRelativePath || right.name));

    setStatus('loading');
    setChartName('CM93 dataset overview (' + scale + ' scale)');
    setSource('CM93 V2 dataset');
    setMessage('Rendering ' + files.length.toLocaleString() + ' cells at the coarsest available scale (' + scale + ')…');

    try {
      const features = [] as ReturnType<typeof cm93CellToGeoJSON>['geojson']['features'];
      let failed = 0;
      let omitted = 0;
      let west = Infinity;
      let south = Infinity;
      let east = -Infinity;
      let north = -Infinity;
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        try {
          const cell = parseCm93Cell(new Uint8Array(await file.arrayBuffer()), file.name);
          const result = cm93CellToGeoJSON(cell, dictionary);
          features.push(...result.geojson.features);
          omitted += result.omittedGeometryCount;
          west = Math.min(west, cell.metadata.geographicBounds.west);
          south = Math.min(south, cell.metadata.geographicBounds.south);
          east = Math.max(east, cell.metadata.geographicBounds.east);
          north = Math.max(north, cell.metadata.geographicBounds.north);
        } catch {
          failed++;
        }
        if ((index + 1) % 10 === 0 || index === files.length - 1) {
          setMessage('Rendering CM93 ' + scale + '-scale overview: ' + (index + 1) + '/' + files.length +
            ' cells processed, ' + features.length.toLocaleString() + ' features…');
        }
      }
      if (!Number.isFinite(west) || !Number.isFinite(south) || !Number.isFinite(east) || !Number.isFinite(north)) {
        throw new Error('No CM93 cells at this scale could be decoded.');
      }
      if (!map.isStyleLoaded()) await new Promise<void>((resolve) => map.once('load', resolve));
      for (const layerId of ['cm93-cell-labels', 'cm93-cell-depth-labels', 'cm93-cell-icons', 'cm93-cell-points', 'cm93-cell-lines', 'cm93-cell-fill']) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
      }
      if (map.getSource('cm93-active-cell')) map.removeSource('cm93-active-cell');
      map.addSource('cm93-active-cell', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features } as never,
      });
      map.addLayer({
        id: 'cm93-cell-fill', type: 'fill', source: 'cm93-active-cell',
        paint: {
          'fill-color': ['match', ['get', 'cm93Class'],
            'DEPARE', '#d5e8ec', 'DRGARE', '#d5e8ec', 'LNDARE', '#d9d6c8',
            'UNSARE', '#d5e8ec', '#e5e0cb'],
          'fill-opacity': 0.52,
        },
      });
      addCm93PortrayalLayers(map, 'cm93-active-cell', 'cm93-cell', visibleCm93PointClassesRef.current);



      map.fitBounds([[west, south], [east, north]], { padding: 40, maxZoom: 8, duration: 600 });
    const pointCounts = new Map<string, number>();
    for (const feature of features) { if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint') { const name = String(feature.properties?.cm93Class ?? 'UNKNOWN'); pointCounts.set(name, (pointCounts.get(name) ?? 0) + (feature.geometry.type === 'MultiPoint' ? feature.geometry.coordinates.length : 1)); } }
    setCm93PointClassCounts([...pointCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count));
      cm93OverviewScaleRef.current = scale;
      cm93AutoEnabledRef.current = true;
      setCm93AutoEnabled(true);
      setFeatureCount(features.length);
      setStatus('ready');
      setMessage('Rendered ' + features.length.toLocaleString() + ' features from ' + (files.length - failed) +
        '/' + files.length + ' CM93 ' + scale + '-scale cells.' +
        (failed ? ' ' + failed + ' cells failed to decode.' : '') +
        (omitted ? ' ' + omitted + ' unsupported/invalid geometries omitted.' : ''));
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not render the CM93 dataset overview.');
    }
  };


  const syncCm93Quilt = useCallback(async () => {
    const map = mapRef.current;
    const dictionary = cm93DictionaryRef.current;
    if (!cm93AutoEnabledRef.current || !map || !dictionary || !cm93FilesRef.current.length) return;

    const requestId = ++cm93QuiltRequestRef.current;
    const bounds = map.getBounds();
    const selection = selectCm93ViewportCells(cm93FilesRef.current, {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    }, map.getZoom(), 180);

    if (selection.files.length === 0) {
      clearCm93Quilt(map);
      setCm93QuiltStats({
        scale: selection.scale,
        cells: 0,
        features: 0,
        cached: cm93DecodedCacheRef.current.size,
        failed: 0,
        classes: [],
      });
      setStatus('ready');
      setMessage('Automatic CM93 detail: no cells at scale ' + selection.scale +
        ' or any coarser fallback scale cover this viewport.' +
        (map.getSource('cm93-active-cell') ? ' The overview remains visible.' : ' No CM93 coverage is available here.'));
      return;
    }

    setStatus('loading');
    setMessage('Loading CM93 ' + selection.scale + '-scale detail: ' + selection.files.length + ' viewport cells…');
    const features: ReturnType<typeof cm93CellToGeoJSON>['geojson']['features'] = [];
    let failed = 0;
    let decoded = 0;

    for (let index = 0; index < selection.files.length; index++) {
      if (requestId !== cm93QuiltRequestRef.current || !cm93AutoEnabledRef.current) return;
      const file = selection.files[index];
      const key = (file.webkitRelativePath || file.name).toLowerCase();
      let cellFeatures = cm93DecodedCacheRef.current.get(key);
      if (cellFeatures) {
        // Refresh insertion order for a small LRU-style cache.
        cm93DecodedCacheRef.current.delete(key);
        cm93DecodedCacheRef.current.set(key, cellFeatures);
      } else {
        try {
          const cell = parseCm93Cell(new Uint8Array(await file.arrayBuffer()), file.name);
          cellFeatures = cm93CellToGeoJSON(cell, dictionary).geojson.features;
          cm93DecodedCacheRef.current.set(key, cellFeatures);
          decoded++;
          while (cm93DecodedCacheRef.current.size > 240) {
            const oldest = cm93DecodedCacheRef.current.keys().next().value;
            if (oldest === undefined) break;
            cm93DecodedCacheRef.current.delete(oldest);
          }
        } catch {
          failed++;
          continue;
        }
      }
      if (!cellFeatures) continue;
      features.push(...cellFeatures);
      // Yield periodically so the UI can respond while a viewport quilt is built.
      if ((index + 1) % 3 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    if (requestId !== cm93QuiltRequestRef.current || !cm93AutoEnabledRef.current) return;
    // Never replace a valid quilt with a blank result while transitioning to a
    // scale whose selected cells contain no usable features. Keep the last good
    // portrayal until a useful quilt can be built.
    if (features.length === 0) {
      setStatus('ready');
      setMessage('No usable features at target scale ' + selection.scale + '. Keeping the previous chart coverage until useful detail is available.');
      return;
    }
    const data = { type: 'FeatureCollection', features } as never;
    const existingSource = map.getSource('cm93-quilt') as { setData?: (value: never) => void } | undefined;
    if (existingSource?.setData) {
      existingSource.setData(data);
    } else {
      clearCm93Quilt(map);
      map.addSource('cm93-quilt', { type: 'geojson', data, tolerance: 0.5, maxzoom: 14, buffer: 0 });
      map.addLayer({
        id: 'cm93-quilt-fill', type: 'fill', source: 'cm93-quilt',
        filter: ['all', ['in', ['geometry-type'], ['literal', ['Polygon', 'MultiPolygon']]], ['in', ['get', 'cm93Class'], ['literal', ['DEPARE', 'DRGARE', 'LNDARE', 'UNSARE']]]],
        paint: {
          'fill-color': ['match', ['get', 'cm93Class'],
            'DEPARE', '#d5e8ec', 'DRGARE', '#d5e8ec', 'LNDARE', '#d9d6c8',
            'UNSARE', '#d5e8ec', '#e5e0cb'],
          'fill-opacity': 0.52,
        },
      });
      addCm93PortrayalLayers(map, 'cm93-quilt', 'cm93-quilt', visibleCm93PointClassesRef.current);



    }

    // The quilt source now contains the finest available cell for each target
    // footprint, including coarser fallbacks. Remove the whole-dataset overview
    // only after this replacement is ready so the two sources never double-draw.
    for (const layerId of ['cm93-cell-labels', 'cm93-cell-depth-labels', 'cm93-cell-icons', 'cm93-cell-points', 'cm93-cell-lines', 'cm93-cell-fill']) {
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    }
    if (map.getSource('cm93-active-cell')) map.removeSource('cm93-active-cell');

    const scaleBreakdown = Object.entries(selection.scaleCounts)
      .filter((entry) => entry[1])
      .map(([scale, count]) => scale + ':' + count)
      .join(', ');
    const pointCounts = new Map<string, number>();
    for (const feature of features) { if (feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint') { const name = String(feature.properties?.cm93Class ?? 'UNKNOWN'); pointCounts.set(name, (pointCounts.get(name) ?? 0) + (feature.geometry.type === 'MultiPoint' ? feature.geometry.coordinates.length : 1)); } }
    setCm93PointClassCounts([...pointCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count));
    const classCounts = new Map<string, { count: number; geometries: Set<string> }>();
    for (const feature of features) {
      const className = String(feature.properties?.cm93Class ?? 'UNKNOWN');
      const entry = classCounts.get(className) ?? { count: 0, geometries: new Set<string>() };
      entry.count++;
      entry.geometries.add(feature.geometry.type);
      classCounts.set(className, entry);
    }
    const classSummary = [...classCounts.entries()]
      .sort((left, right) => right[1].count - left[1].count)
      .slice(0, 8)
      .map(([name, entry]) => name + ': ' + entry.count + ' (' + [...entry.geometries].join('/') + ')');
    setCm93QuiltStats({
      scale: selection.scale + ' target (' + (scaleBreakdown || 'no cells') + ')',
      cells: selection.files.length,
      features: features.length,
      cached: cm93DecodedCacheRef.current.size,
      failed,
      classes: classSummary,
    });
    setStatus('ready');
    setMessage('Automatic CM93 detail: ' + selection.files.length + ' ' + selection.scale +
      '-scale cells, ' + features.length.toLocaleString() + ' features (' + decoded +
      ' newly decoded, ' + (selection.files.length - decoded - failed) + ' from cache).' +
      (failed ? ' ' + failed + ' cells failed to decode.' : ''));
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !cm93AutoEnabled) return;
    const sync = () => void syncCm93Quilt();
    map.on('moveend', sync);
    sync();
    return () => { map.off('moveend', sync); };
  }, [cm93AutoEnabled, syncCm93Quilt]);

  const toggleCm93Auto = () => {
    const enabled = !cm93AutoEnabledRef.current;
    cm93AutoEnabledRef.current = enabled;
    setCm93AutoEnabled(enabled);
    if (!enabled) {
      cm93QuiltRequestRef.current++;
      if (mapRef.current) clearCm93Quilt(mapRef.current);
      setCm93QuiltStats(null);
      setMessage('Automatic CM93 detail loading disabled. The existing overview and manual cell rendering remain available.');
    } else {
      void syncCm93Quilt();
    }
  };

  const toggleCm93PointClass = (name: string) => {
    const next = visibleCm93PointClassesRef.current.includes(name) ? visibleCm93PointClassesRef.current.filter((item) => item !== name) : [...visibleCm93PointClassesRef.current, name];
    visibleCm93PointClassesRef.current = next; setVisibleCm93PointClasses(next);
    const map = mapRef.current; if (!map) return;
    for (const layerId of ['cm93-cell-icons', 'cm93-quilt-icons']) {
      if (map.getLayer(layerId)) map.setFilter(layerId, ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'cm93RelatedChild'], true], ['in', ['get', 'cm93Class'], ['literal', next]]]);
    }
    for (const layerId of ['cm93-cell-labels', 'cm93-quilt-labels']) {
      if (map.getLayer(layerId)) map.setFilter(layerId, ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'cm93RelatedChild'], true], ['in', ['get', 'cm93Class'], ['literal', cm93PointLabelClasses]], ['in', ['get', 'cm93Class'], ['literal', next]]]);
    }
  };

  const toggleCmapRaster = () => {
    const map = mapRef.current;
    if (!map || !cmapMetadata || !map.getLayer('cmap-raster-layer')) return;
    const nextVisible = !cmapVisible;
    map.setLayoutProperty('cmap-raster-layer', 'visibility', nextVisible ? 'visible' : 'none');
    setCmapVisible(nextVisible);
    if (nextVisible) {
      const [west, south, east, north] = cmapMetadata.bounds;
      map.fitBounds([[west, south], [east, north]], { padding: 36, maxZoom: 9, duration: 700 });
      setChartName(cmapMetadata.name || 'Portugal raster chart');
      setSource('MBTiles raster chart');
      setMessage('Raster chart tiles loaded from the optional MBTiles dataset.');
      setStatus('ready');
    } else {
      setMessage('Raster chart hidden. Vector ENC selection remains active.');
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">A</div>
        <div className="brand-copy"><strong>AZIMUTE ONE</strong><span>CHART ENGINE LAB</span></div>
        <div className="topbar-spacer" />
        <span className="environment-pill">PHASE 0 · PROTOTYPE</span>
      </header>
      <section className="workspace">
        <aside className="sidebar">
          <p className="eyebrow">VECTOR ENC EXPERIMENT</p>
          <h1>Chart rendering</h1>
          <p className="intro">A data-driven chart collection. The engine chooses a reference chart by display scale, plans a coarse coverage quilt with fallback charts, loads the required cells, and unloads cells that are no longer relevant.</p>
          <div className="status-card">
            <div className={`status-dot ${status}`} />
            <div><strong>{status === 'ready' ? 'Chart loaded' : status === 'error' ? 'Load failed' : status === 'loading' ? 'Loading chart' : 'Overview ready'}</strong><p>{message}</p></div>
          </div>
          <div className="metric-grid">
            <div className="metric"><span>VISIBLE CHARTS</span><strong>{selectedCharts.length}</strong></div>
            <div className="metric"><span>FEATURES</span><strong>{featureCount === null ? '—' : featureCount.toLocaleString()}</strong></div>
          </div>
          <div className="legend">
            <span className="field-label">CATALOGUE MATCHES</span>
            {selectedCharts.length ? <ul>{selectedCharts.map((title) => <li key={title}>{title}</li>)}</ul> : <p>No chart currently matches this viewport.</p>}
          </div>
          <label className="file-button"><span>Load ENC file</span><input type="file" accept=".000,.zip,application/zip,application/octet-stream" onChange={(event) => void onFile(event.target.files?.[0])} /></label>
          <label className="file-button"><span>Inspect CM93 V2 directory</span><input ref={cm93DirectoryInput} type="file" multiple onChange={(event) => onCm93Directory(event.target.files)} /></label>
          {cm93Summary?.isLikelyCm93V2 && <button className="secondary-button" type="button" onClick={() => void renderCm93CellAtMapCenter()}>Render CM93 cell at map centre</button>}
          {cm93Summary?.isLikelyCm93V2 && <button className="secondary-button" type="button" onClick={() => void renderCm93Overview()}>Render CM93 dataset overview</button>}
          {cm93Summary?.isLikelyCm93V2 && <button className="secondary-button" type="button" onClick={toggleCm93Auto}>{cm93AutoEnabled ? 'Disable automatic CM93 detail' : 'Enable automatic CM93 detail'}</button>}
          {cm93Summary && <div className="legend"><span className="field-label">CM93 POINT TYPES</span><p>Point symbols stay hidden until selected. At close zoom, available object names and light details are labelled.</p>{cm93PointClassCounts.length ? <ul>{cm93PointClassCounts.map(({ name, count }) => <li key={name}><label className="cm93-type-row"><input type="checkbox" checked={visibleCm93PointClasses.includes(name)} onChange={() => toggleCm93PointClass(name)} /><span className="cm93-type-icon">{cm93ClassIcon(name)}</span><span><strong>{name}</strong><small>{cm93ClassDescriptions[name] ?? 'CM93 object class; meaning not yet mapped.'}</small><small>{count.toLocaleString()} point(s)</small></span></label></li>)}</ul> : <p>Render a CM93 cell, overview or enable automatic detail to count point types in the active chart.</p>}
            <div className="cm93-glossary"><span className="field-label">QUICK ACRONYM GUIDE</span>{['DEPCNT','DEPARE','DRGARE','COALNE','LIGHTS','BOYLAT','BOYCAR','BOYISD','BCNLAT','BCNCAR','LNDMRK','WRECKS','UWTROC'].map((name) => <p key={name}><strong>{name}</strong> — {cm93ClassDescriptions[name]}</p>)}</div></div>}
          {cm93AutoEnabled && cm93QuiltStats && <div className="legend">
            <span className="field-label">AUTOMATIC CM93 VIEWPORT QUILT</span>
            <ul>
              <li>Target scale / actual cell mix: {cm93QuiltStats.scale}</li>
              <li>Viewport cells: {cm93QuiltStats.cells}</li>
              <li>Rendered features: {cm93QuiltStats.features.toLocaleString()}</li>
              <li>Decoded-cell cache: {cm93QuiltStats.cached} cells</li>
              {cm93QuiltStats.failed > 0 && <li>Decode failures: {cm93QuiltStats.failed}</li>}
              {cm93QuiltStats.classes.length > 0 && <li>Most common classes: {cm93QuiltStats.classes.join('; ')}</li>}
            </ul>
          </div>}
          {cm93Summary && <div className="legend cm93-summary">
            <span className="field-label">CM93 DATASET INVENTORY</span>
            <ul>
              <li>{cm93Summary.isLikelyCm93V2 ? 'CM93 V2 structure recognized' : 'CM93 V2 structure not fully recognized'}</li>
              <li>{cm93Summary.fileCount.toLocaleString()} files · {cm93Summary.regionCount} region folders</li>
              <li>Edition marker(s): {cm93Summary.editionDates.length ? cm93Summary.editionDates.join(', ') : 'not found'}</li>
              <li>Scales: {cm93Summary.scales.map((scale) => `${scale.code} (${scale.fileCount.toLocaleString()} files)`).join(', ') || 'none found'}</li>
              <li>Object dictionary: {cm93Summary.hasObjectDictionary ? 'found' : 'missing'}</li>
              <li>Attribute dictionary: {cm93Summary.hasAttributeDictionary ? 'found' : 'missing'}</li>
              {cm93DictionaryStats && <li>Parsed dictionaries: {cm93DictionaryStats.objects.toLocaleString()} object classes · {cm93DictionaryStats.attributes.toLocaleString()} attributes</li>}
            </ul>
            {cm93Summary.warnings.length > 0 && <p>{cm93Summary.warnings.join(' ')}</p>}
            <p>Independent byte substitution and cell-header validation are implemented. A sample of up to 12 real cells is checked for consistent header and table boundaries. Geometry is kept as separate connected paths; class-aware styling is preliminary and full nautical portrayal remains outstanding.</p>
            {cm93CellStats && <ul>
              <li>Cell record parsing: {cm93CellStats.valid}/{cm93CellStats.checked} passed</li>
              <li>Sample totals: {cm93CellStats.features.toLocaleString()} feature records · {cm93CellStats.vectors.toLocaleString()} vector records · {cm93CellStats.vectorPoints.toLocaleString()} vector points</li>
              {cm93CellStats.classes.length > 0 && <li>Object classes: {cm93CellStats.classes.join(', ')}</li>}
              {cm93CellStats.attributes.length > 0 && <li>Decoded attributes: {cm93CellStats.attributes.join(', ')}</li>}
              {cm93CellStats.example && <li>Example {cm93CellStats.example.name}: bounds [{cm93CellStats.example.bounds}], {cm93CellStats.example.featureCount} features, {cm93CellStats.example.vectorRecordCount} vectors / {cm93CellStats.example.vectorPointCount} points, {cm93CellStats.example.point2dCount} 2D points; header {cm93CellStats.example.headerLength} bytes, tables {cm93CellStats.example.table1Length.toLocaleString()} + {cm93CellStats.example.table2Length.toLocaleString()} bytes</li>}
              {cm93CellStats.failures.map((failure) => <li key={failure}>{failure}</li>)}
            </ul>}
          </div>}
          {cmapMetadata && <button className="secondary-button" type="button" onClick={toggleCmapRaster}>{cmapVisible ? 'Hide Portugal raster chart' : 'Show Portugal raster chart'}</button>}
          <div className="legend">
            <span className="field-label">WHAT TO INSPECT</span>
            <ul><li>Pan between chart coverage areas</li><li>Zoom through different scale ranges</li><li>Observe the reference chart and fallback coverage cells</li><li>Check that off-screen chart layers are unloaded</li></ul>
          </div>
          <div className="warning-note"><strong>Not for navigation</strong><p>Experimental portrayal only. Do not use for real-world navigation or safety decisions.</p></div>
        </aside>
        <section className="chart-panel">
          <div className="chart-toolbar"><div><span className="eyebrow">REFERENCE SCALE + COVERAGE QUILT PLAN</span><strong>{chartName}</strong></div><span className="source-label">{source}</span></div>
          <div className="map-wrap" ref={mapContainer} />
          <div className="map-footer"><span>Natural Earth overview + dynamically selected S-57 layers</span><span>Chart definitions: src/chart-catalog.ts</span></div>
        </section>
      </section>
    </main>
  );
}
