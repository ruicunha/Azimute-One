# CM93 polygon clipping benchmark

This benchmark is isolated from the application build and deployment. Run it manually from GitHub Actions using **CM93 polygon clipping benchmark**.

It downloads the public `cm93_200705_Small.zip` sample, uses the existing CM93 decoder and viewport cell selection, builds the current coverage quilt, and benchmarks the current `polygon-clipping` library against `martinez-polygon-clipping@0.9.0` for the same polygon features and effective per-scale coverage. The JSON report records the resolved versions of both libraries.

The report includes:
- exact viewport and selected scale/cell mix;
- decode and quilt metrics;
- repeated clipping timings and median speedup;
- clipping errors and empty outputs;
- symmetric-difference area checks for the resulting geometries.

The alternative library is installed only in the ephemeral Actions runner and is not added to application dependencies. No chart-engine bundle is built and no deployment is triggered by this workflow.

The benchmark is a decision aid, not an automatic replacement. Any nonzero geometry differences or clipping errors must be investigated before considering a production change.
