import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { addChartLayers, removeChart } from '@s57-parser/maplibre';
import { parseS57, toGeoJSON } from '@s57-parser/s57';
import { unzipSync } from 'fflate';

type Status = 'loading' | 'ready' | 'error' | 'idle';

const emptyStyle: maplibregl.StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'water-background',
      type: 'background',
      paint: { 'background-color': '#b9dce5' },
    },
  ],
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function findCell(bytes: Uint8Array, filename: string): { name: string; bytes: Uint8Array } {
  if (filename.toLowerCase().endsWith('.000')) {
    return { name: filename, bytes };
  }

  const entries = unzipSync(bytes);
  const cellEntry = Object.entries(entries).find(([name]) => name.toLowerCase().endsWith('.000'));
  if (!cellEntry) {
    throw new Error('No .000 S-57 cell was found in that ZIP. Select an ENC exchange-set ZIP or a .000 file.');
  }
  return { name: cellEntry[0].split('/').pop() ?? cellEntry[0], bytes: cellEntry[1] };
}

export default function App() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('World overview ready. Zoom into Boston to load the detailed NOAA ENC automatically.');
  const [chartName, setChartName] = useState('World overview');
  const [featureCount, setFeatureCount] = useState<number | null>(null);
  const [source, setSource] = useState('Natural Earth overview');
  const autoLoadAttempted = useRef(false);

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
      // Lightweight, low-resolution land polygons provide a global overview.
      // This is not an ENC; detailed S-57 coverage is loaded separately by scale/area.
      map.addSource('world-land', {
        type: 'geojson',
        data: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson',
      });
      map.addLayer({
        id: 'world-land-fill',
        type: 'fill',
        source: 'world-land',
        paint: { 'fill-color': '#d9d6c8' },
      });
      map.addLayer({
        id: 'world-land-outline',
        type: 'line',
        source: 'world-land',
        paint: { 'line-color': '#9caa9d', 'line-width': 0.7 },
      });
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'nautical' as never }), 'bottom-left');
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const renderCell = useCallback(async (input: Uint8Array, filename: string, sourceLabel: string) => {
    const map = mapRef.current;
    if (!map) throw new Error('Map is not ready yet.');

    setStatus('loading');
    setMessage('Parsing S-57 cell…');

    const cell = findCell(input, filename);
    const buffer = toArrayBuffer(cell.bytes);
    if (!map.isStyleLoaded()) {
      await new Promise<void>((resolve) => map.once('load', () => resolve()));
    }

    // Convert the cell once and feed MapLibre directly. The upstream addChartSource()
    // repeats an O(n²) feature lookup to copy attributes that toGeoJSON() already adds;
    // on larger ENC cells that needlessly blocks the main thread.
    const dataset = parseS57(buffer);
    const geojson = toGeoJSON(dataset);

    removeChart(map, 'enc');
    map.addSource('enc', {
      type: 'geojson',
      data: geojson as never,
      // Simplify geometry slightly and stop generating increasingly detailed
      // source tiles beyond this zoom; MapLibre can overzoom these tiles.
      tolerance: 1,
      maxzoom: 14,
      buffer: 0,
    });
    addChartLayers(map, 'enc');
    map.fitBounds(
      [[-71.08, 42.21], [-70.73, 42.34]],
      { padding: 36, maxZoom: 13, duration: 0 },
    );

    setChartName(cell.name);
    setFeatureCount(null);
    setSource(sourceLabel);
    setStatus('ready');
    setMessage('ENC loaded. ENC loaded. Pan and zoom to explore the chart.');
  }, []);

  const loadSample = useCallback(async () => {
    try {
      setStatus('loading');
      setMessage('Loading NOAA test chart…');
      // GitHub Pages is static, so the workflow places the sample ZIP in public/.
      // Local development uses Vite's proxy to avoid cross-origin restrictions.
      const chartUrl = import.meta.env.DEV ? '/noaa-chart' : `${import.meta.env.BASE_URL}sample-chart.zip`;
      const response = await fetch(chartUrl);
      if (!response.ok) throw new Error(`NOAA chart download failed (HTTP ${response.status}).`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      await renderCell(bytes, 'US5MA12M.zip', import.meta.env.DEV ? 'Official NOAA ENC download' : 'Bundled NOAA sample');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not load the NOAA chart.');
    }
  }, [renderCell]);



  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMoveEnd = () => {
      if (autoLoadAttempted.current || status === 'loading' || status === 'ready') return;
      const center = map.getCenter();
      // This proof of concept currently has one detailed ENC cell (Boston Harbor).
      // Trigger it only when the user zooms into its region; elsewhere keep the overview.
      if (map.getZoom() >= 5 && center.lng >= -85 && center.lng <= -55 && center.lat >= 25 && center.lat <= 50) {
        autoLoadAttempted.current = true;
        void loadSample();
      }
    };

    map.on('moveend', onMoveEnd);
    return () => {
      map.off('moveend', onMoveEnd);
    };
  }, [loadSample, status]);

  const onFile = async (file?: File) => {
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await renderCell(bytes, file.name, 'Local file');
    } catch (error) {
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'Could not parse this ENC file.');
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">A</div>
        <div className="brand-copy">
          <strong>AZIMUTE ONE</strong>
          <span>CHART ENGINE LAB</span>
        </div>
        <div className="topbar-spacer" />
        <span className="environment-pill">PHASE 0 · PROTOTYPE</span>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <p className="eyebrow">VECTOR ENC EXPERIMENT</p>
          <h1>Chart rendering</h1>
          <p className="intro">A global overview with automatic loading of a detailed S-57 ENC when zooming into its coverage area.</p>

          <div className="status-card">
            <div className={`status-dot ${status}`} />
            <div>
              <strong>{status === 'ready' ? 'Chart loaded' : status === 'error' ? 'Load failed' : status === 'loading' ? 'Loading chart' : 'Waiting'}</strong>
              <p>{message}</p>
            </div>
          </div>

          <div className="metric-grid">
            <div className="metric">
              <span>ENC CELL</span>
              <strong>{chartName}</strong>
            </div>
            <div className="metric">
              <span>FEATURES</span>
              <strong>{featureCount === null ? '—' : featureCount.toLocaleString()}</strong>
            </div>
          </div>

          <label className="file-button">
            <span>Load ENC file</span>
            <input
              type="file"
              accept=".000,.zip,application/zip,application/octet-stream"
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
          </label>
          <button className="secondary-button" onClick={() => void loadSample()} disabled={status === 'loading'}>
            Load NOAA sample
          </button>

          <div className="legend">
            <span className="field-label">WHAT TO INSPECT</span>
            <ul>
              <li>Coastline and land/water boundary</li>
              <li>Depth areas, contours and soundings</li>
              <li>Buoys, lights and navigation marks</li>
              <li>Labels while panning and zooming</li>
            </ul>
          </div>

          <div className="warning-note">
            <strong>Not for navigation</strong>
            <p>Experimental portrayal only. Do not use for real-world navigation or safety decisions.</p>
          </div>
        </aside>

        <section className="chart-panel">
          <div className="chart-toolbar">
            <div>
              <span className="eyebrow">GLOBAL OVERVIEW · S-57 DETAIL</span>
              <strong>{chartName}</strong>
            </div>
            <span className="source-label">{source}</span>
          </div>
          <div className="map-wrap" ref={mapContainer} />
          <div className="map-footer">
            <span>Natural Earth overview + MapLibre S-57 layers</span>
            <span>Detailed ENC coverage: Boston Harbor only</span>
          </div>
        </section>
      </section>
    </main>
  );
}
