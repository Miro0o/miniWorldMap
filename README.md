# Mini World Map

Mini World Map is an Obsidian plugin that visualizes your vault as a hierarchy-first world map, with Obsidian note links layered on top. It now has two rendering modes:

- **2D radial rings:** the default hierarchy-first Mini World Map view.
- **3D map:** a Galaxy-derived Three.js map for flying through the vault link graph.

It is designed for people who use folders as meaningful topic structure and links as cross-topic associations. The map helps you see both at once: where a note lives in the vault hierarchy, and which other notes or topics it connects to.

This plugin was originally built for my own knowledge base, [miniWorldModel](https://github.com/Miro0o/miniWorldModel), which has grown large enough that I needed a way to present its structure to others.

## Core design ideas

Mini World Map uses concentric rings to represent the mind-map hierarchy. Inner rings are parent folders or topics, while outer rings are their child folders and notes. Parent-child relationships are drawn as hierarchy links, so the shape of the map follows the structure of your vault.

Any folder can become the root node at the center of the map. Double-click a folder to recenter the atlas around that topic and get a smaller sub mind-map for the selected branch.

Hovering is used as a fast reading tool. Hover a node to highlight its hierarchy links and quickly see ancestors, siblings, direct children, or descendants. You can also use hover highlighting for note links, which makes it easier to inspect internal links, unresolved links, and links that point outside the current root.

The goal is to complement Obsidian's native Graph View and conventional mind-map tools. Graph View focuses on note-to-note links but does not foreground folder hierarchy. Mind maps usually show hierarchy but not rich note linking. Mini World Map combines both views: hierarchy provides the geography, and note links provide the roads between topics.

## Features

- **Two render modes:** switch between 2D radial rings and a 3D map from the view panel.
- **Atlas view:** browse folders and notes as a radial world map rooted at the whole vault or at any folder.
- **Focus view:** center the map around the active note and show its ancestors, siblings, outgoing links, and backlinks.
- **Concentric hierarchy rings:** render parent folders closer to the center and child folders or notes farther outward.
- **Re-rooting:** double-click a folder to use it as the current atlas root.
- **Hierarchy highlighting:** hover a node to highlight parents, direct children, descendants, or parent-plus-child paths.
- **Note-link highlighting:** hover notes or links to inspect Obsidian internal links alongside the hierarchy.
- **Link overlays:** draw aggregated internal links between visible nodes.
- **Cross-root links:** when viewing a sub-map, show links that leave the current root as grouped outside branches, selected outside files, or exact outside files.
- **Unresolved links:** optionally represent unresolved internal links as temporary nodes.
- **Selection and inspection:** click a node or link to pin its highlight and inspect related details in the side panel.
- **Navigation:** double-click a note to open it; use `Ctrl`/`Cmd` while opening to use a split pane.
- **Canvas controls:** pan, zoom, drag nodes temporarily, reset the view, and switch between bounded and complete root detail.
- **Adaptive detail:** automatically adjusts depth, node budget, and link budget when the map is large.
- **Display controls:** configure atlas depth, node limit, link limit, outside-link detail, label visibility, spin speed, color scheme, and ignored folders.
- **Appearance modes:** follow Obsidian/system by default, or force Mini World Map's Light or Night palette.
- **Panel language:** use English by default, with Chinese available for both 2D and 3D panels.
- **Local-only indexing:** builds the map from your local vault metadata without network services or telemetry.

## Development

Mini World Map is now built from TypeScript source.

```bash
npm install
npm test
npm run build
```

`npm run build` validates TypeScript and writes release assets. The checked-in `main.js` is the generated bundle; the previous legacy bundle is preserved at `legacy/main.legacy.js`.

## Usage

1. Enable Mini World Map in **Settings -> Community plugins**.
2. Run **Open Mini World Map** from the command palette, or use the ribbon icon.
3. Use **Rebuild Mini World Map index** after large vault changes if the map is already open.

Useful interactions:

- Hover a node to preview its hierarchy or note-link relationships.
- Click a node or link to pin the highlight and inspect it in the side panel.
- Double-click a note to open it.
- Double-click a folder to make it the atlas root.
- Right-click a node for node actions.
- Pan and zoom the canvas to move through large maps.

## Settings

Mini World Map includes settings for:

- Language: English or Chinese.
- Color scheme: System, Light, or Night.
- Default render mode: 2D radial rings or 3D map.
- Default atlas depth.
- Default link overlay limit.
- Default render node limit.
- Adaptive detail.
- Label visibility.
- Default spin speed.
- Link overlay visibility.
- Hover highlight mode.
- External link visibility.
- Outside detail mode: Groups, Selected, or Exact.
- Exact outside file limit.
- Unresolved link handling.
- Ignored folders.

## Manual installation

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

## Authors

- Miro0o
- Codex

## License

MIT
