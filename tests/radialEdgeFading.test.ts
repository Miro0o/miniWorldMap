import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferGeometry, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, OrthographicCamera, Points, Scene, ShaderMaterial } from 'three';
import { MIN_RADIAL_ZOOM, RadialRenderer, emptyActiveState, type RadialResolvedScheme } from '../src/render/RadialRenderer';
import type { RadialLayout, RadialPoint } from '../src/layout/radial/layoutRadial';
import type { VisibleWorldGraph, WorldEdge, WorldNode } from '../src/world/types';

type EdgeRenderer = Pick<RadialRenderer, 'setView' | 'setActive'> & {
	hierarchySegments: LineSegments<BufferGeometry, LineBasicMaterial>;
	linkSegments: LineSegments<BufferGeometry, LineBasicMaterial>;
	highlightSegments: Mesh<BufferGeometry, MeshBasicMaterial>;
	nodePoints: Points<BufferGeometry, ShaderMaterial>;
	buildEdges(edges: WorldEdge[], layout: RadialLayout, kind: 'hierarchy' | 'links'): void;
	buildNodes(graph: VisibleWorldGraph, layout: RadialLayout): void;
};

function renderer(scheme: RadialResolvedScheme): EdgeRenderer {
	const points: RadialPoint[] = [0, 100, 200].map((x, depth) => ({
		x, y: 0, homeX: x, homeY: 0, radius: x, homeRadius: x,
		angle: 0, homeAngle: 0, depth, nodeRadius: 8, centerX: 0, centerY: 0, external: false,
	}));
	const layout: RadialLayout = {
		positions: new Map(points.map((point, i) => [String(i), point])), rings: [], routes: new Map(),
		bounds: { minX: 0, minY: 0, maxX: 200, maxY: 0 }, width: 200, height: 1,
		centerX: 0, centerY: 0, ringSpacing: 1160, nodeSpacing: 144,
	};
	const hierarchy: WorldEdge = { id: 'tree', type: 'hierarchy', source: '0', target: '1', weight: 1 };
	const links: WorldEdge[] = [
		{ id: 'note', type: 'visible-link', source: '1', target: '2', weight: 1 },
		{ id: 'outside', type: 'visible-link', source: '0', target: '2', weight: 1, externalCount: 1 },
		{ id: 'missing', type: 'unresolved-link', source: '2', target: '0', weight: 1, unresolvedCount: 1 },
	];
	const allEdgeVisuals = new Map([hierarchy, ...links].map((edge) => [edge.id, {
		key: edge.id, edge, points: [layout.positions.get(edge.source)!, layout.positions.get(edge.target)!],
	}]));
	const nodes: WorldNode[] = points.map((point, i) => ({
		id: String(i), path: String(i), title: String(i), type: i === 1 ? 'folder' : 'note',
		parentId: '', depth: point.depth, noteCount: 1, linkCount: 1, backlinkCount: 1, descendantCount: 0,
	}));
	const graph: VisibleWorldGraph = {
		nodes, nodesById: new Map(nodes.map((node) => [node.id, node])), hierarchyEdges: [hierarchy], linkEdges: links,
		hoverLinkEdges: [], rootId: '0', focusId: null, hiddenNodeCount: 0, externalNodeCount: 0,
		externalFileCount: 0, externalGroupCount: 0,
	};
	// Exercise the actual line materials and interaction methods without a WebGL canvas.
	const result = Object.assign(Object.create(RadialRenderer.prototype), {
		graph: null, layout: null, centerX: 0, centerY: 0, width: 1200, height: 800,
		zoom: 1, scheme, revealDepthLimit: Infinity, active: emptyActiveState(),
		allEdgeVisuals, edgeVisuals: new Map(), scene: new Scene(),
		camera: new OrthographicCamera(), renderer: { render() {} },
		nodeGeometry: null, nodeMaterial: null, currentLabelVisibility: 'hover',
	}) as EdgeRenderer;
	result.buildEdges([hierarchy], layout, 'hierarchy');
	result.buildEdges(links, layout, 'links');
	result.buildNodes(graph, layout);
	result.setActive(emptyActiveState(), 'hover');
	return result;
}

beforeEach(() => vi.stubGlobal('window', { devicePixelRatio: 1 }));
afterEach(() => vi.unstubAllGlobals());

