# Azimute One — Brand and UI Design System

**Status:** Proposed visual direction  
**Version:** 0.1  
**Product stage:** Discovery and feasibility  
**Tagline:** Your course. Your instruments. Your sea.

This document records the agreed visual direction for Azimute One. It is a design specification for future implementation, not a claim that the application or final logo assets already exist. Values below are initial design tokens and may be tuned after contrast, touchscreen, chart-engine, and hardware validation.

## 1. Brand intent

Azimute One should feel like a capable, modern marine instrument: calm, clear, trustworthy, and purpose-built for sailors. The visual language combines a refined dark application frame with a clean, legible nautical chart.

### Brand attributes
- **Clear:** chart information and navigation state take priority over decoration.
- **Confident:** deep navy surfaces and restrained accents create a professional instrument feel.
- **Calm:** avoid visual noise, excessive gradients, and unnecessary animation.
- **Practical:** controls are easy to identify and operate while underway.
- **Open and adaptable:** the identity works across the application, website, documentation, and a small app icon.

### Tagline
**Your course. Your instruments. Your sea.**

Use sentence case for supporting copy. Prefer concise labels and plain language over marketing language in the navigation interface.

## 2. Logo and app icon

### Selected direction

Use the **sail-and-wave mark from the second visual proposal** with the **application layout and chart presentation from the first proposal**. Do not revert to the earlier compass-ring/arrow mark.

The mark is an abstract, geometric sail above two simplified wave strokes:
- a bold, dark navy triangular sail;
- a slender, light sail/negative-space detail that gives the mark a sense of forward motion;
- a pair of clean wave forms, using ocean blue and/or sea teal;
- no enclosing compass circle, fine ornamental details, gradients required for recognition, or tiny text inside the symbol.

The mark should remain recognisable at favicon size and in a one-colour version.

### Logo lockups
1. **Primary horizontal lockup:** symbol at left, “AZIMUTE ONE” at right. “AZIMUTE” in deep navy and “ONE” in ocean blue. Tagline may appear below in small, tracked lettering where space permits.
2. **Stacked lockup:** symbol above the wordmark, for covers, splash screens, and square compositions.
3. **Symbol only:** the sail-and-wave mark, for app icon, favicon, compact navigation bars, and loading states.
4. **Monochrome:** single-colour navy or white version for low-colour printing, overlays, and backgrounds where the full-colour mark lacks contrast.

### Clear space and minimum size
- Keep clear space around the logo equal to at least the height of the small wave symbol.
- Do not stretch, rotate, outline, add shadows, or rearrange the sail and wave elements.
- Avoid placing the full wordmark below 150 px wide on screen; use the symbol-only version at smaller sizes.
- App icon: centred symbol on a solid deep-navy rounded square. No wordmark or tagline inside the icon.
- Favicon: symbol-only, simplified further if necessary to preserve the sail and wave silhouette.

### Asset delivery requirements
When implementation begins, create clean vector master assets (SVG) for primary, stacked, monochrome, and symbol-only versions. Generate PNG app icons and favicons from those masters. The concept-board render is a visual reference, not a production-ready vector asset; recreate the logo as clean paths and verify its silhouette at 16, 32, 48, and 128 px.

## 3. Colour system

Use dark navy for application chrome, ocean blue for primary interactive emphasis, and sea teal sparingly for secondary emphasis. The map itself uses a separate, clean light-chart palette inspired by the second visual proposal. Do not apply the dark UI palette to the light chart.

### Brand and interface tokens

