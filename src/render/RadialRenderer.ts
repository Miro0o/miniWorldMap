import {
	BufferAttribute,
	BufferGeometry,
	Color,
	LineBasicMaterial,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	OrthographicCamera,
	Points,
	Scene,
	ShaderMaterial,
	Vector3,
	WebGLRenderer,
} from 'three';
import type { LabelVisibility } from '../settings';
import type { RadialLayout, RadialPoint, RadialRoute } from '../layout/radial/layoutRadial';
import type { VisibleWorldGraph, WorldEdge, WorldNode } from '../world/types';
import { NODE_FRAGMENT_SHADER, NODE_VERTEX_SHADER } from './shaders';

export interface RadialActiveState {
	hasActive: boolean;
	dimOthers: boolean;
	activeNodeId: string | null;
	activeLinkId: string | null;
	relatedNodes: Set<string>;
	highlightedEdges: Set<string>;
	labelNodes: Set<string>;
	pinnedNodeIds: Set<string>;
}

interface EdgeVisual {
	key: string;
	edge: WorldEdge;
	points: { x: number; y: number }[];
}

export type RadialResolvedScheme = 'day' | 'night';

interface RadialPalette {
	bg: string;
	ring: string;
	tree: string;
	link: string;
	external: string;
	externalLink: string;
	unresolved: string;
	focus: string;
	folder: string;
	folderMeta: string;
	note: string;
	root: string;
	ringOpacity: number;
	treeOpacity: number;
	linkOpacity: number;
	externalLinkOpacity: number;
	highlightOpacity: number;
	nodeScale: number;
	maxLabels: number;
}

const PALETTES: Record<RadialResolvedScheme, RadialPalette> = {
	day: {
		bg: '#f7f8fb',
		ring: '#94a3b8',
		tree: '#5b677a',
		link: '#525e70',
		external: '#5b5fe0',
		externalLink: '#cb7622',
		unresolved: '#dc2626',
		focus: '#5368ee',
		folder: '#3f4a5a',
		folderMeta: '#4f5ee8',
		note: '#536073',
		root: '#4f5ee8',
		ringOpacity: 0.16,
		treeOpacity: 0.17,
		linkOpacity: 0.06,
		externalLinkOpacity: 0.08,
		highlightOpacity: 0.9,
		nodeScale: 0.19,
		maxLabels: 140,
	},
	night: {
		bg: '#0f1117',
		ring: '#818cf8',
		tree: '#818cf8',
		link: '#94a3b8',
		external: '#c4b5fd',
		externalLink: '#fb923c',
		unresolved: '#fb7185',
		focus: '#aab6ff',
		folder: '#d7dae2',
		folderMeta: '#f59e0b',
		note: '#a1a8b5',
		root: '#7c9cff',
		ringOpacity: 0.15,
		treeOpacity: 0.18,
		linkOpacity: 0.065,
		externalLinkOpacity: 0.09,
		highlightOpacity: 0.98,
		nodeScale: 0.2,
		maxLabels: 140,
	},
};

export class RadialRenderer {
	readonly renderer: WebGLRenderer;
	readonly camera: OrthographicCamera;
	readonly domElement: HTMLCanvasElement;

	private scene = new Scene();
	private labelRoot: HTMLElement;
	private ringSegments: Mesh | null = null;
	private hierarchySegments: LineSegments | null = null;
	private linkSegments: LineSegments | null = null;
	private highlightSegments: Mesh | null = null;
	private nodePoints: Points | null = null;
	private nodeGeometry: BufferGeometry | null = null;
	private nodeMaterial: ShaderMaterial | null = null;
	private nodeIds: string[] = [];
	private edgeVisuals = new Map<string, EdgeVisual>();
	private graph: VisibleWorldGraph | null = null;
	private layout: RadialLayout | null = null;
	private active: RadialActiveState = emptyActiveState();
	private width = 1;
	private height = 1;
	private centerX = 0;
	private centerY = 0;
	private zoom = 1;
	private scheme: RadialResolvedScheme = 'night';
	private revealFrame = 0;
	private revealOverlay: HTMLElement | null = null;

