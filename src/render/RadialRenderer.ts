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
	WebGLRenderer,
} from 'three';
import type { LabelVisibility } from '../settings';
import type { RadialLayout, RadialPoint, RadialRoute } from '../layout/radial/layoutRadial';
import { ROOT_ID, type VisibleWorldGraph, type WorldEdge, type WorldNode } from '../world/types';
import { RADIAL_NODE_FRAGMENT_SHADER, RADIAL_NODE_VERTEX_SHADER } from './shaders';
import { SpatialIndex, type SpatialBounds } from './SpatialIndex';
import { RadialLabelOccupancy, radialLabelBounds } from './radialLabelPlacement';

// Default floor for ordinary maps; larger layouts get room to zoom past their overview.
export const MIN_RADIAL_ZOOM = 0.00001;
export const MAX_RADIAL_ZOOM = 6;
const NODE_BASE_POINT = 4.8;
// Labels intentionally progress faster than geometry zoom so large maps reveal
// their important names without requiring several extra wheel gestures.
const LABEL_REVEAL_ACCELERATION = 2.2;

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
export type RadialEdgeHighlightKind = 'hierarchy' | 'note-link' | 'outside-link' | 'unresolved-link';
export type RadialNodeColorKind = 'root' | 'folder' | 'folder-note' | 'note' | 'outside-group' | 'outside-note' | 'unresolved';
export type RadialNodeShapeKind = 'root-ring' | 'folder-outline' | 'folder-note-solid' | 'note-dot' | 'outside-diamond' | 'outside-ring' | 'unresolved-cross';

interface RadialPalette {
	bg: string;
	ring: string;
	tree: string;
	link: string;
	externalGroup: string;
	externalNote: string;
	externalLink: string;
	unresolved: string;
	unresolvedLink: string;
	highlightHierarchy: string;
	highlightNoteLink: string;
	highlightOutsideLink: string;
	highlightUnresolvedLink: string;
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
		bg: '#f8fafc',
		ring: '#aeb7c5',
		tree: '#5679a6',
		link: '#8c7da5',
		externalGroup: '#8b70c2',
		externalNote: '#e99a2f',
		externalLink: '#a78350',
		unresolved: '#d66376',
		unresolvedLink: '#af7883',
		highlightHierarchy: '#1e4b91',
		highlightNoteLink: '#805087',
		highlightOutsideLink: '#916016',
		highlightUnresolvedLink: '#ab485f',
		folder: '#788395',
		folderMeta: '#4479de',
		note: '#8a79cf',
		root: '#3568d4',
		ringOpacity: 0.22,
		treeOpacity: 0.7,
		linkOpacity: 0.34,
		externalLinkOpacity: 0.34,
		highlightOpacity: 0.98,
		nodeScale: 0.32,
		maxLabels: 170,
	},
	night: {
		bg: '#10131a',
		ring: '#4d586f',
		tree: '#8fafd6',
		link: '#8d7aa9',
		externalGroup: '#c2abe7',
		externalNote: '#ffc064',
		externalLink: '#b29368',
		unresolved: '#f493a3',
		unresolvedLink: '#ba8795',
		highlightHierarchy: '#c1d6f2',
		highlightNoteLink: '#ab92ca',
		highlightOutsideLink: '#cba877',
		highlightUnresolvedLink: '#d2a0ac',
		folder: '#b2bac7',
		folderMeta: '#82aaff',
		note: '#c8baf2',
		root: '#82a1ff',
		ringOpacity: 0.25,
		treeOpacity: 0.59,
		linkOpacity: 0.36,
		externalLinkOpacity: 0.36,
		highlightOpacity: 0.98,
		nodeScale: 0.32,
		maxLabels: 300,
	},
};

export function radialFallbackBackground(scheme: RadialResolvedScheme): string {
	return PALETTES[scheme].bg;
}

export class RadialRenderer {
	readonly renderer: WebGLRenderer;
	readonly camera: OrthographicCamera;
	readonly domElement: HTMLCanvasElement;

	private scene = new Scene();
	private labelRoot: HTMLElement;
	private ringSegments: LineSegments | null = null;
	private hierarchySegments: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
	private linkSegments: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
	private linkBaseOpacity = PALETTES.night.linkOpacity;
	private highlightSegments: Mesh | null = null;
	private nodePoints: Points | null = null;
	private nodeGeometry: BufferGeometry | null = null;
	private nodeMaterial: ShaderMaterial | null = null;
	private nodeIds: string[] = [];
	private rankedLabelNodes: { node: WorldNode; point: RadialPoint; score: number }[] = [];
	private labelElements = new Map<string, HTMLElement>();
	private edgeVisuals = new Map<string, EdgeVisual>();
	private allEdgeVisuals = new Map<string, EdgeVisual>();
	private nodeHitIndex: SpatialIndex<WorldNode> | null = null;
	private edgeHitIndex: SpatialIndex<EdgeVisual> | null = null;
	private linkPickingEnabled = false;
	private maxHitNodeRadius = 0;
	private graph: VisibleWorldGraph | null = null;
	private layout: RadialLayout | null = null;
	private active: RadialActiveState = emptyActiveState();
	private width = 1;
	private height = 1;
	private centerX = 0;
	private centerY = 0;
	private zoom = 1;
	private scheme: RadialResolvedScheme = 'night';
	private background = PALETTES.night.bg;
	private revealFrame = 0;
	private revealOverlay: HTMLElement | null = null;
	private renderBatchDepth = 0;
	private pendingRender = false;
	private pendingLabelUpdate = false;
	private pendingHighlightRebuild = false;
	private showRingGuides = false;
	private revealDepthLimit = Number.POSITIVE_INFINITY;
	private currentLabelVisibility: LabelVisibility = 'auto';
	private sceneAppearance: { scheme: RadialResolvedScheme; showRingGuides: boolean; revealDepthLimit: number; pixelRatio: number } | null = null;