| Token | Hex | Intended use |
|---|---|---|
| `brand.navy` | `#0B2A44` | Primary brand, dark navigation panels, headers |
| `brand.oceanBlue` | `#1F6FA8` | Primary actions, selected controls, links |
| `brand.seaTeal` | `#2CC0C3` | Secondary highlights, active route/data accents |
| `brand.alertOrange` | `#FF8A00` | Important warnings where orange is semantically appropriate |
| `ui.background` | `#F5F8FA` | Light settings and secondary screens |
| `ui.surface` | `#FFFFFF` | Cards and popovers on light screens |
| `ui.surfaceDark` | `#071C2B` | Dark application frame and instrument panels |
| `ui.surfaceRaisedDark` | `#102D42` | Raised dark cards and menus |
| `ui.text` | `#0F172A` | Main text on light surfaces |
| `ui.textMuted` | `#64748B` | Secondary text on light surfaces |
| `ui.textOnDark` | `#F8FAFC` | Main text on dark surfaces |
| `ui.textMutedOnDark` | `#B8C7D4` | Secondary text on dark surfaces |
| `ui.border` | `#D7E0E7` | Light borders and separators |
| `ui.borderDark` | `#294356` | Borders on dark surfaces |
| `state.success` | `#22A06B` | Connected/healthy status, with text or icon |
| `state.warning` | `#E5A000` | Warning state |
| `state.error` | `#D64545` | Error/critical state |
| `state.info` | `#2589C7` | Informational status |

These are starting tokens. Before production, check contrast ratios for text, icons, selected states, and sunlight-visible use. Never communicate a critical state using colour alone.

## 4. Nautical chart palette — separate from UI chrome

The preferred chart appearance is the **clean, pale-blue water and muted sand land shown in the second proposal**, while retaining the first proposal's application layout. This is a chart-content style, not a change to the surrounding dark navy application panels.

| Chart element | Target visual direction | Starting reference |
|---|---|---|
| Shallow / coastal water | Very pale blue | `#DCEFF8` |
| General water | Clear, light blue | `#B9E0F4` |
| Deeper water | Slightly stronger blue | `#91CBEA` |
| Land | Muted warm sand | `#F3EEDC` |
| Land detail / terrain | Low-contrast sand-grey | `#E5DFC9` |
| Coastline | Muted grey-blue | `#9DBBCB` |
| Depth contours | Subtle medium blue | `#8FC4E2` |
| Depth labels | Dark slate blue | `#42677D` |
| Own vessel / heading | Dark navy with high-contrast outline | `#0B2A44` |
| Planned route | Distinct dashed magenta or violet line | `#B65AD9` |
| Active track | Teal or ocean blue, differentiated from route | `#168DB5` |

**Important chart-engine constraint:** these colours describe the desired visual direction for maps and mockups. Actual nautical chart rendering depends on the chosen engine, source format, chart portrayal rules, and licensing. S-57 ENC portrayal must respect the applicable S-52 rules and safety-relevant symbology; do not blindly recolour standard symbols or depth areas. Any custom theme must be evaluated for legibility and chart correctness. The app should preserve a standards-compliant chart presentation where required, even if exact mockup colours cannot be reproduced.

AIS target colours and symbols must remain distinguishable and consistent with the selected chart engine's standards and user settings. Do not use brand teal as the universal colour for all target types.

## 5. Typography

### Typeface roles
- **Primary UI typeface:** Inter, with system sans-serif fallback.
- **Display/section headings:** Space Grotesk may be used sparingly for marketing and brand materials; use Inter in dense operational UI if Space Grotesk reduces legibility.
- **Instrument values:** Inter with tabular numerals enabled where available.

### Type scale (starting values)

| Role | Size | Weight | Notes |
|---|---:|---:|---|
| Display / marketing title | 32–48 px | 600 | Website and cover material only |
| Screen title | 22–26 px | 600 | Main page title |
| Section title | 16–18 px | 600 | Panel and group headings |
| Body / control label | 14–16 px | 400–500 | Default UI text |
| Secondary label | 12–14 px | 400 | Use sparingly on the compact display |
| Instrument value | 24–32 px | 500–600 | Prominent live values |
| Dense chart annotation | Chart-engine controlled | — | Do not force UI typography onto chart portrayal |

Do not use all-caps for ordinary labels. The wordmark may use uppercase lettering and generous tracking. Keep line lengths short on small screens.

