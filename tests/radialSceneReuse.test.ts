import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, Scene, type Points, type LineSegments } from 'three';
import { RadialRenderer, emptyActiveState, type RadialActiveState } from '../src/render/RadialRenderer';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';

class Label {
	className = '';
	textContent = '';
	style: Record<string, string> = {};
	setText(text: string) { this.textContent = text; }
	addClass(name: string) { this.className += ` ${name}`; }
	remove() {}
}

type HeadlessRenderer = Pick<RadialRenderer, 'setData' | 'setActive' | 'setTheme' | 'setView'> & {
	nodePoints: Points;
	hierarchySegments: LineSegments;
	linkSegments: LineSegments;
	ringSegments: LineSegments | null;
	labelElements: Map<string, Label>;
	revealDepthLimit: number;
	active: RadialActiveState;
	sceneAppearance: unknown;
	setRevealDepthLimit(depth: number): void;
	disposeObjects(): void;
};

const renderers: HeadlessRenderer[] = [];
beforeEach(() => vi.stubGlobal('window', { devicePixelRatio: 1 }));
afterEach(() => {
	for (const renderer of renderers.splice(0)) renderer.disposeObjects();
	vi.unstubAllGlobals();
});

function fixture() {
	const records = Array.from({ length: 20 }, (_, i) => ({ path: `A/note${i}.md`, basename: `note${i}`, kind: 'note' as const }));
	const model = buildWorldMap(records, { 'A/note0.md': { 'A/note1.md': 1 } }, {}, DEFAULT_RADIAL_SETTINGS);
	const graph = buildVisibleWorldGraph(model, defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS), DEFAULT_RADIAL_SETTINGS);
	const layout = layoutRadialGraph(graph, { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 });
	const renderer = Object.assign(Object.create(RadialRenderer.prototype), {
		graph: null, layout: null, centerX: layout.centerX, centerY: layout.centerY, width: 1200, height: 800,
		zoom: 0.1, scheme: 'night', revealDepthLimit: Infinity, active: emptyActiveState(),
		allEdgeVisuals: new Map(), edgeVisuals: new Map(), scene: new Scene(),
		camera: new OrthographicCamera(), renderer: { render() {}, setClearColor() {} },
		labelRoot: { createDiv: () => new Label(), appendChild() {}, empty() {} }, labelElements: new Map(),
	}) as HeadlessRenderer;
	renderers.push(renderer);
	renderer.setData(graph, layout, 'auto');
	return { renderer, graph, layout };
}

function snapshot(renderer: HeadlessRenderer) {
	return {
		objects: [renderer.nodePoints, renderer.hierarchySegments, renderer.linkSegments, renderer.ringSegments].map((object) => object ? {
			attributes: Object.fromEntries(Object.entries(object.geometry.attributes).map(([name, attribute]) => [name, Array.from(attribute.array)])),
			material: (Array.isArray(object.material) ? object.material : [object.material]).map((material) => ({ ...material.toJSON(), uuid: undefined })),
		} : null),
		labels: [...renderer.labelElements].map(([id, label]) => ({ id, className: label.className, text: label.textContent, style: { ...label.style } })),
	};
}

describe('unchanged radial scene reuse', () => {
	it('retains node and road buffers while matching a fresh scene for labels and active state', () => {
		const { renderer, graph, layout } = fixture();
		const nodes = renderer.nodePoints.geometry;
		const tree = renderer.hierarchySegments.geometry;
		const links = renderer.linkSegments.geometry;
		for (const visibility of ['auto', 'hover'] as const) {
			renderer.setActive({ ...emptyActiveState(), activeNodeId: 'A', labelNodes: new Set(['A']), dimOthers: true }, visibility);
			renderer.setData(graph, layout, visibility);
			expect(renderer.nodePoints.geometry).toBe(nodes);
			expect(renderer.hierarchySegments.geometry).toBe(tree);
			expect(renderer.linkSegments.geometry).toBe(links);
		}
		const reused = snapshot(renderer);
		const oldLabel = renderer.labelElements.get('A');
		renderer.sceneAppearance = null;
		renderer.setData(graph, layout, 'hover');
		const rebuilt = snapshot(renderer);
		expect(reused).toEqual(rebuilt);
		expect(renderer.labelElements.get('A')).not.toBe(oldLabel);
	});

	it('rebuilds for changed guides, theme, geometry and interrupted reveal depth', () => {
		const { renderer, graph, layout } = fixture();
		let previous = renderer.nodePoints.geometry;
		renderer.setData(graph, layout, 'auto', true);
		expect(renderer.ringSegments).not.toBeNull();
		expect(renderer.nodePoints.geometry).not.toBe(previous);
		previous = renderer.nodePoints.geometry;
		renderer.setTheme('day');
		renderer.setData(graph, layout, 'auto', true);
		expect(renderer.nodePoints.geometry).not.toBe(previous);
		renderer.setRevealDepthLimit(0);
		expect(renderer.nodePoints.geometry.getAttribute('position').count).toBe(1);
		previous = renderer.nodePoints.geometry;
		renderer.setData(graph, layout, 'auto', true);
		expect(renderer.nodePoints.geometry).toBe(previous);
		// showLoadingMask resets the limit before delivering its next graph.
		renderer.revealDepthLimit = Infinity;
		renderer.setData(graph, layout, 'auto', true);
		expect(renderer.nodePoints.geometry.getAttribute('position').count).toBe(graph.nodes.length);
		previous = renderer.nodePoints.geometry;
		renderer.setData(graph, structuredClone(layout), 'auto', true);
		expect(renderer.nodePoints.geometry).not.toBe(previous);
		renderer.setData(graph, layout, 'auto', true);
		previous = renderer.nodePoints.geometry;
		vi.stubGlobal('window', { devicePixelRatio: 2 });
		renderer.setData(graph, layout, 'auto', true);
		expect(renderer.nodePoints.geometry).not.toBe(previous);
	});
});
