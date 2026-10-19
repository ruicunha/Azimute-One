# Azimute One — Roadmap

**Status:** Proposed  
**Current stage:** Discovery and feasibility  
**Guiding constraint:** Do not create the application skeleton until Phase 0 has produced evidence-backed chart and integration decisions.

This roadmap is deliberately milestone-based rather than date-based. The chart engine, chart licensing, integration reuse, and target-hardware performance are not yet known well enough to make credible calendar estimates.

## Product priorities

1. **Let existing OpenCPN users bring their charts.** Compatibility with existing chart collections is a key adoption requirement. Reuse chart directories wherever possible, avoid needless conversion or duplication, and clearly explain unsupported formats.
2. **Reuse proven marine integrations.** Prefer existing Signal K integrations and protocol adapters; inspect OpenCPN plugins and their underlying source for reusable drivers, protocol handling, algorithms, and simulators.
3. **Make development possible without all the hardware.** Each integration should have a documented test strategy using unit tests, recorded data, protocol replay, mocks, or simulators. Identify hardware-only validation explicitly.
4. **Support ARM64 and x86-64 from the outset.** Raspberry Pi 5 is the primary appliance target, but conventional x86-64 Linux systems must also run the same product. Validate chart-engine dependencies, performance, and packaging on both architectures early.
5. **Validate on the target appliance early.** Raspberry Pi 5 performance, storage, display usability, and offline operation are engineering constraints, not final polish.
6. **Treat navigation safety and licensing as release gates.** Do not claim support or safety guarantees that have not been tested; do not assume chart data or third-party code is free to reuse.

## Phase 0 — Chart and integration feasibility

### Work
- Build a chart compatibility matrix covering priority OpenCPN chart formats and chart sources.
- Test representative real datasets, including raster charts and S-57 ENC with the required S-52 portrayal path.
- Investigate OpenCPN chart-engine reuse, plugin dependencies, licences, and feasibility on Raspberry Pi 5 / ARM64 and x86-64/AMD64.
- Record architecture support for each reused library, plugin-derived integration, native dependency, and vendor SDK; identify any ARM-only or x86-only blockers.
- Decide on a common packaging strategy, including whether native components need separate ARM64 and AMD64 artifacts.
- Evaluate legacy, proprietary, encrypted, and vendor-dependent chart sources individually, including CM93, S-63, O-Charts, NV, and other sources identified during research.
- Determine whether Azimute One can index existing chart directories without copying or converting the data.
- Build an integration inventory for Signal K, NMEA 0183, NMEA 2000, AIS, GNSS, heading/depth/wind instruments, legacy SeaTalk, autopilot, radar, and other high-value candidates.
- For each integration, record supported hardware/models, source availability, licence, dependencies, simulator/replay/test fixtures, and whether real hardware is required.
- Benchmark chart rendering, memory, startup, and replay of representative marine data on Raspberry Pi 5 and at least one x86-64 Linux system.
- Capture decisions and rejected alternatives in Architecture Decision Records.

### Exit criteria
- A working chart proof of concept on Raspberry Pi 5 and x86-64 Linux.
- A documented ARM64/AMD64 dependency and packaging matrix.
- A chart compatibility matrix with an explicit status and rationale for each priority format/source.
- A selected chart architecture that supports multiple providers where needed.
- An integration feasibility inventory identifying reuse opportunities and hardware/test gaps.
- Licensing and vendor restrictions documented before implementation commitments.
- A decision to proceed, narrow scope, or revisit the architecture before creating the application skeleton.

## Phase 1 — Touchscreen UI foundation

- Establish the application workspace only after Phase 0.
- Implement the touchscreen-first shell and chart viewport using the selected chart approach.
- Show a simulated vessel position, basic overlays, pan/zoom, recentering, and day/night presentation.
- Add a chart catalogue/import flow that references existing chart locations where feasible.
- Make unsupported formats, chart coverage gaps, and load failures visible.

**Exit criteria:** usable chart-centred UI on target hardware, with the agreed first-release chart formats loading from local storage.

## Phase 2 — Marine data and integration test harness

- Connect to Signal K as the preferred normalized marine-data interface.
- Display available GNSS position, SOG/COG, heading, depth, wind, AIS, and relevant device status.
- Preserve source, timestamps, validity, and freshness where available.
- Implement recorded-data replay and synthetic fixtures for repeatable tests.
- Add reconnect, stale-data, malformed-input, and sensor-loss tests.
- Add direct adapters only where a required integration is not adequately served by Signal K and the reuse case justifies it.

**Exit criteria:** core instrument displays work offline with replay/simulated data, and failure states are clearly represented.

## Phase 3 — Navigation features and chart coverage

- Add routes, waypoints, track recording, distance/bearing, cross-track error, and ETA.
- Implement selected alarms with explicit limits and validation.
- Expand chart-format coverage according to the approved compatibility matrix.
- Validate portrayal, coordinate handling, chart boundaries, scale-dependent display, and relevant safety-related chart features.
- Test with independent geographic references and documented scenarios.
- Add supported autopilot/radar integrations only after their interfaces, licensing, and test strategy are established.

**Exit criteria:** agreed navigation workflows pass deterministic tests, chart support claims match validated behaviour, and hardware-only gaps remain documented.

## Phase 4 — Appliance hardening

- Produce a reproducible Raspberry Pi OS image and kiosk experience for ARM64.
- Provide a supported x86-64 Linux installation/package or container path with the same core functionality.
- Add first-run setup, diagnostics, backup/restore, and persistent chart/user-data management.
- Implement controlled updates, health checks, and rollback.
- Validate interrupted updates, abrupt power loss, low storage, temperature, and long-duration operation.
- Document installation, chart import, supported hardware, limitations, and recovery procedures.

**Exit criteria:** repeatable installation and recovery on target hardware, with documented operational limitations.

## Ongoing work — Compatibility and maintenance

- Track upstream changes in Signal K, OpenCPN, reused libraries, and chart-provider projects.
- Re-run compatibility tests when dependencies or chart engines change.
- Run CI and release smoke tests on both ARM64 and x86-64/AMD64.
- Accept new chart formats and hardware integrations through the same feasibility checklist.
- Maintain a clear distinction between tested support, experimental support, and unsupported formats/devices.

## Release gates

No release should claim a chart format or hardware integration is supported solely because an upstream project lists it. Support requires a documented test path, licence/vendor review, and validation appropriate to the feature. Autopilot and other control integrations require additional safety-focused testing; software simulation alone is not sufficient for real-world safety claims.

See the [Architecture Vision](architecture/vision.md) for the proposed component boundaries, candidate technologies, and conceptual deployment.