	constructor(private container: HTMLElement) {
		this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setClearColor(this.palette().bg, 1);
		this.domElement = this.renderer.domElement;
		this.domElement.classList.add('mwm-radial-canvas');
		this.domElement.tabIndex = 0;
		container.appendChild(this.domElement);
		this.labelRoot = container.createDiv({ cls: 'mwm-radial-labels' });
		this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
		this.camera.position.set(0, 0, 1000);
		this.camera.lookAt(0, 0, 0);
	}

	setTheme(scheme: RadialResolvedScheme): boolean {
		if (this.scheme === scheme) return false;
		this.scheme = scheme;
		this.renderer.setClearColor(this.palette().bg, 1);
		if (this.nodeMaterial) {
			const lightMode = this.nodeMaterial.uniforms['uLightMode'];
			const pixelScale = this.nodeMaterial.uniforms['uPixelScale'];
			if (lightMode) lightMode.value = scheme === 'day' ? 1 : 0;
			if (pixelScale) pixelScale.value = 1000 * Math.min(window.devicePixelRatio || 1, 2);
			this.updateNodeScale();
		}
		this.render();
		return true;
	}

	setData(graph: VisibleWorldGraph, layout: RadialLayout, labelVisibility: LabelVisibility): void {
		this.graph = graph;
		this.layout = layout;
		this.edgeVisuals.clear();
		this.disposeObjects();
		this.buildRings();
		this.buildEdges(graph.hierarchyEdges, layout, 'hierarchy');
		this.buildEdges(graph.linkEdges, layout, 'links');
		for (const edge of graph.hoverLinkEdges) {
			if (this.edgeVisuals.has(edge.id)) continue;
			const visual = this.edgeVisual(edge, layout);
			if (visual) this.edgeVisuals.set(visual.key, visual);
		}
		this.buildNodes(graph, layout);
		this.setActive(this.active, labelVisibility);
		this.render();
	}

	resize(width: number, height: number): void {
		this.width = Math.max(1, Math.floor(width));
		this.height = Math.max(1, Math.floor(height));
		this.renderer.setSize(this.width, this.height, false);
		this.camera.left = -this.width / 2;
		this.camera.right = this.width / 2;
		this.camera.top = this.height / 2;
		this.camera.bottom = -this.height / 2;
		this.applyCamera();
		this.updateLabels();
	}

	setView(centerX: number, centerY: number, zoom: number): void {
		this.centerX = Number.isFinite(centerX) ? centerX : 0;
		this.centerY = Number.isFinite(centerY) ? centerY : 0;
		this.zoom = Math.min(Math.max(Number.isFinite(zoom) ? zoom : 1, 0.003), 6);
		this.updateNodeScale();
		this.applyCamera();
		const rebuiltHighlights = this.active.highlightedEdges.size > 0;
		if (rebuiltHighlights) this.rebuildHighlights();
		this.updateLabels();
		if (rebuiltHighlights) this.render();
	}

	getView(): { centerX: number; centerY: number; zoom: number } {
		return { centerX: this.centerX, centerY: this.centerY, zoom: this.zoom };
	}

	fitToLayout(): void {
		if (!this.layout) return;
		const padding = 160;
		const w = Math.max(1, this.layout.bounds.maxX - this.layout.bounds.minX + padding * 2);
		const h = Math.max(1, this.layout.bounds.maxY - this.layout.bounds.minY + padding * 2);
		const zoom = Math.min(this.width / w, this.height / h, 1.2) * 0.92;
		this.setView((this.layout.bounds.minX + this.layout.bounds.maxX) / 2, (this.layout.bounds.minY + this.layout.bounds.maxY) / 2, zoom);
	}

