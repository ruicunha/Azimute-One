import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MapLibreMap } from 'maplibre-gl';
import { addChartSource, S57CanvasLayer } from '@s57-parser/maplibre';
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
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState('Starting chart viewer…');
  const [chartName, setChartName] = useState('NOAA US5MA12M');
  const [featureCount, setFeatureCount] = useState<number | null>(null);
  const [source, setSource] = useState('NOAA sample');
  const layerRef = useRef<S57CanvasLayer | null>(null);

  useEffect(() => {
    if (!mapContainer.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: emptyStyle,
      center: [-70.95, 42.28],
      zoom: 10,
      minZoom: 3,
      maxZoom: 18,
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
    const dataset = parseS57(buffer);

    if (!map.isStyleLoaded()) {
      await new Promise<void>((resolve) => map.once('load', () => resolve()));
    }

    if (layerRef.current && map.getLayer('enc-s52-overlay')) {
      map.removeLayer('enc-s52-overlay');
    }
    layerRef.current = null;

    if (map.getSource('enc')) {
      for (const layer of map.getStyle().layers ?? []) {
        if (layer.id.startsWith('enc')) map.removeLayer(layer.id);
      }
      map.removeSource('enc');
    }

    addChartSource(map, buffer, { sourceId: 'enc' });
    const overlay = new S57CanvasLayer('enc-s52-overlay', buffer);
    layerRef.current = overlay;
    map.addLayer(overlay);

    const geojson = toGeoJSON(dataset);
    // Keep only the bounds while traversing coordinates. Storing every position
    // and spreading the resulting arrays into Math.min/max can exceed the JS
    // argument limit on real ENC cells with large geometries.
    let minLongitude = Infinity;
    let minLatitude = Infinity;
    let maxLongitude = -Infinity;
    let maxLatitude = -Infinity;

    const collectBounds = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
        minLongitude = Math.min(minLongitude, value[0]);
        minLatitude = Math.min(minLatitude, value[1]);
        maxLongitude = Math.max(maxLongitude, value[0]);
        maxLatitude = Math.max(maxLatitude, value[1]);
        return;
      }
      value.forEach(collectBounds);
    };

    geojson.features.forEach((feature) => {
      if (feature.geometry && 'coordinates' in feature.geometry) {
        collectBounds(feature.geometry.coordinates);
      }
    });

    if (Number.isFinite(minLongitude) && Number.isFinite(minLatitude)) {
      map.fitBounds(
        [[minLongitude, minLatitude], [maxLongitude, maxLatitude]],
        { padding: 60, maxZoom: 13, duration: 500 },
      );
    }

    setChartName(cell.name);
    setFeatureCount(dataset.features.length);
    setSource(sourceLabel);
    setStatus('ready');
    setMessage('ENC loaded. Pan and zoom to explore the chart.');
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
    const timer = window.setTimeout(() => void loadSample(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSample]);

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
          <p className="intro">A focused test of MapLibre GL JS with an S-57 chart and experimental S-52-style portrayal.</p>

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
            Reload NOAA sample
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
              <span className="eyebrow">NOAA · S-57 ENC</span>
              <strong>{chartName}</strong>
            </div>
            <span className="source-label">{source}</span>
          </div>
          <div className="map-wrap" ref={mapContainer} />
          <div className="map-footer">
            <span>MapLibre GL JS + @s57-parser/maplibre</span>
            <span>Test area: Boston Harbor, Massachusetts</span>
          </div>
        </section>
      </section>
    </main>
  );
}