	constructor(private container: HTMLElement) {
		this.container.addClass('is-radial-preparing');
		this.renderer = new WebGLRenderer({ antialias: true, alpha: false });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		this.renderer.setClearColor(this.background, 1);
		this.domElement = this.renderer.domElement;
		this.domElement.classList.add('mwm-radial-canvas');
		this.domElement.tabIndex = 0;
		container.appendChild(this.domElement);
		this.labelRoot = container.createDiv({ cls: 'mwm-radial-labels' });
		this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
		this.camera.position.set(0, 0, 1000);
		this.camera.lookAt(0, 0, 0);
	}

	setTheme(scheme: RadialResolvedScheme, background = radialFallbackBackground(scheme)): boolean {
		const schemeChanged = this.scheme !== scheme;
		const backgroundChanged = this.background !== background;
		if (!schemeChanged && !backgroundChanged) return false;
		this.scheme = scheme;
		this.background = background;
		this.renderer.setClearColor(this.background, 1);
		if (schemeChanged && this.nodeMaterial) {
			const pixelScale = this.nodeMaterial.uniforms['uPixelScale'];
			if (pixelScale) pixelScale.value = 1000 * Math.min(window.devicePixelRatio || 1, 2);
			this.updateNodeScale();
		}
		this.render();
		return schemeChanged;
	}

	setData(graph: VisibleWorldGraph, layout: RadialLayout, labelVisibility: LabelVisibility, showRingGuides = false): void {
		const geometryChanged = this.graph !== graph || this.layout !== layout;
		this.graph = graph;
		this.layout = layout;
		this.showRingGuides = showRingGuides;
		this.currentLabelVisibility = labelVisibility;
		if (geometryChanged) this.rebuildHitIndexes(graph, layout);
		const appearance = this.sceneAppearance;
		if (geometryChanged || !appearance || appearance.scheme !== this.scheme
			|| appearance.showRingGuides !== showRingGuides || appearance.revealDepthLimit !== this.revealDepthLimit
			|| appearance.pixelRatio !== Math.min(window.devicePixelRatio || 1, 2)) {
			this.rebuildSceneObjects(labelVisibility);
		} else {
			// Unchanged metadata must not dispose and upload the same buffers again.
			this.setActive(this.active, labelVisibility);
		}
	}

	private rebuildHitIndexes(graph: VisibleWorldGraph, layout: RadialLayout): void {
		this.maxHitNodeRadius = 0;
		const nodes = graph.nodes.filter((node) => layout.positions.has(node.id));
		this.nodeHitIndex = new SpatialIndex(nodes, (node) => {
			const point = layout.positions.get(node.id)!;
			this.maxHitNodeRadius = Math.max(this.maxHitNodeRadius, point.nodeRadius);
			return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
		});
		this.allEdgeVisuals.clear();
		for (const edge of [...graph.hierarchyEdges, ...graph.linkEdges, ...graph.hoverLinkEdges]) {
			if (this.allEdgeVisuals.has(edge.id)) continue;
			const visual = this.edgeVisual(edge, layout);
			if (visual) this.allEdgeVisuals.set(edge.id, visual);
		}
		this.edgeHitIndex = null;
		if (this.linkPickingEnabled) this.ensureEdgeHitIndex();
	}

	setLinkPickingEnabled(enabled: boolean): void {
		this.linkPickingEnabled = enabled;
		if (enabled && this.graph) this.ensureEdgeHitIndex();
	}

	private ensureEdgeHitIndex(): SpatialIndex<EdgeVisual> {
		if (this.edgeHitIndex) return this.edgeHitIndex;
		const links = [...this.allEdgeVisuals.values()].filter(({ edge }) => edge.type !== 'hierarchy' && edge.type !== 'external-hierarchy');
		this.edgeHitIndex = new SpatialIndex(links, (visual) => {
			const bounds: SpatialBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
			for (const point of visual.points) {
				bounds.minX = Math.min(bounds.minX, point.x);
				bounds.minY = Math.min(bounds.minY, point.y);
				bounds.maxX = Math.max(bounds.maxX, point.x);
				bounds.maxY = Math.max(bounds.maxY, point.y);
			}
			return bounds;
		});
		return this.edgeHitIndex;
	}

	private rebuildSceneObjects(labelVisibility = this.currentLabelVisibility): void {
		if (!this.graph || !this.layout) return;
		this.edgeVisuals.clear();
		this.disposeObjects();
		this.buildRings();
		this.buildEdges(this.graph.hierarchyEdges, this.layout, 'hierarchy');
		this.buildEdges(this.graph.linkEdges, this.layout, 'links');
		for (const edge of this.graph.hoverLinkEdges) {
			if (!this.edgeRevealVisible(edge, this.layout)) continue;
			if (this.edgeVisuals.has(edge.id)) continue;
			const visual = this.allEdgeVisuals.get(edge.id);
			if (visual) this.edgeVisuals.set(visual.key, visual);
		}
		this.buildNodes(this.graph, this.layout);
		this.setActive(this.active, labelVisibility);
		this.sceneAppearance = { scheme: this.scheme, showRingGuides: this.showRingGuides,
			revealDepthLimit: this.revealDepthLimit, pixelRatio: Math.min(window.devicePixelRatio || 1, 2) };
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
		this.render();
	}

	setView(centerX: number, centerY: number, zoom: number): void {
		const previousZoom = this.zoom;
		this.centerX = Number.isFinite(centerX) ? centerX : 0;
		this.centerY = Number.isFinite(centerY) ? centerY : 0;
		this.zoom = this.clampZoom(zoom);
		const zoomChanged = this.zoom !== previousZoom;
		if (zoomChanged) {
			this.updateNodeScale();
			this.updateEdgeDim();
		}
		this.applyCamera();
		const rebuiltHighlights = zoomChanged && this.active.highlightedEdges.size > 0;
		if (rebuiltHighlights) this.rebuildHighlights();
		this.updateLabels();
		this.render();
	}

	getView(): { centerX: number; centerY: number; zoom: number } {
		return { centerX: this.centerX, centerY: this.centerY, zoom: this.zoom };
	}

