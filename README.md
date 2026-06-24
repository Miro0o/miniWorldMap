# Mini World Map

Mini World Map is an Obsidian plugin for exploring a vault as both a hierarchy-first world map and a 3D galaxy of links.

The current project is based on [Longwind1984/galaxy-view](https://github.com/Longwind1984/galaxy-view). Mini World Map builds on that Galaxy-style 3D graph foundation with Obsidian plugin packaging, TypeScript source, local vault indexing, a 2D radial atlas, bilingual controls, quality tiers, and release-ready assets.

It is designed for people who use folders as meaningful topic structure and links as cross-topic associations. The map helps you see both at once: where a note lives in the vault hierarchy, and which other notes or topics it connects to.

This plugin was originally built for my own knowledge base, [miniWorldModel](https://github.com/Miro0o/miniWorldModel), which has grown large enough that I needed a way to present its structure to others.

## Core Ideas

Mini World Map has two complementary render modes:

- **2D radial atlas:** concentric rings show the vault hierarchy. Inner rings are parent folders or topics, while outer rings contain child folders and notes.
- **3D galaxy map:** a Three.js force graph shows the vault as a spatial link network, with camera flight, glow, search, and visual presets.

The 2D atlas is the hierarchy-first view. Any folder can become the root node at the center of the map, so you can zoom from the whole vault into a smaller topic world. Parent-child relationships form the geography, while Obsidian links appear as roads between topics.

The 3D map is the link-first view. It keeps the Galaxy-style experience from the base project, then adds Mini World Map controls for Obsidian vault data, imported graph colors, performance tiers, search, reveal animation, and persistent warm-start positions.

The goal is to complement Obsidian's native Graph View and conventional mind-map tools. Graph View focuses on note-to-note links but does not foreground folder hierarchy. Mind maps usually show hierarchy but not rich note linking. Mini World Map combines both: hierarchy provides the geography, and note links provide the roads.

## Features

- **Two render modes:** switch between 2D radial rings and the 3D Galaxy map from the view panel or command palette.
- **Atlas view:** browse folders and notes as a radial world map rooted at the whole vault or any folder.
- **Focus view:** center the 2D map around the active note and show ancestors, siblings, outgoing links, and backlinks.
- **3D Galaxy view:** fly through a Three.js graph with force layout, bloom, twinkle, orbit cruise, reveal animation, and search-to-fly navigation.
- **Search:** open Mini World Map search from either mode and jump to notes, folders, unresolved links, or graph nodes.
- **Re-rooting:** double-click a folder in 2D to use it as the current atlas root.
- **Hierarchy highlighting:** hover a 2D node to highlight parents, direct children, descendants, or parent-plus-child paths.
- **Note-link highlighting:** hover nodes or link roads to inspect Obsidian internal links alongside the hierarchy.
- **Link overlays:** draw aggregated internal links between visible 2D nodes.
- **Cross-root links:** show links that leave the current 2D root as grouped outside branches, selected outside files, or exact outside files.
- **Unresolved links:** optionally represent unresolved internal links as temporary nodes.
- **Selection and inspection:** click nodes or links to inspect details in the side panel, including outgoing links and backlinks.
- **Pinned paths:** pin highlighted 2D paths, group pins, and toggle pinned route visibility.
- **Navigation:** double-click a 2D note to open it; use `Ctrl`/`Cmd` while opening to use a split pane.
- **Context actions:** right-click 2D nodes to open notes, focus notes, use folders as roots, open representative folder notes, or pin paths.
- **Canvas controls:** pan, zoom, fit, rebuild, return to vault root, switch language, and switch render modes.
- **3D performance handling:** uses a worker layout when available, falls back to the main thread if needed, stores settled positions for warm starts, and can auto-drop to a lower quality tier.
- **Visual customization:** tune 2D labels, ring guides, spin, color scheme, legend items, and link budgets; tune 3D bloom, physics, node size, link opacity, twinkle, size mode, theme, color theme, cruise, and quality.
- **Imported Obsidian graph colors:** 3D mode can import color groups from `.obsidian/graph.json` and shuffle or apply bundled color themes.
- **Panel language:** English and Chinese are available for both 2D and 3D panels.
- **Local-only indexing:** builds the map from your local vault metadata without network services or telemetry.

## Usage

1. Enable Mini World Map in **Settings -> Community plugins**.
2. Run **Open Mini World Map** from the command palette, or use the ribbon icon.
3. Use **Toggle Mini World Map render mode** to switch between 2D and 3D.
4. Use **Search Mini World Map** to find and jump to notes or graph nodes.
5. Use **Rebuild Mini World Map index** after large vault changes if the map is already open.

Useful 2D interactions:

- Hover a node to preview hierarchy or note-link relationships.
- Click a node or link to pin the highlight and inspect it in the side panel.
- Double-click a note to open it.
- Double-click a folder to make it the atlas root.
- Right-click a node for node actions.
- Pan and zoom the canvas to move through large maps.

Useful 3D interactions:

- Left drag to orbit and scroll to zoom.
- Right drag, `Cmd` + left drag, or `Shift` + left drag to pan.
- Use `WASD` to fly, `Q`/`E` to rise or fall, and `Shift` to move faster.
- Click a node to select it and fly toward it.
- Press `F` to fly to the selected node, `R` for overview, and `Esc` to clear selection.

## Settings

Global plugin settings include:

- Language: English or Chinese.
- Default render mode: 2D radial rings or 3D map.
- Default 2D atlas depth.
- Default 2D render node limit.
- Default 2D note-link limit.
- 2D note-link overlay visibility.
- 2D hover highlight mode and hover targets.
- 2D label visibility.
- 2D ring spin.
- 2D unresolved link handling.
- Ignored folders.

The 2D view panel also includes per-view controls for atlas/focus mode, vault root, theme, depth, visible nodes, note-link budget, outside-link detail, exact outside-note limit, ring guides, and legend visibility.

The 3D view panel includes controls for search, recentering, reveal animation, visual style presets, theme presets, color themes, imported Obsidian graph colors, node sizing, bloom, physics, cruise motion, unresolved links, orphan nodes, quality tier, and default reset.

## Development

Mini World Map is built from TypeScript source.

```bash
npm install
npm test
npm run build
```

Useful scripts:

- `npm run dev` starts the esbuild watcher.
- `npm run build` validates TypeScript and writes release assets.
- `npm test` runs the Vitest suite.
- `npm run lint` runs ESLint.

The checked-in `main.js` is the generated bundle. The previous legacy bundle is preserved at `legacy/main.legacy.js`.

## Manual Installation

Until the plugin is available in the community directory, download the latest release assets and place them in:

```text
<vault>/.obsidian/plugins/mini-world-map/
```

Required files:

- `main.js`
- `manifest.json`
- `styles.css`

Then reload Obsidian and enable the plugin.

## Privacy

Mini World Map runs locally in Obsidian. It does not use network services or telemetry.

## Credits

- Based on [Longwind1984/galaxy-view](https://github.com/Longwind1984/galaxy-view).
- Created and maintained by Miro0o and Codex.

## License

MIT
