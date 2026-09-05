import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera } from 'three';
import { layoutRadialGraph, type RadialLayout } from '../src/layout/radial/layoutRadial';
import { RadialRenderer, emptyActiveState } from '../src/render/RadialRenderer';
import type { SpatialIndex } from '../src/render/SpatialIndex';
import { DEFAULT_RADIAL_SETTINGS, type LabelVisibility } from '../src/settings';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';
import type { VisibleWorldGraph, WorldEdge, WorldNode } from '../src/world/types';
import { addHierarchyHighlights, createHighlightIndex } from '../src/view/radialHighlights';

interface EdgeVisual { key: string; edge: WorldEdge; points: { x: number; y: number }[] }
type HeadlessRenderer = Pick<RadialRenderer, 'hitTest' | 'worldToScreen' | 'setView' | 'resize'> & {
	currentLabelVisibility: LabelVisibility;
	revealDepthLimit: number;
	zoom: number;
	allEdgeVisuals: Map<string, EdgeVisual>;
	edgeVisuals: Map<string, EdgeVisual>;
	nodeHitIndex: SpatialIndex<WorldNode>;
	edgeHitIndex: SpatialIndex<EdgeVisual>;
	rebuildHitIndexes(graph: VisibleWorldGraph, layout: RadialLayout): void;
};

function renderer(graph: VisibleWorldGraph | null, layout: RadialLayout | null): HeadlessRenderer {
	const result = Object.assign(Object.create(RadialRenderer.prototype), {
		graph, layout, centerX: layout?.centerX ?? 0, centerY: layout?.centerY ?? 0,
		width: 1200, height: 800, zoom: 1, scheme: 'night', revealDepthLimit: Infinity,
		allEdgeVisuals: new Map(), edgeVisuals: new Map(), currentLabelVisibility: 'hover',
		camera: new OrthographicCamera(), renderer: { render() {}, setSize() {} },
		nodeMaterial: null, active: emptyActiveState(),
	}) as HeadlessRenderer;
	if (graph && layout) {
		result.rebuildHitIndexes(graph, layout);
		result.edgeVisuals = new Map(result.allEdgeVisuals);
	}
	return result;
}

afterEach(() => vi.unstubAllGlobals());

describe('radial interaction preservation', () => {
	it('keeps hover-only labels across pan, zoom and resize', () => {
		vi.stubGlobal('window', { devicePixelRatio: 1 });
		const r = renderer(null, null);
		r.setView(20, -30, 1);
		expect(r.currentLabelVisibility).toBe('hover');
		r.setView(20, -30, 0.1);
		expect(r.currentLabelVisibility).toBe('hover');
		r.resize(900, 700);
		expect(r.currentLabelVisibility).toBe('hover');
	});

	it('matches exhaustive picking at all zoom levels, including roads, ties and reveal stages', () => {
		const records = Array.from({ length: 160 }, (_, i) => ({ path: `topic${i % 4}/note${i}.md`, basename: `note${i}`, kind: 'note' as const }));
		const links = Object.fromEntries(records.map((node, i) => [node.path, { [records[(i + 1) % records.length]!.path]: 1 }]));
		const settings = { ...DEFAULT_RADIAL_SETTINGS };
		const model = buildWorldMap(records, links, {}, settings);
		const graph = buildVisibleWorldGraph(model, { ...defaultVisibleGraphState(settings), rootPath: 'topic0', externalDetailMode: 'exact' }, settings);
		const layout = layoutRadialGraph(graph, { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 30 });
		const first = graph.nodes[0]!;
		const second = graph.nodes[1]!;
		layout.positions.set(second.id, { ...layout.positions.get(first.id)! });
		const indexed = renderer(graph, layout);
		const linear = Object.assign(Object.create(indexed), {
			nodeHitIndex: { query: () => graph.nodes },
			edgeHitIndex: { query: () => [...indexed.edgeVisuals.values()].filter(({ edge }) => edge.type !== 'hierarchy' && edge.type !== 'external-hierarchy') },
		}) as HeadlessRenderer;
		for (const depth of [1, Infinity]) {
			indexed.revealDepthLimit = depth;
			indexed.edgeVisuals = new Map([...indexed.allEdgeVisuals].filter(([, { edge }]) => layout.positions.get(edge.source)!.depth <= depth && layout.positions.get(edge.target)!.depth <= depth));
			for (const zoom of [0.00001, 0.001, 0.01, 0.1, 1, 6]) {
				indexed.zoom = zoom;
				const probes = [{ x: 0, y: 0 }, { x: 600, y: 400 }, { x: 1200, y: 800 }];
				for (const point of [...layout.positions.values()].slice(0, 24)) {
					const screen = indexed.worldToScreen(point.x, point.y);
					probes.push(screen, { x: screen.x + 6, y: screen.y - 3 });
				}
				for (const visual of [...indexed.edgeVisuals.values()].slice(-12)) {
					const point = visual.points[Math.floor(visual.points.length / 2)]!;
					probes.push(indexed.worldToScreen(point.x, point.y));
				}
				for (const { x, y } of probes) {
					for (const [links, nodes] of [[true, true], [true, false], [false, true]] as const) {
						expect(indexed.hitTest(x, y, links, nodes)).toEqual(linear.hitTest(x, y, links, nodes));
					}
				}
			}
		}
	});

	it('combines pinned hierarchy routes without changing ancestor/descendant selection', () => {
		const settings = { ...DEFAULT_RADIAL_SETTINGS };
		const model = buildWorldMap([
			{ path: 'A/B/one.md', basename: 'one', kind: 'note' },
			{ path: 'A/two.md', basename: 'two', kind: 'note' },
		], {}, {}, settings);
		const graph = buildVisibleWorldGraph(model, defaultVisibleGraphState(settings), settings);
		const index = createHighlightIndex(graph);
		const active = emptyActiveState();
		addHierarchyHighlights(index, 'A/B', 'hierarchy-parents', active);
		expect([...active.relatedNodes].sort()).toEqual(['', 'A', 'A/B']);
		addHierarchyHighlights(index, 'A', 'hierarchy-descendants', active);
		expect([...active.relatedNodes].sort()).toEqual(['', 'A', 'A/B', 'A/B/one.md', 'A/two.md']);
		expect(active.highlightedEdges.size).toBe(4);
	});
});
