# Chart-engine proof of concept: NOAA S-57 + MapLibre

This is a deliberately isolated Phase 0 experiment. It does not create the Azimute One application skeleton.

## What it tests

- Load a real NOAA S-57 ENC exchange set (Boston Harbor, cell `US5MA12M`) from the official NOAA chart download endpoint.
- Parse the S-57 cell in the browser using `@s57-parser/s57`.
- Render through MapLibre GL JS with `@s57-parser/maplibre`, including its experimental S-52-style canvas overlay.
- Pan/zoom, inspect the number of parsed features, and load another locally downloaded `.000` cell or NOAA ZIP file.

The viewer is a feasibility prototype only. The upstream parser explicitly states that its portrayal is not a type-approved ECDIS renderer and is not suitable for primary navigation.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
cd prototypes/chart-engine
npm install
npm run dev
```

Open the local URL printed by Vite. The app automatically loads NOAA cell `US5MA12M` through a development-server proxy. The first load needs internet access.

You can also use **Load ENC file** to select a local NOAA exchange-set ZIP or an extracted `.000` file. For a ZIP, the app selects the first `.000` cell it finds. This allows testing with other cells without changing code.

To make a production build:

```bash
npm run build
npm run preview
```

The NOAA proxy exists only in the Vite development server; the production build is not a deployed offline appliance. For offline testing, use the local-file loader.

## Test chart

- NOAA chart cell: `US5MA12M` (Boston Harbor).
- Official source: https://charts.noaa.gov/ENCs/ENCs.shtml
- The chart is fetched at runtime rather than committed to this repository.

## Known limitations / evaluation questions

- This is a technology spike, not a complete chartplotter.
- The S-52-style rendering in the upstream package is simplified and explicitly not approved for primary navigation.
- S-63 encrypted cells are not supported by the upstream parser.
- This POC does not yet implement chart updates, scale-dependent cell selection, chart quilting, safety contour configuration, route planning, AIS, or alarm logic.
- Compare the rendered result against OpenCPN with the same ENC. Record missing symbols, labels, depth portrayal, update handling, and performance.
- MapLibre's own vector rendering and the S-52-style canvas overlay are separate paths; test them independently if the combined rendering has issues.

## Dependencies

- MapLibre GL JS: BSD-3-Clause
- `@s57-parser/*`: MIT
- `fflate`: MIT
