import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { ROOT_ID } from '../src/world/types';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';

const records = [
	{ path: 'Atlas', basename: 'Atlas', kind: 'folder' as const },
	{ path: 'Atlas/Atlas.md', basename: 'Atlas', kind: 'note' as const },
	{ path: 'Atlas/Topic A.md', basename: 'Topic A', kind: 'note' as const },
	{ path: 'Atlas/Sub', basename: 'Sub', kind: 'folder' as const },
	{ path: 'Atlas/Sub/Topic B.md', basename: 'Topic B', kind: 'note' as const },
	{ path: 'Outside/Other.md', basename: 'Other', kind: 'note' as const },
	{ path: '.obsidian/Hidden.md', basename: 'Hidden', kind: 'note' as const },
];

function model(overrides: Partial<typeof DEFAULT_RADIAL_SETTINGS> = {}) {
	const settings = { ...DEFAULT_RADIAL_SETTINGS, ...overrides };
	return buildWorldMap(
		records,
		{
			'Atlas/Topic A.md': { 'Atlas/Sub/Topic B.md': 2, 'Outside/Other.md': 1 },
			'Outside/Other.md': { 'Atlas/Topic A.md': 1 },
		},
		{
			'Atlas/Topic A.md': { Missing: 1 },
		},
		settings,
	);
}

describe('world-map model', () => {
	it('indexes folders, notes, representatives, unresolved links, and ignored folders', () => {
		const m = model();
		expect(m.nodes.has(ROOT_ID)).toBe(true);
		expect(m.nodes.has('Atlas')).toBe(true);
		expect(m.nodes.has('Atlas/Topic A.md')).toBe(true);
		expect(m.nodes.has('.obsidian/Hidden.md')).toBe(false);
		expect(m.nodes.get('Atlas')?.representativeFile).toBe('Atlas/Atlas.md');
		expect(m.nodes.get('Atlas/Atlas.md')?.isRepresentativeFile).toBe(true);
		expect([...m.nodes.values()].filter((node) => node.type === 'unresolved')).toHaveLength(1);
		expect(m.stats.notes).toBe(4);
	});

	it('can omit unresolved nodes', () => {
		const m = model({ includeUnresolvedLinks: false });
		expect([...m.nodes.values()].filter((node) => node.type === 'unresolved')).toHaveLength(0);
	});
});

describe('visible world graph', () => {
	it('builds an atlas graph with hierarchy edges and representative folding', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = true;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(graph.rootId).toBe('Atlas');
		expect(graph.nodesById.has('Atlas/Atlas.md')).toBe(false);
		expect(graph.hierarchyEdges.length).toBeGreaterThan(0);
		expect(graph.linkEdges.length).toBeGreaterThan(0);
	});

	it('creates grouped and exact outside-root proxies', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = true;
		state.externalDetailMode = 'grouped';
		const grouped = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(grouped.nodes.some((node) => node.type === 'external' && !node.externalProxy)).toBe(true);
		expect(grouped.nodes.some((node) => node.externalProxy)).toBe(false);

		state.externalDetailMode = 'exact';
		const exact = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(exact.nodes.some((node) => node.externalProxy)).toBe(true);
	});

	it('keeps hover links available when the visible link overlay is off', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = false;
		state.showExternalLinks = false;
		state.hoverHighlightMode = 'note-links';
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(graph.linkEdges).toHaveLength(0);
		expect(graph.hoverLinkEdges.length).toBeGreaterThan(0);
	});

	it('builds a focus graph around the active note', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.mode = 'focus';
		state.focusPath = 'Atlas/Topic A.md';
		state.showLinkOverlay = true;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(graph.focusId).toBe('Atlas/Topic A.md');
		expect(graph.nodesById.has('Atlas/Sub/Topic B.md')).toBe(true);
	});
});

describe('radial layout', () => {
	it('keeps the root centered and ring depths ordered', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = true;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const root = layout.positions.get(graph.rootId);
		expect(root?.x).toBeCloseTo(0);
		expect(root?.y).toBeCloseTo(0);
		expect([...layout.positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
		const radii = layout.rings.map((ring) => ring.radius);
		expect(radii).toEqual([...radii].sort((a, b) => a - b));
	});

	it('keeps folder descendants outside their parent folder rings', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = ROOT_ID;
		state.showLinkOverlay = false;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const root = layout.positions.get(ROOT_ID);
		const atlas = layout.positions.get('Atlas');
		const sub = layout.positions.get('Atlas/Sub');
		const topic = layout.positions.get('Atlas/Sub/Topic B.md');

		expect(root?.radius).toBeCloseTo(0);
		expect(atlas?.radius).toBeGreaterThan(root?.radius ?? -1);
		expect(sub?.radius).toBeGreaterThan(atlas?.radius ?? -1);
		expect(topic?.radius).toBeGreaterThan(sub?.radius ?? -1);
		expect(atlas?.depth).toBe(1);
		expect(sub?.depth).toBe(2);
		expect(topic?.depth).toBe(3);
	});

	it('does not invent hierarchy rings for flat same-parent root notes', () => {
		const crowdedRecords = Array.from({ length: 900 }, (_, index) => ({
			path: `Note ${index}.md`,
			basename: `Note ${index}`,
			kind: 'note' as const,
		}));
		const m = buildWorldMap(crowdedRecords, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const nodeRadii = [...layout.positions.entries()]
			.filter(([id]) => id !== graph.rootId)
			.map(([, point]) => Math.hypot(point.x, point.y));
		const depthOneRings = layout.rings.filter((ring) => ring.depth === 1);
		const minRadius = Math.min(...nodeRadii);
		const maxRadius = Math.max(...nodeRadii);

		expect(depthOneRings).toHaveLength(1);
		expect(maxRadius - minRadius).toBeLessThan((depthOneRings[0]?.radius ?? 1) * 0.5);
	});
});