## 6. Layout and application composition

### Overall layout direction
Retain the **first proposal's application layout**:
- dark navy application frame;
- persistent left navigation on wide displays;
- large central chart viewport;
- compact instrument/status column to the right;
- floating chart tools over the map;
- responsive tablet and mobile layouts that preserve chart priority.

Only the **map content palette** follows the clean light-chart treatment from the second proposal. Do not make the whole application white simply because the map is light.

### Wide-screen layout
- Left sidebar: brand symbol/wordmark, primary navigation, connection status near the bottom.
- Main area: chart viewport receives the largest share of space.
- Instrument column: key live values, position, depth, wind, and heading/compass where available.
- Floating chart controls: layers, recenter/own ship, measure, route/track tools, and zoom. Group by task and avoid stacking too many controls.
- Header/status area: time, connection indicators, GNSS/data health, and notifications as space permits.

### Tablet and mobile
- Preserve a full-height chart as the primary surface.
- Collapse the sidebar into a compact top bar and/or bottom navigation.
- Show essential instrument cards without permanently obscuring too much of the chart.
- Use expandable panels for secondary data and settings.
- Do not assume a phone layout is simply a scaled-down desktop.

### Grid, spacing, and shape tokens
Use a 4 px base spacing unit.

| Token | Value | Use |
|---|---:|---|
| `space.1` | 4 px | Tight icon/label gap |
| `space.2` | 8 px | Compact component padding |
| `space.3` | 12 px | Default small gaps |
| `space.4` | 16 px | Standard spacing |
| `space.6` | 24 px | Section separation |
| `space.8` | 32 px | Large separation |
| `radius.sm` | 4 px | Small controls |
| `radius.md` | 8 px | Cards and buttons |
| `radius.lg` | 12 px | Major panels, app icon framing |
| `border.width` | 1 px | Standard separators |
| `control.minTouch` | 44 × 44 px | Minimum target guideline; increase where practical |

Prefer crisp panels, subtle borders, and restrained shadows. Avoid excessive card nesting and decorative gradients. Touch targets should be comfortable for use on a moving boat.

## 7. Components

### Buttons
- **Primary:** ocean-blue fill with white label.
- **Secondary:** transparent or pale surface with a visible border and navy label.
- **Quiet/icon button:** transparent surface with a clear hit area and an accessible name.
- **Destructive:** reserved for destructive actions; use error colour plus explicit wording.
- Show disabled, focused, pressed, selected, and loading states distinctly.

### Navigation
- Dark navy sidebar with white/soft-grey labels and simple line icons.
- Selected item uses a clear ocean-blue surface or accent; teal can provide a secondary highlight.
- Icon and label should both communicate the destination where space allows.
- Use consistent icon stroke weight and a single icon family.

### Instrument cards
- Dark raised surfaces, clear labels, large values, and units beside values.
- Distinguish current values from stale, unavailable, or invalid values.
- Keep position, speed, heading, depth, and wind formatting consistent.
- Include timestamps/source or freshness details where useful; never imply stale data is current.

### Chart controls and overlays
- Floating white or near-white controls with dark icons, subtle border/shadow, and generous touch areas.
- Keep controls visually separate from the chart without hiding important chart detail.
- Provide a dark/transparent overlay alternative only if it remains legible across varying chart backgrounds.
- Route, track, AIS, own-ship, waypoint, and measurement overlays must be distinguishable without relying on colour alone.

### Status and alarms
- Use consistent success, warning, error, and information tokens.
- Pair colour with an icon and/or text.
- Critical alarms must be prominent, persistent as appropriate, and tested for acknowledgement behaviour. Avoid decorative animation.

## 8. Iconography

Use a consistent outline icon family, preferably Lucide-style line icons for application controls. Use nautical chart symbols supplied by the chart engine for chart-standard objects.

