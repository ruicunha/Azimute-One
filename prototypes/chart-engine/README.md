# Chart-engine proof of concept: viewport-driven NOAA S-57 + MapLibre

This is an isolated Phase 0 experiment. It demonstrates chart selection from a collection of chart definitions, rather than hard-coded area/zoom logic.

## What it tests

- Show a lightweight global land overview using Natural Earth data.
- Maintain a chart collection in `src/chart-catalog.ts`. Each record describes an asset, geographic coverage, and the zoom range for which it is suitable.
- Select every chart whose coverage intersects the current viewport and whose scale range matches the current zoom.
- Load matching cells dynamically, including multiple cells when the viewport intersects more than one chart.
- Unload chart layers and their data when they are no longer selected.
- Parse S-57 cells in the browser using `@s57-parser/s57` and render features through MapLibre GeoJSON sources/layers.
- Load a local `.000` cell or exchange-set ZIP for manual inspection.

## How selection works

The generic selector in `src/chart-catalog.ts` evaluates each chart's `coverage`, `minZoom`, and `maxZoom` metadata against the viewport and current zoom. The application does not contain Boston-specific selection conditions. The two Boston entries are just sample records/assets to exercise overlapping coverage and different scales; adding another chart means adding a catalogue record, not changing the selection algorithm.

Coverage bounds and zoom ranges are explicit prototype metadata. They are not yet extracted automatically from ENC metadata. A next step could populate the catalogue from chart metadata or an index generated from an ENC collection.

The global Natural Earth layer is only an overview and is not an ENC.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
cd prototypes/chart-engine
npm install
npm run dev
```

Open the local URL printed by Vite. The hosted demo downloads the two sample chart ZIPs during the Pages build. Local ENC files can be selected with **Load ENC file**.

## GitHub Pages demo

The GitHub Actions workflow builds this prototype and downloads the sample NOAA ZIPs into the generated static site. After GitHub Pages is configured to use **GitHub Actions** in repository Settings → Pages, pushes to `poc/chart-engine-noaa-enc` deploy the demo at:

https://ruicunha.github.io/Azimute-One/

## Sample chart collection

- `US1GC09M` — NOAA small-scale ENC, configured for low zoom over the Gulf of Mexico.
- `US5MA12M` — NOAA Boston Harbor.
- `US5MA11M` — NOAA Boston Inner Harbor, configured for a closer zoom range.
- `9995_S57ENC.zip` — Canadian Hydrographic Service fictitious training ENC.
- `US4NY13M` — New York approaches candidate (configured at 1:80,000).
- `US5NY14M` — New York Harbor candidate (configured at 1:20,000).
- NOAA source: https://charts.noaa.gov/ENCs/ENCs.shtml
- CHS training sample: https://www.chs.gc.ca/documents/charts-cartes/instruction-formation/9995_S57ENC.zip

All six entries are evaluated by the same viewport selector. The New York charts are candidates for a same-area/different-scale test. Their current footprints and zoom ranges are proof-of-concept metadata; the CHS sample uses a deliberately broad Canadian extent. They should be replaced with accurate per-cell coverage and compilation scale metadata (ideally generated from the chart collection) before any serious use.

## Known limitations

- This is a technology spike, not a complete chartplotter.
- The upstream S-57 portrayal is simplified and not approved for primary navigation.
- The sample collection includes Boston, New York candidate charts, a Gulf overview, and a CHS training ENC; it is not a global ENC collection.
- Catalogue metadata is currently maintained explicitly in TypeScript, not extracted from the ENC files.
- No ENC updates, S-63 support, chart quilting rules, safety contour configuration, route planning, AIS, or alarm logic.
- Compare the rendered result against OpenCPN with the same ENC and record portrayal differences.

## Dependencies

- MapLibre GL JS: BSD-3-Clause
- `@s57-parser/*`: MIT
- `fflate`: MIT
