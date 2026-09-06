import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, Scene } from 'three';
import { RadialRenderer, emptyActiveState, type RadialActiveState } from '../src/render/RadialRenderer';
import { RadialLabelOccupancy, radialLabelBounds } from '../src/render/radialLabelPlacement';
import type { RadialLayout, RadialPoint } from '../src/layout/radial/layoutRadial';
import type { LabelVisibility } from '../src/settings';
import type { VisibleWorldGraph, WorldNode } from '../src/world/types';

class TestLabel {
	className = '';
	textContent = '';
	style: Record<string, string> = {};
	setText(text: string): void { this.textContent = text; }
	addClass(name: string): void { this.className += ` ${name}`; }
	remove(): void {}
}

type LabelRenderer = Pick<RadialRenderer, 'setView' | 'resize'> & {
	labelElements: Map<string, TestLabel>;
	active: RadialActiveState;
	buildNodes(graph: VisibleWorldGraph, layout: RadialLayout): void;
	updateLabels(visibility?: LabelVisibility): void;
};

function node(id: string, type: WorldNode['type'] = 'note', overrides: Partial<WorldNode> = {}): WorldNode {
	return {
		id, path: id, title: id, type, parentId: '', depth: 1,
		noteCount: 1, linkCount: 0, backlinkCount: 0, descendantCount: 0,
		...overrides,
	};
}

function renderer(entries: { node: WorldNode; x: number; y?: number }[], options: { width?: number; height?: number; rootId?: string; focusId?: string; depthLimit?: number } = {}): LabelRenderer {
	const nodes = entries.map(({ node }) => node);
	const graph: VisibleWorldGraph = {
		nodes, nodesById: new Map(nodes.map((node) => [node.id, node])),
		hierarchyEdges: [], linkEdges: [], hoverLinkEdges: [], rootId: options.rootId ?? '', focusId: options.focusId ?? null,
		hiddenNodeCount: 0, externalNodeCount: 0, externalFileCount: 0, externalGroupCount: 0,
	};
	const positions = new Map<string, RadialPoint>(entries.map(({ node, x, y = 0 }) => [node.id, {
		x, y, homeX: x, homeY: y, radius: Math.hypot(x, y), homeRadius: Math.hypot(x, y),
		angle: 0, homeAngle: 0, depth: node.depth, nodeRadius: 8, centerX: 0, centerY: 0, external: false,
	}]));
	const layout: RadialLayout = {
		positions, rings: [], routes: new Map(), bounds: { minX: -10000, minY: -10000, maxX: 10000, maxY: 10000 },
		width: 20000, height: 20000, centerX: 0, centerY: 0, ringSpacing: 1160, nodeSpacing: 144,
	};
	const result = Object.assign(Object.create(RadialRenderer.prototype), {
		graph, layout, centerX: 0, centerY: 0, width: options.width ?? 1200, height: options.height ?? 800,
		zoom: 1, scheme: 'night', revealDepthLimit: options.depthLimit ?? Infinity,
		currentLabelVisibility: 'auto', active: emptyActiveState(), scene: new Scene(),
		camera: new OrthographicCamera(), renderer: { render() {}, setSize() {} },
		labelRoot: { createDiv: () => new TestLabel(), appendChild() {} }, labelElements: new Map(),
	}) as LabelRenderer;
	result.buildNodes(graph, layout);
	return result;
}

beforeEach(() => vi.stubGlobal('window', { devicePixelRatio: 1 }));
afterEach(() => vi.unstubAllGlobals());

