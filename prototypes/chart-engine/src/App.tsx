import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { addChartLayers, removeChart } from '@s57-parser/maplibre';
import { parseS57, toGeoJSON } from '@s57-parser/s57';
import { unzipSync } from 'fflate';
import { chartCatalog, zoomForChartScale, type ChartDefinition } from './chart-catalog';
import { planChartQuilt } from './chart-quilt';

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

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
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
        'sample-chart-chs.zip': '/chs-sample',
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
