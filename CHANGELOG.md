# Changelog

## 0.2.3

- Add a 2D Complete map action that shows the vault root with expanded node, link, depth, and outside-link detail budgets.
- Allow farther 2D zoom-out for large complete maps.
- Improve 2D panel wrapping and alignment so long labels remain readable.
- Soften the 2D outside-link road color and legend swatch.

## 0.2.2

- Address Obsidian community plugin review findings around settings APIs, command names, deprecated slider tooltips, direct static styles, and config folder handling.
- Raise the minimum supported Obsidian version to 1.13.0 for the current settings definitions API.
- Remove reveal CSS that relied on partially supported browser features in older Obsidian builds.
- Tighten 2D neighbor list typing and add regression coverage for configured vault folders.

## 0.2.1

- Add default day/night map background fallbacks when the active Obsidian theme cannot provide a matching background color.
- Refresh explicit 3D day/night backgrounds after Obsidian CSS changes.

## 0.2.0

- Add the Galaxy-derived 3D map mode based on [Longwind1984/galaxy-view](https://github.com/Longwind1984/galaxy-view).
- Improve the 2D radial atlas layout, including ring placement, node spacing, search focusing, and root navigation.
- Add richer 3D controls for visual presets, color themes, imported Obsidian graph colors, bloom, physics, cruise motion, reveal animation, and quality tiers.
- Add unified Mini World Map search across 2D and 3D modes.
- Improve side-panel behavior with inspect, pins, view, controls, defaults, and bilingual language switching.
- Add Obsidian-aware theme backgrounds and expanded release documentation.
- Expand tests for settings migration and world-map graph behavior.

## 0.1.3

- Add floating vault-root and fullscreen controls to the map canvas.
- Improve side-panel layout behavior across narrow and wide panes.
- Expand documentation for design goals, features, usage, and settings.

## 0.1.2

- Prepare the plugin for community review by removing redundant manifest wording.
- Add GitHub artifact attestations for release assets.
- Avoid eager vault indexing until the map view is opened.

## 0.1.1

- Mark Codex as a co-author.

## 0.1.0

- Initial community release.