	playRevealFromRoot(rootId: string, text: string, durMs = 1200): void {
		if (!this.layout || this.width < 2 || this.height < 2) return;
		cancelAnimationFrame(this.revealFrame);
		this.revealOverlay?.remove();
		const root = this.layout.positions.get(rootId) ?? { x: 0, y: 0 };
		const screen = this.worldToScreen(root.x, root.y);
		const maxRadius = Math.hypot(Math.max(screen.x, this.width - screen.x), Math.max(screen.y, this.height - screen.y)) + 120;
		const start = performance.now();
		this.container.style.setProperty('--mwm-reveal-x', `${screen.x.toFixed(1)}px`);
		this.container.style.setProperty('--mwm-reveal-y', `${screen.y.toFixed(1)}px`);
		this.container.style.setProperty('--mwm-reveal-radius', '0px');
		this.container.addClass('is-radial-revealing');
		this.revealOverlay = this.container.createDiv({ cls: 'mwm-radial-loading gx-mask-text', text });
		const step = (now: number) => {
			const p = Math.min(Math.max((now - start) / durMs, 0), 1);
			const eased = 1 - Math.pow(1 - p, 3);
			this.container.style.setProperty('--mwm-reveal-radius', `${(maxRadius * eased).toFixed(1)}px`);
			if (p < 1) {
				this.revealFrame = window.requestAnimationFrame(step);
				return;
			}
			this.container.removeClass('is-radial-revealing');
			this.revealOverlay?.addClass('is-fading');
			window.setTimeout(() => {
				this.revealOverlay?.remove();
				this.revealOverlay = null;
			}, 220);
		};
		this.revealFrame = window.requestAnimationFrame(step);
	}

	setActive(active: RadialActiveState, labelVisibility: LabelVisibility): void {
		this.active = active;
		this.updateNodeDim();
		this.rebuildHighlights();
		this.updateLabels(labelVisibility);
		this.render();
	}

	render(): void {
		this.renderer.render(this.scene, this.camera);
	}

	worldToScreen(x: number, y: number): { x: number; y: number } {
		const projected = new Vector3(x, y, 0).project(this.camera);
		return {
			x: ((projected.x + 1) / 2) * this.width,
			y: ((1 - projected.y) / 2) * this.height,
		};
	}

	screenToWorld(x: number, y: number): { x: number; y: number } {
		return {
			x: this.centerX + (x - this.width / 2) / this.zoom,
			y: this.centerY - (y - this.height / 2) / this.zoom,
		};
	}

	hitTest(
		screenX: number,
		screenY: number,
		includeLinks: boolean,
		includeNodes = true,
	): { nodeId: string | null; edge: WorldEdge | null } {
		if (!this.graph || !this.layout) return { nodeId: null, edge: null };
		const world = this.screenToWorld(screenX, screenY);
		let bestNode: { id: string; distance: number } | null = null;
		if (includeNodes) {
			for (const node of this.graph.nodes) {
				const point = this.layout.positions.get(node.id);
				if (!point) continue;
				const distance = Math.hypot(world.x - point.x, world.y - point.y);
				const visualRadius = Math.max(4, point.nodeRadius * this.palette().nodeScale * nodeScreenScale(this.zoom) * 0.55);
				const radius = Math.max(point.nodeRadius * 0.36, visualRadius / Math.max(0.003, this.zoom)) + Math.max(5, 6 / this.zoom);
				if (distance <= radius && (!bestNode || distance < bestNode.distance)) bestNode = { id: node.id, distance };
			}
		}
		if (bestNode) return { nodeId: bestNode.id, edge: null };
		if (!includeLinks) return { nodeId: null, edge: null };
		let bestEdge: { edge: WorldEdge; distance: number } | null = null;
		for (const visual of this.edgeVisuals.values()) {
			if (visual.edge.type === 'hierarchy' || visual.edge.type === 'external-hierarchy') continue;
			const distance = distanceToPolyline(world, visual.points);
			if (distance <= Math.max(10, 8 / this.zoom) && (!bestEdge || distance < bestEdge.distance)) {
				bestEdge = { edge: visual.edge, distance };
			}
		}
		return { nodeId: null, edge: bestEdge?.edge ?? null };
	}

	nodePoint(nodeId: string): RadialPoint | null {
		return this.layout?.positions.get(nodeId) ?? null;
	}

