# Chart-engine proof of concept: viewport-driven NOAA S-57 + MapLibre

This is an isolated Phase 0 experiment. It demonstrates chart selection from a collection of chart definitions, rather than hard-coded area/zoom logic.

## What it tests

- Show a lightweight global land overview using Natural Earth data.
- Maintain a chart collection in `src/chart-catalog.ts`. Each record describes an asset, geographic coverage, and ENC compilation scale.
- Choose a reference chart from viewport-centre coverage and approximate display scale.
- Plan a coarse spatial quilt: use the reference chart where it covers the viewport samples and choose scale-appropriate fallback charts for uncovered samples.
- Load the unique chart cells required by that quilt plan, including charts outside the reference chart's footprint.
- Unload chart layers and their data when they are no longer selected.
- Parse S-57 cells in the browser using `@s57-parser/s57` and render features through MapLibre GeoJSON sources/layers.
- Load a local `.000` cell or exchange-set ZIP for manual inspection.

## How selection works

`src/chart-quilt.ts` first chooses a reference chart that covers the viewport centre and best matches the approximate display scale. It then samples a 7×7 grid across the viewport. Each sample uses the reference chart when covered, otherwise it assigns the scale-appropriate chart that covers that location. The engine loads the union of charts assigned across the grid, so smaller-scale fallback charts can remain selected where detailed charts do not cover the whole view. The scale estimate comes from `zoomForChartScale` in `src/chart-catalog.ts`.

The display-scale calculation assumes 96 CSS DPI and is an approximation, not a calibrated physical scale. Coverage is currently represented by approximate catalogue bounding boxes, and the quilt plan uses grid samples rather than exact coverage polygons. The current MapLibre renderer still draws each selected chart's full GeoJSON layer; it does not clip each chart to its assigned quilt region, so overlapping features can still be duplicated. A complete quilt requires real ENC coverage polygons and per-chart portrayal clipping/masking, plus validated metadata extracted from the ENC cells.

The global Natural Earth layer is only an overview and is not an ENC.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
cd prototypes/chart-engine
npm install
npm run dev
```

Open the local URL printed by Vite. The hosted demo downloads sample NOAA ENC ZIPs during the Pages build. Local ENC files can be selected with **Load ENC file**. An optional MBTiles raster chart can also be converted into static XYZ PNG tiles and deployed alongside the ENC charts.

## GitHub Pages demo

The GitHub Actions workflow builds this prototype and downloads the sample NOAA ZIPs into the generated static site. After GitHub Pages is configured to use **GitHub Actions** in repository Settings → Pages, pushes to `main` deploy the demo at:

https://ruicunha.github.io/Azimute-One/

## Optional MBTiles raster charts

The renderer can display raster charts stored in an MBTiles SQLite database. During the Pages build, `scripts/mbtiles_to_tiles.py` extracts the tile blobs, converts MBTiles TMS row numbering to MapLibre XYZ numbering, and writes `public/cmap-tiles/{z}/{x}/{y}.png` plus `metadata.json`. If metadata is present, the UI exposes a **Show Portugal raster chart** toggle.

To include a raster chart in the hosted demo:

1. Ensure you have permission to download, convert, and publicly redistribute the chart tiles. A successful render or public download URL does not grant redistribution rights.
2. Host an authorized ZIP archive containing an `.mbtiles` database at a direct download URL.
3. Add a repository Actions secret named `CMAP_MBTILES_URL` containing that direct URL (Repository Settings → Secrets and variables → Actions).
4. Re-run the **Deploy chart-engine prototype to GitHub Pages** workflow.

When the secret is absent, the build skips the optional raster dataset and deploys the existing ENC demo as usual. The raster chart is published as individual PNG tiles, so the deployed site will contain the extracted tile data, not just the ZIP. For large datasets this increases deployment size substantially. The source must be a ZIP containing an MBTiles/SQLite database; raw proprietary C-MAP/ Navionics chart formats are not supported by this conversion script.

The Portuguese C-MAP archive used during development was rendered locally, but is not configured for public deployment until redistribution rights are confirmed.

## Sample chart collection

- `US1GC09M` — NOAA small-scale ENC, configured with a 1:1,200,000 compilation-scale estimate.
- `US5MA12M` — NOAA Boston Harbor.
- `US5MA11M` — NOAA Boston Inner Harbor, configured with a 1:5,000 compilation-scale estimate.
- `US4NY13M` — New York approaches candidate (configured at 1:80,000).
- `US5NY14M` — New York Harbor candidate (configured at 1:20,000).
- NOAA source: https://charts.noaa.gov/ENCs/ENCs.shtml

All five entries are evaluated by the same viewport selector. The New York charts are candidates for a same-area/different-scale test. Their current footprints and compilation scales are proof-of-concept metadata. They should be replaced with accurate per-cell coverage and compilation scale metadata (ideally generated from the chart collection) before any serious use.

## Known limitations

- This is a technology spike, not a complete chartplotter.
- The upstream S-57 portrayal is simplified and not approved for primary navigation.
- The sample collection includes Boston, New York candidate charts, and a Gulf overview; it is not a global ENC collection.
- Catalogue metadata is currently maintained explicitly in TypeScript, not extracted from the ENC files.
- Quilting is currently a coarse selection plan, not full OpenCPN-style per-area portrayal clipping. No ENC updates, S-63 support, safety contour configuration, route planning, AIS, or alarm logic.
- Compare the rendered result against OpenCPN with the same ENC and record portrayal differences.

## Dependencies

- MapLibre GL JS: BSD-3-Clause
- `@s57-parser/*`: MIT
- `fflate`: MIT