	clampZoom(zoom: number): number {
		const overview = this.layout ? Math.min(Math.max(1, this.width - 42) / Math.max(1, this.layout.width),
			Math.max(1, this.height - 42) / Math.max(1, this.layout.height)) : 1;
		const minimum = Math.min(MIN_RADIAL_ZOOM, overview * 0.05);
		return Math.min(Math.max(Number.isFinite(zoom) ? zoom : 1, minimum), MAX_RADIAL_ZOOM);
	}

	showLoadingMask(text: string): void {
		cancelAnimationFrame(this.revealFrame);
		this.revealDepthLimit = Number.POSITIVE_INFINITY;
		this.container.removeClass('is-radial-revealing');
		this.container.removeClass('is-radial-depth-revealing');
		this.container.addClass('is-radial-preparing');
		this.ensureRevealOverlay(text);
	}

	clearLoadingMask(fade = false): void {
		cancelAnimationFrame(this.revealFrame);
		this.setRevealDepthLimit(Number.POSITIVE_INFINITY);
		this.clearRevealMask(fade);
		this.render();
	}

	beginRenderBatch(): void {
		this.renderBatchDepth++;
	}

	endRenderBatch(): void {
		if (this.renderBatchDepth <= 0) return;
		this.renderBatchDepth--;
		if (this.renderBatchDepth !== 0) return;
		if (this.pendingHighlightRebuild) {
			this.pendingHighlightRebuild = false;
			this.rebuildHighlights();
		}
		if (this.pendingLabelUpdate) {
			this.pendingLabelUpdate = false;
			this.updateLabels(this.currentLabelVisibility);
		}
		if (this.pendingRender) {
			this.pendingRender = false;
			this.render();
		}
	}

	fitToLayout(rootId: string | null = null): boolean {
		if (!this.layout || this.width < 8 || this.height < 8) return false;
		const inset = 42;
		const availableWidth = Math.max(1, this.width - inset);
		const availableHeight = Math.max(1, this.height - inset);
		const rootPoint = rootId !== null ? (this.layout.positions.get(rootId) ?? this.layout.positions.get(ROOT_ID)) : null;
		const centerX = rootPoint?.x ?? this.layout.width / 2, centerY = rootPoint?.y ?? this.layout.height / 2;
		// Fit the whole map around the chosen root. A dense pair's readable
		// zoom is a detail view, not a lower bound on overview framing.
		const zoom = Math.min(availableWidth / Math.max(1, 2 * Math.max(centerX, this.layout.width - centerX)),
			availableHeight / Math.max(1, 2 * Math.max(centerY, this.layout.height - centerY)));
		this.setView(centerX, centerY, zoom);
		return true;
	}

	playRevealFromRoot(rootId: string, text: string, durMs = 0): void {
		cancelAnimationFrame(this.revealFrame);
		if (!this.graph || !this.layout || this.width < 2 || this.height < 2) {
			this.clearRevealMask(false);
			return;
		}
		const depths = revealDepths(this.graph, this.layout, rootId);
		if (depths.length === 0) {
			this.clearRevealMask(false);
			return;
		}
		const duration = durMs > 0 ? durMs : clampNumber(680 + depths.length * 165, 1150, 3600);
		let lastIndex = 0;
		this.container.addClass('is-radial-preparing');
		this.container.removeClass('is-radial-depth-revealing');
		this.setRevealDepthLimit(depths[0] ?? 0);
		this.ensureRevealOverlay(text);
		this.render();
		this.container.removeClass('is-radial-preparing');
		this.container.addClass('is-radial-depth-revealing');
		this.fadeRevealOverlay();
		const start = performance.now();
		const step = (now: number) => {
			const p = Math.min(Math.max((now - start) / duration, 0), 1);
			const index = Math.min(depths.length - 1, Math.floor(p * depths.length));
			if (index !== lastIndex) {
				lastIndex = index;
				this.setRevealDepthLimit(depths[index] ?? 0);
			}
			if (p < 1) {
				this.revealFrame = window.requestAnimationFrame(step);
				return;
			}
			this.setRevealDepthLimit(Number.POSITIVE_INFINITY);
			this.clearRevealMask(true);
		};
		this.revealFrame = window.requestAnimationFrame(step);
	}

	setActive(active: RadialActiveState, labelVisibility: LabelVisibility): void {
		this.active = active;
		this.updateNodeDim();
		this.updateEdgeDim();
		this.rebuildHighlights();
		this.updateLabels(labelVisibility);
		this.render();
	}

	render(): void {
		if (this.renderBatchDepth > 0) {
			this.pendingRender = true;
			return;
		}
		this.renderer.render(this.scene, this.camera);
	}

