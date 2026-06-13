# Mini World Map

Mini World Map visualizes an Obsidian vault as a hierarchy-first world map with internal links layered on top.

## Features

- Atlas view for folder and note hierarchy.
- Focus view for the active note, ancestors, siblings, outgoing links, and backlinks.
- Link overlays for internal links, cross-root links, and unresolved links.
- Adjustable depth, node limits, link limits, spacing, zoom, and color scheme.
- Day, night, and automatic appearance modes.

## Usage

1. Enable Mini World Map in **Settings -> Community plugins**.
2. Run **Open Mini World Map** from the command palette, or use the ribbon icon.
3. Use **Rebuild Mini World Map index** after large vault changes if the map is already open.

Click a node or link to pin its highlight and inspect it in the side panel. Double-click a note to open it. Double-click a folder to use it as the atlas root.

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