	dispose(): void {
		cancelAnimationFrame(this.revealFrame);
		this.disposeObjects();
		this.renderer.dispose();
		this.revealOverlay?.remove();
		this.domElement.remove();
		this.labelRoot.remove();
	}

	private palette(): RadialPalette {
		return PALETTES[this.scheme];
	}

	private applyCamera(): void {
		this.camera.position.set(this.centerX, this.centerY, 1000);
		this.camera.zoom = this.zoom;
		this.camera.updateProjectionMatrix();
		this.render();
	}

	private buildRings(): void {
		this.ringSegments = null;
	}

	private buildEdges(edges: WorldEdge[], layout: RadialLayout, kind: 'hierarchy' | 'links'): void {
		const positions: number[] = [];
		const colors: number[] = [];
		const palette = this.palette();
		for (const edge of edges) {
			const visual = this.edgeVisual(edge, layout);
			if (!visual) continue;
			this.edgeVisuals.set(visual.key, visual);
			const color = edgeColor(edge, kind, palette);
			for (let i = 0; i < visual.points.length - 1; i++) {
				const a = visual.points[i];
				const b = visual.points[i + 1];
				if (!a || !b) continue;
				positions.push(a.x, a.y, kind === 'hierarchy' ? -1 : -2);
				positions.push(b.x, b.y, kind === 'hierarchy' ? -1 : -2);
				pushColor(colors, color, kind === 'hierarchy' ? 0.46 : edge.externalCount ? 0.22 : 0.16);
				pushColor(colors, color, kind === 'hierarchy' ? 0.46 : edge.externalCount ? 0.22 : 0.16);
			}
		}
		const line = new LineSegments(
			makeLineGeometry(positions, colors),
			new LineBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: kind === 'hierarchy' ? palette.treeOpacity : edges.some((edge) => edge.externalCount) ? palette.externalLinkOpacity : palette.linkOpacity,
				depthWrite: false,
			}),
		);
		if (kind === 'hierarchy') this.hierarchySegments = line;
		else this.linkSegments = line;
		this.scene.add(line);
	}

	private buildNodes(graph: VisibleWorldGraph, layout: RadialLayout): void {
		const palette = this.palette();
		const positions = new Float32Array(graph.nodes.length * 3);
		const colors = new Float32Array(graph.nodes.length * 3);
		const sizes = new Float32Array(graph.nodes.length);
		const ghost = new Float32Array(graph.nodes.length);
		const dim = new Float32Array(graph.nodes.length).fill(1);
		this.nodeIds = graph.nodes.map((node) => node.id);
		graph.nodes.forEach((node, index) => {
			const point = layout.positions.get(node.id);
			const color = nodeColor(node, graph.rootId, palette);
			positions[index * 3] = point?.x ?? 0;
			positions[index * 3 + 1] = point?.y ?? 0;
			positions[index * 3 + 2] = 1;
			colors[index * 3] = color.r;
			colors[index * 3 + 1] = color.g;
			colors[index * 3 + 2] = color.b;
			sizes[index] = Math.max(2.1, (point?.nodeRadius ?? 8) * palette.nodeScale);
			ghost[index] = node.type === 'unresolved' || node.type === 'external' || node.externalProxy ? 1 : 0;
		});
		this.nodeGeometry = new BufferGeometry();
		this.nodeGeometry.setAttribute('position', new BufferAttribute(positions, 3));
		this.nodeGeometry.setAttribute('color', new BufferAttribute(colors, 3));
		this.nodeGeometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
		this.nodeGeometry.setAttribute('aGhost', new BufferAttribute(ghost, 1));
		this.nodeGeometry.setAttribute('aDim', new BufferAttribute(dim, 1));
		this.nodeMaterial = new ShaderMaterial({
			vertexShader: NODE_VERTEX_SHADER,
			fragmentShader: NODE_FRAGMENT_SHADER,
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			uniforms: {
				uPixelScale: { value: 1000 * Math.min(window.devicePixelRatio || 1, 2) },
				uSizeMul: { value: nodeScreenScale(this.zoom) },
				uLightMode: { value: this.scheme === 'day' ? 1 : 0 },
				uMaxPoint: { value: 58 * Math.min(window.devicePixelRatio || 1, 2) },
			},
		});
		this.nodePoints = new Points(this.nodeGeometry, this.nodeMaterial);
		this.nodePoints.frustumCulled = false;
		this.scene.add(this.nodePoints);
	}

	private updateNodeDim(): void {
		if (!this.nodeGeometry) return;
		const attr = this.nodeGeometry.getAttribute('aDim') as BufferAttribute;
		const dim = attr.array as Float32Array;
		for (let i = 0; i < this.nodeIds.length; i++) {
			const id = this.nodeIds[i] ?? '';
			const focused =
				id === this.active.activeNodeId || this.active.pinnedNodeIds.has(id) || id === this.graph?.focusId;
			const related = this.active.relatedNodes.has(id);
			dim[i] = this.active.dimOthers && !focused && !related ? 0.23 : focused ? 1.12 : related ? 0.95 : 0.82;
		}
		attr.needsUpdate = true;
	}

	private updateNodeScale(): void {
		if (!this.nodeMaterial) return;
		const sizeMul = this.nodeMaterial.uniforms['uSizeMul'];
		const maxPoint = this.nodeMaterial.uniforms['uMaxPoint'];
		if (sizeMul) sizeMul.value = nodeScreenScale(this.zoom);
		if (maxPoint) maxPoint.value = 58 * Math.min(window.devicePixelRatio || 1, 2);
	}

	private rebuildHighlights(): void {
		if (this.highlightSegments) {
			this.scene.remove(this.highlightSegments);
			this.highlightSegments.geometry.dispose();
			if (Array.isArray(this.highlightSegments.material)) this.highlightSegments.material.forEach((m) => m.dispose());
			else this.highlightSegments.material.dispose();
			this.highlightSegments = null;
		}
		const positions: number[] = [];
		const colors: number[] = [];
		const palette = this.palette();
		const color = new Color(palette.focus);
		const zoom = Math.max(0.003, this.zoom || 1);
		for (const key of this.active.highlightedEdges) {
			const visual = this.edgeVisuals.get(key);
			if (!visual) continue;
			for (let i = 0; i < visual.points.length - 1; i++) {
				const a = visual.points[i];
				const b = visual.points[i + 1];
				if (!a || !b) continue;
				pushSegmentBand(positions, colors, color, a, b, highlightWidthPx(visual.edge) / zoom, 2);
			}
		}
		this.highlightSegments = new Mesh(
			makeMeshGeometry(positions, colors),
			new MeshBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: palette.highlightOpacity,
				depthWrite: false,
				depthTest: false,
			}),
		);
		this.scene.add(this.highlightSegments);
	}

	private edgeVisual(edge: WorldEdge, layout: RadialLayout): EdgeVisual | null {
		const source = layout.positions.get(edge.source);
		const target = layout.positions.get(edge.target);
		if (!source || !target) return null;
		const route = layout.routes.get(edge.id);
		return {
			key: edge.id,
			edge,
			points: routePoints(source, target, route),
		};
	}

	private updateLabels(labelVisibility: LabelVisibility = 'auto'): void {
		if (!this.graph || !this.layout) return;
		this.labelRoot.empty();
		const directIds = new Set<string>([
			...this.active.labelNodes,
			...this.active.pinnedNodeIds,
			this.active.activeNodeId ?? '',
			this.graph.rootId,
			this.graph.focusId ?? '',
		]);
		directIds.delete('');
		const ranked = this.graph.nodes
			.map((node) => {
				const point = this.layout?.positions.get(node.id) ?? null;
				return point ? { node, point, score: labelScore(node, point, this.graph!) } : null;
			})
			.filter((item): item is { node: WorldNode; point: RadialPoint; score: number } => Boolean(item))
			.sort((a, b) => b.score - a.score);
		const denominator = Math.max(1, ranked.length - 1);
		const autoBudget =
			labelVisibility === 'auto' && this.zoom >= 0.08
				? Math.round(Math.min(this.palette().maxLabels, Math.max(0, (this.zoom - 0.08) * 84 + Math.sqrt(this.zoom) * 18)))
				: 0;
		let autoShown = 0;
		for (let rank = 0; rank < ranked.length; rank++) {
			const item = ranked[rank]!;
			const { node, point } = item;
			const direct = directIds.has(node.id);
			const strength = direct
				? 1
				: labelVisibility === 'auto'
					? zoomLabelStrength(node, point, this.zoom, rank, denominator, this.graph)
					: 0;
			if (!direct) {
				if (strength <= 0.08 || autoShown >= autoBudget) continue;
				autoShown++;
			}
			const screen = this.worldToScreen(point.x, point.y);
			if (screen.x < -160 || screen.y < -80 || screen.x > this.width + 160 || screen.y > this.height + 120) continue;
			const label = this.labelRoot.createDiv({ cls: node.id === this.graph.rootId ? 'mwm-radial-label is-root' : 'mwm-radial-label' });
			label.setText(node.title);
			const scale = labelScreenScale(this.zoom) * (node.id === this.graph.rootId ? 1.18 : point.nodeRadius >= 24 ? 1.1 : point.nodeRadius >= 15 ? 1.04 : 1);
			const fontSize = Math.max(node.id === this.graph.rootId ? 12 : 9.5, 12 * scale);
			label.style.fontSize = `${fontSize.toFixed(2)}px`;
			label.style.maxWidth = `${Math.round((node.id === this.graph.rootId ? 190 : node.type === 'folder' ? 156 : point.nodeRadius >= 18 ? 146 : 124) * scale)}px`;
			label.style.opacity = String(direct ? 0.96 : Math.min(0.9, 0.22 + strength * 0.68));
			const visualNodeRadius = Math.max(5, point.nodeRadius * this.palette().nodeScale * nodeScreenScale(this.zoom) * 0.62);
			const labelOffset = Math.max(9, visualNodeRadius + 6 * scale);
			label.style.transform = `translate3d(${screen.x.toFixed(1)}px, ${(screen.y + labelOffset).toFixed(1)}px, 0)`;
			if (this.active.dimOthers && !directIds.has(node.id) && !this.active.relatedNodes.has(node.id)) {
				label.style.opacity = String(Math.min(Number(label.style.opacity) || 1, 0.34));
				label.addClass('is-dim');
			}
		}
	}

	private disposeObjects(): void {
		for (const obj of [this.ringSegments, this.hierarchySegments, this.linkSegments, this.highlightSegments, this.nodePoints]) {
			if (!obj) continue;
			this.scene.remove(obj);
			if ('geometry' in obj) obj.geometry.dispose();
			const material = Array.isArray(obj.material) ? obj.material : [obj.material];
			for (const item of material) item.dispose();
		}
		this.ringSegments = null;
		this.hierarchySegments = null;
		this.linkSegments = null;
		this.highlightSegments = null;
		this.nodePoints = null;
		this.nodeGeometry = null;
		this.nodeMaterial = null;
		this.labelRoot.empty();
	}
}