describe.each(['day', 'night'] as const)('%s link zoom fading', (scheme) => {
	it('fades continuously with hierarchy priority, reuses geometry, and restores close views', () => {
		const r = renderer(scheme);
		const tree = r.hierarchySegments.material;
		const links = r.linkSegments.material;
		const baseTree = tree.opacity;
		const baseLinks = links.opacity;
		const treeGeometry = r.hierarchySegments.geometry;
		const linkGeometry = r.linkSegments.geometry;
		let previousTree = baseTree;
		let previousLinks = baseLinks;
		// Small multiplicative steps also detect abrupt opacity changes at fade boundaries.
		for (let zoom = 1; zoom >= MIN_RADIAL_ZOOM; zoom /= 1.05) {
			r.setView(0, 0, zoom);
			expect(tree.opacity).toBeGreaterThan(0);
			expect(links.opacity).toBeGreaterThan(0);
			expect(tree.opacity).toBeLessThanOrEqual(previousTree);
			expect(links.opacity).toBeLessThanOrEqual(previousLinks);
			expect(tree.opacity / baseTree).toBeGreaterThanOrEqual(links.opacity / baseLinks);
			expect((previousTree - tree.opacity) / baseTree).toBeLessThan(0.03);
			expect((previousLinks - links.opacity) / baseLinks).toBeLessThan(0.03);
			previousTree = tree.opacity;
			previousLinks = links.opacity;
		}
		expect(tree.opacity).toBeLessThan(baseTree / 3);
		expect(links.opacity).toBeLessThan(baseLinks / 10);
		r.setView(40, -20, MIN_RADIAL_ZOOM);
		expect(tree.opacity).toBeCloseTo(previousTree);
		expect(links.opacity).toBeCloseTo(previousLinks);
		for (const zoom of [0.5, 1, 6]) {
			r.setView(40, -20, zoom);
			expect(tree.opacity).toBeCloseTo(baseTree);
			expect(links.opacity).toBeCloseTo(baseLinks);
		}
		expect(r.hierarchySegments.geometry).toBe(treeGeometry);
		expect(r.linkSegments.geometry).toBe(linkGeometry);
	});

	it('preserves highlights and the current zoom fade when hover or pins change', () => {
		const r = renderer(scheme);
		r.setView(0, 0, 0.02);
		const farTree = r.hierarchySegments.material.opacity;
		const farLinks = r.linkSegments.material.opacity;
		r.setView(0, 0, 1);
		const active = {
			...emptyActiveState(), hasActive: true, dimOthers: true,
			highlightedEdges: new Set(['tree', 'note', 'outside', 'missing']),
			pinnedNodeIds: new Set(['0']),
		};
		r.setActive(active, 'hover');
		const highlightOpacity = r.highlightSegments.material.opacity;
		const highlightedVertices = r.highlightSegments.geometry.getAttribute('position').count;
		expect(highlightedVertices).toBeGreaterThan(0);
		r.setView(0, 0, 0.02);
		expect(r.highlightSegments.material.opacity).toBe(highlightOpacity);
		expect(r.highlightSegments.geometry.getAttribute('position').count).toBe(highlightedVertices);
		expect(r.hierarchySegments.material.opacity).toBeLessThan(farTree);
		expect(r.linkSegments.material.opacity).toBeLessThan(farLinks);
		r.setActive({ ...active, dimOthers: false }, 'hover');
		expect(r.highlightSegments.material.opacity).toBe(highlightOpacity);
		expect(r.hierarchySegments.material.opacity).toBeCloseTo(farTree);
		expect(r.linkSegments.material.opacity).toBeCloseTo(farLinks);
		r.setActive(emptyActiveState(), 'hover');
		expect(r.hierarchySegments.material.opacity).toBeCloseTo(farTree);
		expect(r.linkSegments.material.opacity).toBeCloseTo(farLinks);
	});

	it('keeps nodes above highlights and narrows the hierarchy band in distant views', () => {
		const r = renderer(scheme);
		r.setActive({ ...emptyActiveState(), hasActive: true, highlightedEdges: new Set(['tree']) }, 'hover');
		const screenWidths: number[] = [];
		for (const zoom of [1, 0.1, 0.01, MIN_RADIAL_ZOOM]) {
			r.setView(0, 0, zoom);
			const positions = r.highlightSegments.geometry.getAttribute('position');
			const width = Math.abs(positions.getY(0) - positions.getY(1)) * zoom;
			screenWidths.push(width);
			expect(width).toBeGreaterThan(0);
			// A highlight must leave most of even the smallest node's diameter visible.
			expect(width).toBeLessThan(r.nodePoints.material.uniforms['uMinPoint']!.value / 2);
			expect(r.nodePoints.renderOrder).toBeGreaterThan(r.highlightSegments.renderOrder);
			expect(r.highlightSegments.renderOrder).toBeGreaterThan(r.hierarchySegments.renderOrder);
			expect(r.highlightSegments.renderOrder).toBeGreaterThan(r.linkSegments.renderOrder);
		}
		for (let i = 1; i < screenWidths.length; i++) expect(screenWidths[i]!).toBeLessThan(screenWidths[i - 1]!);
		expect(screenWidths[screenWidths.length - 1]!).toBeLessThan(screenWidths[0]! * 0.8);
		r.setView(0, 0, 1);
		const restored = r.highlightSegments.geometry.getAttribute('position');
		expect(Math.abs(restored.getY(0) - restored.getY(1))).toBeCloseTo(screenWidths[0]!);
	});
});