describe('automatic radial labels', () => {
	it('gives even a small folder priority over a highly connected note at the same position', () => {
		const r = renderer([
			{ node: node('Hub', 'note', { linkCount: 100000, backlinkCount: 100000 }), x: 0 },
			{ node: node('Folder', 'folder', { depth: 8 }), x: 0 },
		]);
		r.setView(0, 0, 0.01);
		expect([...r.labelElements.keys()]).toEqual(['Folder']);
	});

	it('shows readable folder and note names below the former absolute zoom cutoff', () => {
		const r = renderer([
			{ node: node('Folder', 'folder'), x: -200000 },
			{ node: node('Note'), x: 200000 },
		]);
		r.setView(0, 0, 0.001);
		expect([...r.labelElements.keys()]).toEqual(['Folder', 'Note']);
		expect(Number(r.labelElements.get('Folder')!.style.opacity)).toBeGreaterThan(Number(r.labelElements.get('Note')!.style.opacity));
	});

	it('reveals notes after folders as zoom creates room, and hides them again when zooming out', () => {
		const r = renderer([
			{ node: node('Folder', 'folder'), x: 0 },
			{ node: node('Note'), x: 1200 },
		]);
		r.setView(0, 0, 0.01);
		expect([...r.labelElements.keys()]).toEqual(['Folder']);
		r.setView(0, 0, 0.1);
		expect([...r.labelElements.keys()]).toEqual(['Folder', 'Note']);
		r.setView(0, 0, 0.01);
		expect([...r.labelElements.keys()]).toEqual(['Folder']);
	});

	it('keeps folder priority when the automatic label budget is exhausted', () => {
		const folders = Array.from({ length: 40 }, (_, i) => ({
			node: node(`F${i}`, 'folder'), x: ((i % 5) * 100 - 200) / 0.001, y: (Math.floor(i / 5) * 50 - 200) / 0.001,
		}));
		const r = renderer([{ node: node('Hub', 'note', { linkCount: 100000 }), x: 0, y: 300000 }, ...folders], { width: 600, height: 600 });
		r.setView(0, 0, 0.001);
		expect(r.labelElements.size).toBeGreaterThan(0);
		expect(r.labelElements.size).toBeLessThan(folders.length);
		expect(r.labelElements.has('Hub')).toBe(false);
	});

	it('reserves hovered and pinned names before automatic folders, independent of zoom', () => {
		const r = renderer([
			{ node: node('Folder', 'folder'), x: 0 },
			{ node: node('Hovered'), x: 0 },
			{ node: node('Pinned'), x: 0 },
		]);
		r.active.activeNodeId = 'Hovered';
		r.active.pinnedNodeIds.add('Pinned');
		r.setView(0, 0, 0.001);
		expect([...r.labelElements.keys()].sort()).toEqual(['Hovered', 'Pinned']);
	});

	it('preserves root, focus and highlighted labels in hover-only mode across zoom, pan and resize', () => {
		const r = renderer([
			{ node: node('Folder', 'folder'), x: 0 },
			{ node: node('Root', 'folder'), x: -10000 },
			{ node: node('Focus'), x: 10000 },
			{ node: node('Related'), x: 0 },
		], { rootId: 'Root', focusId: 'Focus' });
		r.active.labelNodes.add('Related');
		r.updateLabels('hover');
		r.setView(500, 0, 0.001);
		r.resize(900, 700);
		expect([...r.labelElements.keys()].sort()).toEqual(['Focus', 'Related', 'Root']);
	});

	it('does not let offscreen or unrevealed folders suppress a visible note', () => {
		const r = renderer([
			{ node: node('Offscreen', 'folder'), x: -1000000 },
			{ node: node('Unrevealed', 'folder', { depth: 3 }), x: 0 },
			{ node: node('Note'), x: 0 },
		], { depthLimit: 1 });
		r.setView(0, 0, 0.001);
		expect([...r.labelElements.keys()]).toEqual(['Note']);
		r.setView(-1000000, 0, 0.001);
		expect([...r.labelElements.keys()]).toEqual(['Offscreen']);
	});
});

describe('label placement', () => {
	it('detects overlaps across grid boundaries, including partially offscreen labels', () => {
		const occupied = new RadialLabelOccupancy();
		occupied.add({ minX: -20, maxX: 140, minY: -20, maxY: 140 });
		expect(occupied.intersects({ minX: -30, maxX: -10, minY: -30, maxY: -10 })).toBe(true);
		expect(occupied.intersects({ minX: 130, maxX: 160, minY: 130, maxY: 160 })).toBe(true);
		expect(occupied.intersects({ minX: 141, maxX: 160, minY: 141, maxY: 160 })).toBe(false);
	});

	it('reserves multiple lines for long English and Chinese names', () => {
		for (const title of ['A long folder name with multiple words', '这是一个需要换行显示的文件夹名称']) {
			const bounds = radialLabelBounds(title, 0, 0, 12, 80, 4);
			expect(bounds.maxX - bounds.minX).toBeLessThanOrEqual(80 + 14);
			expect(bounds.maxY - bounds.minY).toBeGreaterThan(12 * 1.17 * 2);
			const occupied = new RadialLabelOccupancy();
			occupied.add(bounds);
			expect(occupied.intersects(radialLabelBounds('Next', 0, 24, 12, 80, 4))).toBe(true);
		}
	});
});