	worldToScreen(x: number, y: number): { x: number; y: number } {
		return {
			x: (x - this.centerX) * this.zoom + this.width / 2,
			y: (this.centerY - y) * this.zoom + this.height / 2,
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
			const maxRadius = Math.max(this.maxHitNodeRadius * 0.36, Math.max(4, nodeMaxPoint(this.zoom) * 0.55) / this.zoom) + Math.max(5, 6 / this.zoom);
			for (const node of this.nodeHitIndex?.query(world.x, world.y, maxRadius) ?? []) {
				const point = this.layout.positions.get(node.id);
				if (!this.pointRevealVisible(point)) continue;
				const distance = Math.hypot(world.x - point.x, world.y - point.y);
				const visualRadius = Math.max(4, nodeVisualPointSize(point.nodeRadius, this.palette().nodeScale, this.zoom) * 0.55);
				const radius = Math.max(point.nodeRadius * 0.36, visualRadius / this.zoom) + Math.max(5, 6 / this.zoom);
				if (distance <= radius && (!bestNode || distance < bestNode.distance)) bestNode = { id: node.id, distance };
			}
		}
		if (bestNode) return { nodeId: bestNode.id, edge: null };
		if (!includeLinks) return { nodeId: null, edge: null };
		let bestEdge: { edge: WorldEdge; distance: number } | null = null;
		for (const visual of this.ensureEdgeHitIndex().query(world.x, world.y, Math.max(10, 8 / this.zoom))) {
			if (!this.edgeVisuals.has(visual.key)) continue;
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
		this.edgeVisuals.clear();
		this.allEdgeVisuals.clear();
		this.nodeHitIndex = null;
		this.edgeHitIndex = null;
		this.graph = null;
		this.layout = null;
	}

	private palette(): RadialPalette {
		return PALETTES[this.scheme];
	}

	private ensureRevealOverlay(text: string): void {
		if (!this.revealOverlay) {
			this.revealOverlay = this.container.createDiv({ cls: 'mwm-radial-loading gx-mask-text', text });
			return;
		}
		this.revealOverlay.removeClass('is-fading');
		this.revealOverlay.setText(text);
	}

	private clearRevealMask(fade: boolean): void {
		this.container.removeClass('is-radial-revealing');
		this.container.removeClass('is-radial-depth-revealing');
		this.container.removeClass('is-radial-preparing');
		if (!this.revealOverlay) return;
		if (!fade) {
			this.revealOverlay.remove();
			this.revealOverlay = null;
			return;
		}
		this.fadeRevealOverlay();
	}

	private fadeRevealOverlay(): void {
		if (!this.revealOverlay) return;
		const overlay = this.revealOverlay;
		overlay.addClass('is-fading');
		window.setTimeout(() => {
			if (this.revealOverlay !== overlay) return;
			overlay.remove();
			this.revealOverlay = null;
		}, 220);
	}

	private setRevealDepthLimit(limit: number): void {
		const next = Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY;
		if (this.revealDepthLimit === next) return;
		this.revealDepthLimit = next;
		this.rebuildSceneObjects(this.currentLabelVisibility);
	}

	private applyCamera(): void {
		this.camera.position.set(this.centerX, this.centerY, 1000);
		this.camera.zoom = this.zoom;
		this.camera.updateProjectionMatrix();
	}

	private buildRings(): void {
		if (!this.showRingGuides || !this.layout?.rings.length) {
			this.ringSegments = null;
			return;
		}
		const positions: number[] = [];
		const colors: number[] = [];
		const color = new Color(this.palette().ring);
		const centerX = Number.isFinite(this.layout.centerX) ? this.layout.centerX : 0;
		const centerY = Number.isFinite(this.layout.centerY) ? this.layout.centerY : 0;
		for (const ring of this.layout.rings) {
			if (ring.depth > this.revealDepthLimit) continue;
			if (!Number.isFinite(ring.radius) || ring.radius <= 0) continue;
			pushRingSegments(positions, colors, color, centerX, centerY, ring.radius, ring.depth, -3);
		}
		if (positions.length === 0) {
			this.ringSegments = null;
			return;
		}
		this.ringSegments = new LineSegments(
			makeLineGeometry(positions, colors),
			new LineBasicMaterial({
				vertexColors: true,
				transparent: true,
				opacity: this.palette().ringOpacity,
				depthWrite: false,
			}),
		);
		this.scene.add(this.ringSegments);
	}

	private buildEdges(edges: WorldEdge[], layout: RadialLayout, kind: 'hierarchy' | 'links'): void {
		const visuals: EdgeVisual[] = [];
		let componentCount = 0;
		const palette = this.palette();
		for (const edge of edges) {
			if (!this.edgeRevealVisible(edge, layout)) continue;
			const visual = this.allEdgeVisuals.get(edge.id);
			if (!visual) continue;
			this.edgeVisuals.set(visual.key, visual);
			visuals.push(visual);
			componentCount += Math.max(0, visual.points.length - 1) * 6;
		}
		// Write the final GPU arrays directly instead of growing JS arrays and
		// copying them. Vertex order, coordinates and colors are unchanged.
		const positions = new Float32Array(componentCount);
		const colors = new Float32Array(componentCount);
		let offset = 0;
		const z = kind === 'hierarchy' ? -1 : -2;
		for (const visual of visuals) {
			const color = edgeColor(visual.edge, kind, palette);
			for (let i = 0; i < visual.points.length - 1; i++) {
				const a = visual.points[i]!;
				const b = visual.points[i + 1]!;
				positions[offset] = a.x;
				positions[offset + 1] = a.y;
				positions[offset + 2] = z;
				positions[offset + 3] = b.x;
				positions[offset + 4] = b.y;
				positions[offset + 5] = z;
				colors[offset] = colors[offset + 3] = color.r;
				colors[offset + 1] = colors[offset + 4] = color.g;
				colors[offset + 2] = colors[offset + 5] = color.b;
				offset += 6;
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
		else {
			this.linkSegments = line;
			// Cache the theme's base value so wheel events do not scan every link.
			this.linkBaseOpacity = line.material.opacity;
		}
		this.scene.add(line);
	}

	private buildNodes(graph: VisibleWorldGraph, layout: RadialLayout): void {
		const palette = this.palette();
		const colorsByKind = nodeColors(palette);
		const visibleNodes = graph.nodes.filter((node) => this.pointRevealVisible(layout.positions.get(node.id)));
		this.rankedLabelNodes = visibleNodes
			.map((node) => {
				const point = layout.positions.get(node.id);
				return point ? { node, point, score: labelScore(node, point, graph) } : null;
			})
			.filter((item): item is { node: WorldNode; point: RadialPoint; score: number } => item !== null)
			.sort((a, b) => labelPriority(b.node, graph) - labelPriority(a.node, graph) || b.score - a.score);
		const positions = new Float32Array(visibleNodes.length * 3);
		const colors = new Float32Array(visibleNodes.length * 3);
		const sizes = new Float32Array(visibleNodes.length);
		const ghost = new Float32Array(visibleNodes.length);
		const shapes = new Float32Array(visibleNodes.length);
		const dim = new Float32Array(visibleNodes.length).fill(1);
		this.nodeIds = visibleNodes.map((node) => node.id);
		visibleNodes.forEach((node, index) => {
			const point = layout.positions.get(node.id);
			const kind = radialNodeColorKind(node, graph.rootId);
			const color = colorsByKind[kind];
			positions[index * 3] = point?.x ?? 0;
			positions[index * 3 + 1] = point?.y ?? 0;
			positions[index * 3 + 2] = 1;
			colors[index * 3] = color.r;
			colors[index * 3 + 1] = color.g;
			colors[index * 3 + 2] = color.b;
			sizes[index] = nodePointSize(point?.nodeRadius ?? 8, palette.nodeScale) * nodeShapeScale(kind);
			ghost[index] = kind === 'outside-note' || kind === 'outside-group' || kind === 'unresolved' ? 1 : 0;
			shapes[index] = nodeShapeCode(nodeShapeKind(kind));
		});
		this.nodeGeometry = new BufferGeometry();
		this.nodeGeometry.setAttribute('position', new BufferAttribute(positions, 3));
		this.nodeGeometry.setAttribute('color', new BufferAttribute(colors, 3));
		this.nodeGeometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
		this.nodeGeometry.setAttribute('aGhost', new BufferAttribute(ghost, 1));
		this.nodeGeometry.setAttribute('aShape', new BufferAttribute(shapes, 1));
		this.nodeGeometry.setAttribute('aDim', new BufferAttribute(dim, 1));
		this.nodeMaterial = new ShaderMaterial({
			vertexShader: RADIAL_NODE_VERTEX_SHADER,
			fragmentShader: RADIAL_NODE_FRAGMENT_SHADER,
			vertexColors: true,
			transparent: true,
			depthWrite: false,
			uniforms: {
				uPixelScale: { value: 1000 * Math.min(window.devicePixelRatio || 1, 2) },
				uSizeMul: { value: nodeScreenScale(this.zoom) },
				uSizeContrast: { value: nodeSizeContrast(this.zoom) },
				uBasePoint: { value: NODE_BASE_POINT },
				uMinPoint: { value: nodeMinPoint(this.zoom) * Math.min(window.devicePixelRatio || 1, 2) },
				uMaxPoint: { value: nodeMaxPoint(this.zoom) * Math.min(window.devicePixelRatio || 1, 2) },
			},
		});
		this.nodePoints = new Points(this.nodeGeometry, this.nodeMaterial);
		// Transparent highlights must not paint over the small node glyphs.
		this.nodePoints.renderOrder = 2;
		this.nodePoints.frustumCulled = false;
		this.scene.add(this.nodePoints);
	}

	private updateNodeDim(): void {
		if (!this.nodeGeometry) return;
		const attr = this.nodeGeometry.getAttribute('aDim') as BufferAttribute;
		const dim = attr.array as Float32Array;
		const idleOpacity = this.scheme === 'night' ? 0.94 : 0.82;
		for (let i = 0; i < this.nodeIds.length; i++) {
			const id = this.nodeIds[i] ?? '';
			const focused =
				id === this.active.activeNodeId || this.active.pinnedNodeIds.has(id) || id === this.graph?.focusId;
			const related = this.active.relatedNodes.has(id);
			dim[i] = this.active.dimOthers && !focused && !related ? 0.23 : focused ? 1.12 : related ? 0.95 : idleOpacity;
		}
		attr.needsUpdate = true;
	}

	private updateEdgeDim(): void {
		const palette = this.palette();
		const dimmed = this.active.dimOthers;
		// Wheel zoom is multiplicative: interpolate in log space for an even fade.
		// Keep a faint overview floor and restore the full palette in close views.
		const detail = edgeZoomDetail(this.zoom);
		const hierarchyFade = 0.18 + 0.82 * detail;
		const linkFade = 0.05 + 0.95 * detail * detail;
		if (this.hierarchySegments) {
			this.hierarchySegments.material.opacity = palette.treeOpacity * hierarchyFade * (dimmed ? 0.16 : 1);
		}
		if (this.linkSegments) {
			this.linkSegments.material.opacity = this.linkBaseOpacity * linkFade * (dimmed ? 0.14 : 1);
		}
	}

	private updateNodeScale(): void {
		if (!this.nodeMaterial) return;
		const sizeMul = this.nodeMaterial.uniforms['uSizeMul'];
		const sizeContrast = this.nodeMaterial.uniforms['uSizeContrast'];
		const minPoint = this.nodeMaterial.uniforms['uMinPoint'];
		const maxPoint = this.nodeMaterial.uniforms['uMaxPoint'];
		const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
		if (sizeMul) sizeMul.value = nodeScreenScale(this.zoom);
		if (sizeContrast) sizeContrast.value = nodeSizeContrast(this.zoom);
		if (minPoint) minPoint.value = nodeMinPoint(this.zoom) * pixelRatio;
		if (maxPoint) maxPoint.value = nodeMaxPoint(this.zoom) * pixelRatio;
	}

	private rebuildHighlights(): void {
		if (this.renderBatchDepth > 0) {
			this.pendingHighlightRebuild = true;
			return;
		}
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
		const zoom = this.zoom;
		for (const key of this.active.highlightedEdges) {
			const visual = this.edgeVisuals.get(key);
			if (!visual) continue;
			const color = edgeHighlightColor(visual.edge, palette);
			for (let i = 0; i < visual.points.length - 1; i++) {
				const a = visual.points[i];
				const b = visual.points[i + 1];
				if (!a || !b) continue;
				pushSegmentBand(positions, colors, color, a, b, highlightWidthPx(visual.edge, zoom) / zoom, 2);
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
		this.highlightSegments.renderOrder = 1;
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

	private edgeRevealVisible(edge: WorldEdge, layout: RadialLayout): boolean {
		const source = layout.positions.get(edge.source);
		const target = layout.positions.get(edge.target);
		return this.pointRevealVisible(source) && this.pointRevealVisible(target);
	}

	private pointRevealVisible(point: RadialPoint | null | undefined): point is RadialPoint {
		return Boolean(point && point.depth <= this.revealDepthLimit + 0.001);
	}

	private updateLabels(labelVisibility: LabelVisibility = this.currentLabelVisibility): void {
		this.currentLabelVisibility = labelVisibility;
		if (this.renderBatchDepth > 0) {
			this.pendingLabelUpdate = true;
			return;
		}
		if (!this.graph || !this.layout) return;
		const directIds = new Set<string>();
		const addDirect = (id: string | null | undefined) => {
			if (id !== null && id !== undefined) directIds.add(id);
		};
		for (const id of this.active.labelNodes) addDirect(id);
		for (const id of this.active.pinnedNodeIds) addDirect(id);
		addDirect(this.active.activeNodeId);
		addDirect(ROOT_ID);
		addDirect(this.graph.rootId);
		addDirect(this.graph.focusId);
		const ranked = this.rankedLabelNodes
			.map(({ node, point }) => {
				const screen = this.worldToScreen(point.x, point.y);
				const visible = screen.x >= -160 && screen.y >= -80 && screen.x <= this.width + 160 && screen.y <= this.height + 120;
				return visible ? { node, point, screen } : null;
			})
			.filter((item): item is { node: WorldNode; point: RadialPoint; screen: { x: number; y: number } } => item !== null)
			.map((item, rank) => ({ ...item, rank }));
		const denominator = Math.max(1, ranked.length - 1);
		const viewportScale = clampNumber(Math.sqrt(Math.max(1, this.width * this.height)) / 1050, 0.65, 1.8);
		const revealZoom = labelRevealZoom(this.zoom);
		const zoomCapacity = 40 + smoothstep(0.035, 0.42, revealZoom) * 64 + smoothstep(0.36, 1.3, revealZoom) * 112 + smoothstep(1.1, 6, revealZoom) * 72;
		const autoBudget =
			labelVisibility === 'auto'
				? Math.round(Math.min(this.palette().maxLabels, Math.max(0, zoomCapacity * viewportScale)))
				: 0;
		let autoShown = 0;
		const shownIds = new Set<string>();
		const occupied = new RadialLabelOccupancy();
		// Reserve space for roots, hovered/selected nodes and pins before automatic names.
		const ordered = [...ranked.filter(({ node }) => directIds.has(node.id)), ...ranked.filter(({ node }) => !directIds.has(node.id))];
		for (const { node, point, screen, rank } of ordered) {
			const direct = directIds.has(node.id);
			if (!direct && autoShown >= autoBudget) continue;
			const rootNode = node.id === this.graph.rootId || node.id === ROOT_ID;
			const folder = node.type === 'folder';
			const leading = rank < 36;
			const scale = labelScreenScale(this.zoom) * (rootNode ? 1.18 : point.nodeRadius >= 24 ? 1.1 : point.nodeRadius >= 15 ? 1.04 : 1);
			const fontSize = Math.max(rootNode ? 14 : 9.5, 12 * scale);
			const maxWidth = Math.round(rootNode ? Math.max(200, 240 * scale) : (folder ? 210 : leading ? 196 : 180) * scale);
			const visualNodeRadius = Math.max(5, nodeVisualPointSize(point.nodeRadius, this.palette().nodeScale, this.zoom) * 0.62);
			const labelOffset = Math.max(9, visualNodeRadius + 6 * scale);
			// Notes need more room in the overview; folders claim the available space first.
			const padding = direct || folder ? 4 : 6 + (1 - smoothstep(0.04, 0.45, revealZoom)) * 12;
			const bounds = radialLabelBounds(node.title, screen.x, screen.y + labelOffset, fontSize, maxWidth, padding);
			if (bounds.maxX < 0 || bounds.minX > this.width || bounds.maxY < 0 || bounds.minY > this.height) continue;
			if (!direct && occupied.intersects(bounds)) continue;
			occupied.add(bounds);
			// Screen space decides eligibility, even at tiny world-space zoom values.
			// Zoom still raises emphasis as the user moves closer.
			const strength = direct
				? 1
				: Math.max(folder ? 0.76 : 0.5, zoomLabelStrength(node, point, this.zoom, rank, denominator, this.graph, this.width, this.height));
			if (!direct) autoShown++;
			const labelClasses = ['mwm-radial-label'];
			if (rootNode) labelClasses.push('is-root');
			if (!rootNode && (leading || node.type === 'folder')) labelClasses.push('is-strong');
			shownIds.add(node.id);
			let label = this.labelElements.get(node.id);
			if (!label) {
				label = this.labelRoot.createDiv();
				this.labelElements.set(node.id, label);
			}
			label.className = labelClasses.join(' ');
			if (label.textContent !== node.title) label.setText(node.title);
			this.labelRoot.appendChild(label);
			label.style.fontSize = `${fontSize.toFixed(2)}px`;
			label.style.maxWidth = `${maxWidth}px`;
			label.style.opacity = String(rootNode ? 1 : direct ? 0.96 : Math.min(0.9, 0.22 + strength * 0.68));
			label.style.transform = `translate3d(${screen.x.toFixed(1)}px, ${(screen.y + labelOffset).toFixed(1)}px, 0)`;
			if (this.active.dimOthers && !directIds.has(node.id) && !this.active.relatedNodes.has(node.id)) {
				label.style.opacity = String(Math.min(Number(label.style.opacity) || 1, 0.34));
				label.addClass('is-dim');
			}
		}
		for (const [id, label] of this.labelElements) {
			if (shownIds.has(id)) continue;
			label.remove();
			this.labelElements.delete(id);
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
		this.rankedLabelNodes = [];
		this.labelElements.clear();
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

function makeLineGeometry(positions: number[] | Float32Array, colors: number[] | Float32Array): BufferGeometry {
	const geometry = new BufferGeometry();
	geometry.setAttribute('position', new BufferAttribute(positions instanceof Float32Array ? positions : new Float32Array(positions), 3));
	geometry.setAttribute('color', new BufferAttribute(colors instanceof Float32Array ? colors : new Float32Array(colors), 3));
	return geometry;
}

function makeMeshGeometry(positions: number[], colors: number[]): BufferGeometry {
	const geometry = makeLineGeometry(positions, colors);
	geometry.computeBoundingSphere();
	return geometry;
}

function pushRingSegments(
	positions: number[],
	colors: number[],
	color: Color,
	centerX: number,
	centerY: number,
	radius: number,
	depth: number,
	z: number,
): void {
	const steps = Math.max(96, Math.ceil(radius / 16));
	const dashEvery = Math.max(3, Math.round(steps / 72));
	const phase = depth % 2 === 0 ? 0 : dashEvery;
	for (let step = 0; step < steps; step++) {
		if (((step + phase) % (dashEvery * 2)) >= dashEvery) continue;
		const a0 = (step / steps) * Math.PI * 2;
		const a1 = ((step + 1) / steps) * Math.PI * 2;
		positions.push(centerX + Math.cos(a0) * radius, centerY + Math.sin(a0) * radius, z);
		positions.push(centerX + Math.cos(a1) * radius, centerY + Math.sin(a1) * radius, z);
		pushColor(colors, color, 1);
		pushColor(colors, color, 1);
	}
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

function nodeColors(palette: RadialPalette): Record<RadialNodeColorKind, Color> {
	return {
		root: new Color(palette.root),
		folder: new Color(palette.folder),
		'folder-note': new Color(palette.folderMeta),
		note: new Color(palette.note),
		'outside-group': new Color(palette.externalGroup),
		'outside-note': new Color(palette.externalNote),
		unresolved: new Color(palette.unresolved),
	};
}

export function radialNodeColorKind(node: WorldNode, rootId: string): RadialNodeColorKind {
	if (node.id === rootId) return 'root';
	if (node.type === 'unresolved') return 'unresolved';
	if (node.externalProxy) return 'outside-note';
	if (node.type === 'external') return 'outside-group';
	if (node.type === 'folder' && node.representativeFile) return 'folder-note';
	if (node.type === 'folder') return 'folder';
	return 'note';
}


export function radialNodeShapeKind(node: WorldNode, rootId: string): RadialNodeShapeKind {
	return nodeShapeKind(radialNodeColorKind(node, rootId));
}

function nodeShapeKind(kind: RadialNodeColorKind): RadialNodeShapeKind {
	if (kind === 'folder') return 'folder-outline';
	if (kind === 'folder-note') return 'folder-note-solid';
	if (kind === 'root') return 'root-ring';
	if (kind === 'outside-group') return 'outside-diamond';
	if (kind === 'outside-note') return 'outside-ring';
	if (kind === 'unresolved') return 'unresolved-cross';
	return 'note-dot';
}

function nodeShapeCode(shape: RadialNodeShapeKind): number {
	if (shape === 'folder-outline') return 1;
	if (shape === 'folder-note-solid') return 2;
	if (shape === 'root-ring') return 3;
	if (shape === 'outside-diamond') return 4;
	if (shape === 'outside-ring') return 5;
	if (shape === 'unresolved-cross') return 6;
	return 0;
}

function nodeShapeScale(kind: RadialNodeColorKind): number {
	if (kind === 'root') return 1.3;
	if (kind === 'folder' || kind === 'folder-note') return 1.18;
	if (kind === 'outside-group' || kind === 'outside-note' || kind === 'unresolved') return 1.12;
	return 1;
}

function edgeColor(edge: WorldEdge, kind: 'hierarchy' | 'links', palette: RadialPalette): Color {
	if (edge.unresolvedCount) return new Color(palette.unresolvedLink);
	if (edge.externalCount) return new Color(kind === 'links' ? palette.externalLink : palette.externalGroup);
	return new Color(kind === 'hierarchy' ? palette.tree : palette.link);
}

function edgeHighlightColor(edge: WorldEdge, palette: RadialPalette): Color {
	const kind = radialEdgeHighlightKind(edge);
	if (kind === 'unresolved-link') return new Color(palette.highlightUnresolvedLink);
	if (kind === 'outside-link') return new Color(palette.highlightOutsideLink);
	if (kind === 'hierarchy') return new Color(palette.highlightHierarchy);
	return new Color(palette.highlightNoteLink);
}

export function radialEdgeHighlightKind(edge: WorldEdge): RadialEdgeHighlightKind {
	if (edge.unresolvedCount || edge.type === 'unresolved-link') return 'unresolved-link';
	if (edge.externalCount || edge.type === 'external-hierarchy') return 'outside-link';
	if (edge.type === 'hierarchy') return 'hierarchy';
	return 'note-link';
}

function revealDepths(graph: VisibleWorldGraph, layout: RadialLayout, rootId: string): number[] {
	const depths = new Set<number>();
	const rootDepth = layout.positions.get(rootId)?.depth ?? 0;
	depths.add(rootDepth);
	for (const node of graph.nodes) {
		const point = layout.positions.get(node.id);
		if (!point || !Number.isFinite(point.depth)) continue;
		depths.add(Math.max(rootDepth, Math.round(point.depth)));
	}
	return [...depths].sort((a, b) => a - b);
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
	const centerX = Number.isFinite(route.centerX) ? route.centerX : Number.isFinite(source.centerX) ? source.centerX : midX;
	const centerY = Number.isFinite(route.centerY) ? route.centerY : Number.isFinite(source.centerY) ? source.centerY : midY;
	const ctrl = { x: midX + (centerX - midX) * pull, y: midY + (centerY - midY) * pull };
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

function edgeZoomDetail(zoom: number): number {
	return smoothstep(Math.log2(0.005), Math.log2(0.5), Math.log2(zoom));
}

function highlightWidthPx(edge: WorldEdge, zoom: number): number {
	if (radialEdgeHighlightKind(edge) === 'unresolved-link') return 1.6;
	if (edge.type === 'hierarchy' || edge.type === 'external-hierarchy') return 1.6 + 0.6 * edgeZoomDetail(zoom);
	return 1.8;
}

function labelPriority(node: WorldNode, graph: VisibleWorldGraph): number {
	if (node.id === ROOT_ID || node.id === graph.rootId || node.id === graph.focusId) return 4;
	if (node.type === 'folder') return 3;
	if (node.type === 'external') return 2;
	if (node.type === 'note') return 1;
	return 0;
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
	width: number,
	height: number,
): number {
	const clampedZoom = clampNumber(zoom, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
	const revealZoom = labelRevealZoom(clampedZoom);
	const root = node.id === graph.rootId;
	if (root) return 0.68 + smoothstep(0.04, 0.2, revealZoom) * 0.32;
	const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
	const folder = node.type === 'folder';
	const external = node.type === 'external' || node.externalProxy;
	const unresolved = node.type === 'unresolved';
	const sizeSignal = clampNumber((point.nodeRadius - 4) / 42, 0, 1);
	const degreeSignal = clampNumber(Math.log1p(degree) / Math.log1p(80), 0, 1);
	const salienceSignal = clampNumber(1 - rank / Math.max(1, denominator), 0, 1);
	const screenRadius = nodePointSize(point.nodeRadius, 0.24) * nodeScreenScale(clampedZoom);
	const apparentSignal = clampNumber((screenRadius - 2.5) / 13, 0, 1);
	const viewportSignal = clampNumber(Math.sqrt(Math.max(1, width * height)) / 1200, 0.55, 1.45);
	const nodeCount = Math.max(1, graph.nodes.length || 1);
	const leading = rank < Math.max(10, Math.min(58, Math.ceil(nodeCount * 0.05)));
	const secondary = rank < Math.max(28, Math.min(170, Math.ceil(nodeCount * 0.18)));
	const tertiary = rank < Math.max(80, Math.min(520, Math.ceil(nodeCount * 0.38)));
	let threshold = 1.04 - apparentSignal * 0.5 - sizeSignal * 0.34 - degreeSignal * 0.2 - salienceSignal * 0.3 - (viewportSignal - 0.55) * 0.08;

	if (leading) threshold -= 0.24;
	else if (secondary) threshold -= 0.17;
	else if (tertiary) threshold -= 0.08;
	if (folder) threshold -= node.representativeFile ? 0.22 : 0.15;
	else if (external) threshold -= 0.06;
	if (unresolved) threshold += 0.18;

	threshold = clampNumber(threshold, 0.08, 1.22);
	const fade = smoothstep(threshold - 0.18, threshold + 0.1, revealZoom);
	const leadingFade = leading
		? smoothstep(0.07, 0.26, revealZoom)
		: secondary
			? smoothstep(0.14, 0.44, revealZoom) * 0.92
			: tertiary
				? smoothstep(0.28, 0.7, revealZoom) * 0.74
				: 0;
	const largeFade =
		point.nodeRadius >= 24
			? smoothstep(0.14, 0.42, revealZoom) * 0.98
			: point.nodeRadius >= 15
				? smoothstep(0.24, 0.64, revealZoom) * 0.82
				: 0;
	const apparentFade = !unresolved ? smoothstep(0.12, 0.82, revealZoom) * apparentSignal * 0.96 : 0;
	const smallFade = !unresolved ? smoothstep(0.48, 0.98, revealZoom) * 0.9 : 0;
	const closeFade = !unresolved ? smoothstep(0.82, 1.18, revealZoom) * 0.98 : 0;
	return clampNumber(Math.max(fade, leadingFade, largeFade, apparentFade, smallFade, closeFade), 0, 1);
}

function labelRevealZoom(zoom: number): number {
	return clampNumber(zoom * LABEL_REVEAL_ACCELERATION, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
}

function labelScreenScale(zoom: number): number {
	const clampedZoom = clampNumber(zoom, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
	return 0.62 + smoothstep(0.06, 1.48, clampedZoom) * 0.88;
}

function nodePointSize(nodeRadius: number, paletteScale: number): number {
	const radius = Math.max(0, Number.isFinite(nodeRadius) ? nodeRadius : 8);
	const gentleBase = 3.9 + radius * paletteScale * 0.86 + Math.sqrt(radius) * 0.48;
	const hubLift = smoothstep(14, 64, radius) * radius * paletteScale * 0.42;
	return clampNumber(gentleBase + hubLift, NODE_BASE_POINT, 42);
}

function nodeVisualPointSize(nodeRadius: number, paletteScale: number, zoom: number): number {
	const base = nodePointSize(nodeRadius, paletteScale);
	const contrasted = NODE_BASE_POINT + Math.max(0, base - NODE_BASE_POINT) * nodeSizeContrast(zoom);
	return clampNumber(contrasted * nodeScreenScale(zoom), nodeMinPoint(zoom), nodeMaxPoint(zoom));
}

function nodeScreenScale(zoom: number): number {
	const clampedZoom = clampNumber(zoom, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
	return (
		0.86 +
		smoothstep(0.025, 0.28, clampedZoom) * 0.13 +
		smoothstep(0.28, 1.3, clampedZoom) * 0.15 +
		smoothstep(1.3, MAX_RADIAL_ZOOM, clampedZoom) * 0.08
	);
}

function nodeSizeContrast(zoom: number): number {
	const clampedZoom = clampNumber(zoom, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
	return (
		0.4 +
		smoothstep(0.025, 0.28, clampedZoom) * 0.28 +
		smoothstep(0.28, 1.25, clampedZoom) * 0.44 +
		smoothstep(1.25, MAX_RADIAL_ZOOM, clampedZoom) * 0.58
	);
}

function nodeMinPoint(zoom: number): number {
	const clampedZoom = clampNumber(zoom, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
	return 4.6 + smoothstep(0.02, 0.22, clampedZoom) * 0.2;
}

function nodeMaxPoint(zoom: number): number {
	const clampedZoom = clampNumber(zoom, MIN_RADIAL_ZOOM, MAX_RADIAL_ZOOM);
	return (
		30 +
		smoothstep(0.025, 0.42, clampedZoom) * 24 +
		smoothstep(0.42, 1.6, clampedZoom) * 30 +
		smoothstep(1.6, MAX_RADIAL_ZOOM, clampedZoom) * 28
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
