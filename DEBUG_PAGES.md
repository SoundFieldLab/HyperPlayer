# Independent Debug Pages

This file is the registry for standalone developer-only pages in the WaveForge repository. AI agents and developers must check this file before building a new visual debugging surface.

## Weather Lab

| Field | Value |
|---|---|
| Page | `weather-debug.html` |
| Local URL | `http://127.0.0.1:3000/weather-debug.html` |
| Start command | `npm run dev` |
| Source entry | `src/weather-debug/main.tsx` |
| Scenario factory | `src/weather-debug/scenarios.ts` |
| Styles | `src/weather-debug/debug.css` |
| Test | `test/weatherDebugScenarios.test.ts` |
| Production status | Development-only. Do not add this HTML file to Vite `rollupOptions.input`. |

### Purpose

Use Weather Lab to compare Apple-derived weather visuals before changing production weather code. It provides these local, API-free previews:

- Nine WMO weather categories: clear, partly cloudy, cloudy, fog, drizzle, rain, heavy rain, thunder, and snow.
- Day and night variants for every category.
- One full-screen Apple weather scene preview.
- Desktop `full` and `simple` weather card previews using the compact Apple renderer.
- A button that opens the real `WeatherDetailsModal` using only local mock data.
- A reduced-motion/static-frame toggle.

### Feedback Format

Use the visible scenario identifier when reporting a visual issue:

```text
scene=thunder-night: reduce rain density and darken the cloud base
scene=clear-day: move the sun farther right
card=full: improve temperature contrast
card=simple: increase hourly forecast readability
```

### Safety Rules

- Do not import `DesktopWidgetZone` or `WeatherWidget` into this page. They perform real weather and hazard refreshes.
- Keep all data in `scenarios.ts`; do not call Open-Meteo, Nominatim, location services, or hazard APIs from the page.
- Do not use port `3002`; it is reserved for the Python beat-analysis service. Use the existing Vite `3000` server and open `/weather-debug.html`.
- Keep this page outside production build inputs. It is a visual validation tool, not a customer-facing route.
- When adding another independent debug page, add a separate section in this registry with its URL, command, scope, source files, production status, and API/network constraints.

## Adding A New Debug Page

1. Create a root `*-debug.html` entry and a dedicated `src/<feature>-debug/` folder.
2. Reuse the existing Vite dev server unless a feature truly requires a separate backend process.
3. Keep all data local or explicitly document allowed test APIs.
4. Add a focused test for the scenario/data factory.
5. Register the page in this document and link it from `AGENTS.md`.
6. Do not add it to production Vite inputs unless the product specification explicitly promotes it to a shipped feature.