export function emptyActiveState(): RadialActiveState {
	return {
		hasActive: false,
		dimOthers: false,
		activeNodeId: null,
		activeLinkId: null,
		relatedNodes: new Set(),
		highlightedEdges: new Set(),
		labelNodes: new Set(),
		pinnedNodeIds: new Set(),
	};
}

function makeLineGeometry(positions: number[], colors: number[]): BufferGeometry {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
	geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3));
	return geometry;
}

function makeMeshGeometry(positions: number[], colors: number[]): BufferGeometry {
	const geometry = makeLineGeometry(positions, colors);
	geometry.computeBoundingSphere();
	return geometry;
}

function pushSegmentBand(
	positions: number[],
	colors: number[],
	color: Color,
	a: { x: number; y: number },
	b: { x: number; y: number },
	width: number,
	z: number,
): void {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length = Math.hypot(dx, dy);
	if (!Number.isFinite(length) || length <= 0.001) return;
	const half = Math.max(0.1, width * 0.5);
	const nx = (-dy / length) * half;
	const ny = (dx / length) * half;
	const vertices = [
		[a.x + nx, a.y + ny, z],
		[a.x - nx, a.y - ny, z],
		[b.x - nx, b.y - ny, z],
		[a.x + nx, a.y + ny, z],
		[b.x - nx, b.y - ny, z],
		[b.x + nx, b.y + ny, z],
	];
	for (const vertex of vertices) {
		positions.push(vertex[0]!, vertex[1]!, vertex[2]!);
		pushColor(colors, color, 1);
	}
}

