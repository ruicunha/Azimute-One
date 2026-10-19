# Azimute One

**Your course. Your instruments. Your sea.**

Azimute One is a proposed open-source marine navigation platform that brings charts, navigation instruments, AIS, route planning, and onboard data together in a modern, touchscreen-first interface.

The project is intended to run on affordable onboard hardware such as a Raspberry Pi, with offline operation and a modular architecture as core design goals.

## Project status

**Vision and feasibility stage.** The repository currently documents the intended architecture and roadmap. No application skeleton or implementation has been created yet.

The first engineering milestone is to validate the chart-rendering and chart-data options on the target hardware before committing to the full implementation.

## Guiding principles

- **Offline-first:** essential navigation views and locally stored data should remain available without an internet connection.
- **Safety-conscious:** make data freshness and sensor validity visible; test navigation calculations and alarms thoroughly.
- **Modular:** isolate chart engines, marine-data integrations, and hardware-specific concerns behind clear interfaces.
- **Touchscreen-first:** design for a compact 7–10 inch display and use onboard.
- **Open and maintainable:** prefer established standards and reusable components where their capabilities, licences, and limitations are suitable.
- **Recoverable appliance:** plan for interrupted power, controlled updates, diagnostics, and rollback.

## Architecture

Read the [Architecture Vision](docs/architecture/vision.md) for system boundaries, technology candidates, chart compatibility requirements, and open decisions. The [Roadmap](docs/roadmap.md) describes the phased feasibility and delivery plan. The [Brand and UI Design System](docs/brand/design-system.md) documents the brand rules and design tokens. The [interactive HTML design demo](docs/brand/demo.html) shows the proposed chart-first application, responsive layouts, palette, typography, and interactive UI components.

## Important note

Azimute One is an early-stage project and is not currently a certified navigation system. It should initially be developed and tested as supplementary equipment, not as a replacement for approved navigation equipment or prudent seamanship.