Core application icon concepts:
- Chart / layers
- Routes
- Waypoints
- Tracks
- Vessel / own ship
- AIS
- Instruments
- Weather / GRIB
- Radar
- Alarms
- Settings
- Connection / diagnostics

Keep icons simple and geometrically consistent. Avoid mixing filled, outlined, and highly detailed styles in the same navigation group. Do not substitute generic UI icons for standard chart symbols where chart standards apply.

## 9. Imagery and marketing

- Use authentic marine photography: underway sailing, coastlines, open water, and navigation environments.
- Prefer natural light and restrained colour grading; photography should support the story, not compete with the product.
- Product screenshots should show a clean light nautical chart within the dark application frame.
- Avoid stock-photo clichés, excessive glow, artificial neon, and dense visual overlays.
- Use the sail-and-wave mark with generous space; do not place small tagline text over busy imagery unless contrast is guaranteed.

## 10. Motion and interaction

- Prefer immediate, quiet transitions; avoid unnecessary motion.
- Use motion to communicate panel opening, selection, route changes, or status changes—not decoration.
- Do not animate the chart in ways that impair situational awareness.
- Avoid rapid flashing. Alarm behaviour must be deliberately designed and tested.
- Support keyboard, mouse, and touch interactions where applicable, while prioritising touch for the appliance.

## 11. Accessibility, readability, and safety

- Test contrast for text, controls, and status indicators in both light and dark UI surfaces.
- Verify readability at actual 7–10 inch display sizes and at realistic viewing distances.
- Ensure important information is not conveyed through colour alone.
- Respect user-configurable day/night modes, while distinguishing UI theme changes from chart portrayal settings.
- Validate map readability in bright daylight and low-light conditions.
- Preserve chart-engine correctness, standard chart symbols, and safety-related portrayal requirements.
- Display missing, stale, invalid, and estimated data honestly.
- Treat the application as supplementary navigation equipment until an appropriate validation and safety case exists.

## 12. Implementation guidance

When the project moves beyond feasibility:
1. Create production SVG assets from the selected sail-and-wave logo direction; do not use the generated concept board as a logo file.
2. Store design tokens in one central theme source and map them to CSS custom properties.
3. Separate **application UI tokens** from **chart palette/portrayal** configuration.
4. Implement components with explicit interaction states and accessible labels.
5. Validate at target display resolution and Raspberry Pi hardware, not only on a desktop browser.
6. Verify contrast, touch-target sizing, chart readability, and performance before calling the design production-ready.

Suggested future asset organization (not to be created during the current documentation-only stage):

```text
docs/
  brand/
    design-system.md
assets/
  brand/
    logo-horizontal.svg
    logo-stacked.svg
    logo-monochrome.svg
    mark.svg
    app-icon.png
    favicon.svg
```

## Interactive HTML demo

Open the [interactive HTML design-system demo](demo.html) to see the proposed application shell, illustrative nautical chart, instrument cards, responsive tablet/mobile layouts, colour tokens, typography, controls, and component states. The demo is a standalone HTML/CSS/JavaScript page and uses synthetic chart artwork only; it is not a navigational chart or production application.

## 14. Decisions and open questions

### Agreed direction
- Use the sail-and-wave logo and app icon direction from the second visual proposal.
- Retain the application layout from the first visual proposal.
- Apply the second proposal's clean light-blue water and muted sand chart colours to the **map itself only**.
- Keep the surrounding application chrome dark navy with ocean-blue and teal accents.
- Use Inter as the main UI typeface.
- Keep the design touchscreen-first and chart-centred.

### To validate before implementation
- Final vector geometry and exact logo proportions.
- Contrast and legibility of colour tokens on the actual target display.
- Chart-engine support for desired visual treatment without violating chart portrayal rules.
- Day/night mode behaviour and whether it can be controlled independently from the application theme.
- Final spacing and type scale after testing at the target screen resolution.
- Licence and attribution requirements for any reused icons, fonts, chart assets, or third-party visual components.