function pushColor(colors: number[], color: Color, alpha: number): void {
	void alpha;
	colors.push(color.r, color.g, color.b);
}

function nodeColor(node: WorldNode, rootId: string, palette: RadialPalette): Color {
	if (node.id === rootId) return new Color(palette.root);
	if (node.type === 'unresolved') return new Color(palette.unresolved);
	if (node.type === 'external' || node.externalProxy) return new Color(palette.external);
	if (node.type === 'folder' && node.representativeFile) return new Color(palette.folderMeta);
	if (node.type === 'folder') return new Color(palette.folder);
	return new Color(palette.note);
}

function edgeColor(edge: WorldEdge, kind: 'hierarchy' | 'links', palette: RadialPalette): Color {
	if (edge.unresolvedCount) return new Color(palette.unresolved);
	if (edge.externalCount) return new Color(kind === 'links' ? palette.externalLink : palette.external);
	return new Color(kind === 'hierarchy' ? palette.tree : palette.link);
}

function routePoints(source: RadialPoint, target: RadialPoint, route: RadialRoute | undefined): { x: number; y: number }[] {
	if (!route) return [source, target];
	if (route.kind === 'outer') {
		const points: { x: number; y: number }[] = [source];
		const start = route.sourceAngle;
		let end = route.endAngle ?? route.targetAngle;
		let delta = end - start;
		if (Math.abs(delta) > Math.PI) delta += delta > 0 ? -Math.PI * 2 : Math.PI * 2;
		end = start + delta;
		const steps = Math.max(8, Math.ceil(Math.abs(delta) / 0.18));
		for (let i = 0; i <= steps; i++) {
			const angle = start + (delta * i) / steps;
			points.push({
				x: route.centerX + Math.cos(angle) * route.radius,
				y: route.centerY + Math.sin(angle) * route.radius,
			});
		}
		points.push(target);
		return points;
	}
	const midX = (source.x + target.x) / 2;
	const midY = (source.y + target.y) / 2;
	const pull = route.curveStrength ?? 0.16;
	const ctrl = { x: midX - midX * pull, y: midY - midY * pull };
	const points: { x: number; y: number }[] = [];
	for (let i = 0; i <= 12; i++) {
		const t = i / 12;
		const a = (1 - t) * (1 - t);
		const b = 2 * (1 - t) * t;
		const c = t * t;
		points.push({ x: a * source.x + b * ctrl.x + c * target.x, y: a * source.y + b * ctrl.y + c * target.y });
	}
	return points;
}

function distanceToPolyline(point: { x: number; y: number }, points: { x: number; y: number }[]): number {
	let best = Infinity;
	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (!a || !b) continue;
		best = Math.min(best, distanceToSegment(point, a, b));
	}
	return best;
}

function distanceToSegment(point: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = dx * dx + dy * dy;
	if (len <= 1e-6) return Math.hypot(point.x - a.x, point.y - a.y);
	const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len));
	return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function highlightWidthPx(edge: WorldEdge): number {
	if (edge.type === 'hierarchy' || edge.type === 'external-hierarchy') return 3.1;
	if (edge.externalCount) return 3.6;
	return 4.1;
}

function labelScore(node: WorldNode, point: RadialPoint, graph: VisibleWorldGraph): number {
	const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
	let score = Math.max(0, point.nodeRadius || 0) * 2.8 + Math.log1p(degree) * 13 + Math.sqrt(degree) * 1.4 - Math.min(34, (node.depth || 0) * 3.2);
	if (node.id === graph.rootId) score += 10000;
	if (node.id === graph.focusId) score += 9000;
	if (node.type === 'folder') {
		score += 32 + Math.log1p(node.noteCount || node.descendantCount || 0) * 8;
		if (node.representativeFile) score += 8;
	} else if (node.type === 'note') {
		score += 10;
	} else if (node.type === 'external' || node.externalProxy) {
		score -= 10;
	} else if (node.type === 'unresolved') {
		score -= 22;
	}
	return score;
}

function zoomLabelStrength(
	node: WorldNode,
	point: RadialPoint,
	zoom: number,
	rank: number,
	denominator: number,
	graph: VisibleWorldGraph,
): number {
	const clampedZoom = clampNumber(zoom, 0.003, 6);
	const root = node.id === graph.rootId;
	if (root) return 0.68 + smoothstep(0.04, 0.2, clampedZoom) * 0.32;
	const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
	const folder = node.type === 'folder';
	const external = node.type === 'external' || node.externalProxy;
	const unresolved = node.type === 'unresolved';
	const sizeSignal = clampNumber((point.nodeRadius - 4) / 42, 0, 1);
	const degreeSignal = clampNumber(Math.log1p(degree) / Math.log1p(80), 0, 1);
	const salienceSignal = clampNumber(1 - rank / Math.max(1, denominator), 0, 1);
	const nodeCount = Math.max(1, graph.nodes.length || 1);
	const leading = rank < Math.max(10, Math.min(58, Math.ceil(nodeCount * 0.05)));
	const secondary = rank < Math.max(28, Math.min(170, Math.ceil(nodeCount * 0.18)));
	const tertiary = rank < Math.max(80, Math.min(520, Math.ceil(nodeCount * 0.38)));
	let threshold = 1.24 - sizeSignal * 0.64 - degreeSignal * 0.22 - salienceSignal * 0.42;

	if (leading) threshold -= 0.28;
	else if (secondary) threshold -= 0.2;
	else if (tertiary) threshold -= 0.08;
	if (folder) threshold -= node.representativeFile ? 0.18 : 0.12;
	else if (external) threshold -= 0.04;
	if (unresolved) threshold += 0.18;

	threshold = clampNumber(threshold, 0.16, 1.38);
	const fade = smoothstep(threshold - 0.14, threshold + 0.1, clampedZoom);
	const leadingFade = leading
		? smoothstep(0.12, 0.38, clampedZoom)
		: secondary
			? smoothstep(0.22, 0.62, clampedZoom) * 0.9
			: tertiary
				? smoothstep(0.46, 0.96, clampedZoom) * 0.7
				: 0;
	const largeFade =
		point.nodeRadius >= 24
			? smoothstep(0.22, 0.56, clampedZoom) * 0.96
			: point.nodeRadius >= 15
				? smoothstep(0.42, 0.86, clampedZoom) * 0.78
				: 0;
	const smallFade = !unresolved ? smoothstep(0.86, 1.28, clampedZoom) * 0.82 : 0;
	const closeFade = !unresolved ? smoothstep(1.12, 1.46, clampedZoom) * 0.98 : 0;
	return clampNumber(Math.max(fade, leadingFade, largeFade, smallFade, closeFade), 0, 1);
}

function labelScreenScale(zoom: number): number {
	const clampedZoom = clampNumber(zoom, 0.003, 6);
	return 0.62 + smoothstep(0.06, 1.48, clampedZoom) * 0.88;
}

function nodeScreenScale(zoom: number): number {
	const clampedZoom = clampNumber(zoom, 0.003, 6);
	return (
		0.7 +
		smoothstep(0.07, 0.36, clampedZoom) * 0.36 +
		smoothstep(0.36, 1.32, clampedZoom) * 0.82 +
		smoothstep(1.32, 3.2, clampedZoom) * 0.72 +
		smoothstep(3.2, 6, clampedZoom) * 0.28
	);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	if (edge0 === edge1) return value >= edge1 ? 1 : 0;
	const t = clampNumber((value - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

function clampNumber(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}
