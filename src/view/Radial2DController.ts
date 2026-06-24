import { Component, Menu, Notice, TFile, debounce, setIcon, type App } from 'obsidian';
import type { Language, MiniWorldMapSettings, RadialSettings, ViewMode } from '../settings';
import {
	HOVER_HIGHLIGHT_MODE_OPTIONS,
	HOVER_TARGET_MODE_OPTIONS,
	LABEL_VISIBILITY_OPTIONS,
	LEGEND_ITEM_DEFINITIONS,
	MAX_ATLAS_DEPTH,
	MAX_EXTERNAL_LINK_ANCHOR_LIMIT,
	MAX_LINK_LIMIT,
	MAX_RENDER_NODE_LIMIT,
	MAX_SWIRL_STRENGTH,
	clampNumber,
	hoverHighlightsNoteLinks,
	normalizeColorScheme,
	normalizeExternalDetailMode,
	normalizeHoverHighlightMode,
	normalizeHoverTargetMode,
	normalizeLabelVisibility,
	normalizeLanguage,
} from '../settings';
import {
	colorSchemeOptions,
	hoverModeOptions,
	hoverTargetOptions,
	labelVisibilityOptions,
	languageOptions,
	outsideDetailOptions,
	t,
	viewModeLabel,
} from '../i18n';
import {
	DEFAULT_NODE_SPACING,
	DEFAULT_RING_SPACING,
	layoutRadialGraph,
	type RadialLayout,
} from '../layout/radial/layoutRadial';
import { MAX_RADIAL_ZOOM, MIN_RADIAL_ZOOM, RadialRenderer, emptyActiveState, radialFallbackBackground, type RadialActiveState, type RadialResolvedScheme } from '../render/RadialRenderer';
import { resolveObsidianBackground } from '../render/obsidianTheme';
import { ROOT_ID, type VisibleGraphState, type VisibleWorldGraph, type WorldEdge, type WorldNode } from '../world/types';
import { WorldMapIndex } from '../world/WorldMapIndex';
import { defaultVisibleGraphState } from '../world/visibleGraph';
import { NodeSearchModal } from './SearchModal';

interface PinPath {
	id: string;
	key: string;
	kind: 'node' | 'link';
	active: boolean;
	nodeId?: string;
	edgeId?: string;
	source?: string;
	target?: string;
	mode: string;
	title: string;
	path: string;
	groupId: string | null;
}

interface PinGroup {
	id: string;
	name: string;
}

const SEARCH_FOCUS_ZOOM = 0.22;

export class Radial2DController extends Component {
	private index: WorldMapIndex;
	private state: VisibleGraphState;
	private graph: VisibleWorldGraph | null = null;
	private layout: RadialLayout | null = null;
	private renderer: RadialRenderer | null = null;
	private canvasHost: HTMLElement | null = null;
	private panel: HTMLElement | null = null;
	private panelBody: HTMLElement | null = null;
	private statsEl: HTMLElement | null = null;
	private activePanelPage: 'inspect' | 'pins' | 'view' | 'controls' | 'defaults' = 'view';
	private selectedNodeId: string | null = null;
	private selectedLink: WorldEdge | null = null;
	private hoverNodeId: string | null = null;
	private hoverLink: WorldEdge | null = null;
	private pinnedPaths: PinPath[] = [];
	private pinGroups: PinGroup[] = [];
	private selectedPinIds = new Set<string>();
	private nextPinId = 1;
	private nextPinGroupId = 1;
	private pinGroupName = '';
	private disposed = false;
	private startupSettled = false;
	private rebuildToken = 0;
	private drag:
		| { pointerId: number; startX: number; startY: number; centerX: number; centerY: number; moved: boolean }
		| null = null;
	private needsFit = true;
	private saveSoon: () => void;
	private redrawSoon: () => void;

	constructor(
		private app: App,
		private contentEl: HTMLElement,
		private settings: MiniWorldMapSettings,
		private saveSettings: () => void,
		private onViewMode: (mode: ViewMode) => void,
		private onLanguage: (language: Language) => void,
	) {
		super();
		this.index = new WorldMapIndex(app, settings.radial);
		this.state = defaultVisibleGraphState(settings.radial);
		this.saveSoon = debounce(saveSettings, 500, true);
		this.redrawSoon = debounce(() => this.rebuild('metadata'), 600, true);
	}

	get counts(): { nodes: number; links: number } {
		return { nodes: this.graph?.nodes.length ?? 0, links: this.graph?.linkEdges.length ?? 0 };
	}

	async start(): Promise<void> {
		console.info('[Mini World Map] starting 2D map');
		this.contentEl.addClass('mwm-radial-mode');
		this.canvasHost = this.contentEl.createDiv({ cls: 'mwm-radial-host' });
		this.renderer = new RadialRenderer(this.canvasHost);
		this.syncThemeClass();
		this.buildPanel();
		this.buildFloatingControls();
		this.bindRendererEvents();
		this.registerVaultEvents();
		this.renderer.showLoadingMask(this.t('loading.radial'));
		await this.waitForStartupReady();
		if (this.disposed) return;
		await this.queueRebuild('start');
		if (!this.disposed) this.startupSettled = true;
	}

	onunload(): void {
		this.disposed = true;
		super.onunload();
	}

	resize(): void {
		this.resizeRenderer(true);
	}

	private resizeRenderer(allowFit: boolean): void {
		if (!this.renderer || !this.canvasHost) return;
		this.renderer.resize(this.canvasHost.clientWidth, this.canvasHost.clientHeight);
		if (allowFit && this.needsFit && this.renderer.fitToLayout(this.graph?.rootId ?? ROOT_ID)) {
			this.needsFit = false;
			return;
		}
		this.renderer.render();
	}

	onCssChange(): void {
		this.syncThemeClass();
	}

	rebuild(reason: string): void {
		void this.queueRebuild(reason);
	}

	private async queueRebuild(reason: string): Promise<void> {
		const token = ++this.rebuildToken;
		await this.rebuildNow(reason, token);
	}

	private async rebuildNow(reason: string, token: number): Promise<void> {
		const radial = this.radial();
		const shouldReveal = ['start', 'manual', 'root', 'focus', 'atlas', 'complete'].includes(reason);
		const loadingText = this.t('loading.radial');
		if (shouldReveal) {
			this.renderer?.showLoadingMask(loadingText);
			await animationFrames(2);
			if (this.disposed || token !== this.rebuildToken) return;
		}
		const indexSettings = this.state.showCompleteRoot ? { ...radial, includeUnresolvedLinks: true } : radial;
		this.index.rebuild(indexSettings);
		this.state.hoverHighlightMode = radial.hoverHighlightMode;
		this.state.labelVisibility = radial.labelVisibility;
		if (this.state.showCompleteRoot) this.applyCompleteMapState();
		else {
			this.state.hiddenLegendItems = radial.hiddenLegendItems.slice();
			this.state.showLinkOverlay = radial.showLinkOverlay || !this.state.hiddenLegendItems.includes('link');
		}
		this.state.pinNeedsHoverLinks = this.pinnedPathsNeedHoverLinks();
		this.state.selectedNodeId = this.selectedNodeId;
		this.state.selectedLink = this.selectedLink;
		const preserveView = this.shouldPreserveView(reason) ? this.renderer?.getView() : null;
		const preserveAnchorId = preserveView ? (this.graph?.rootId ?? this.state.rootPath ?? ROOT_ID) : null;
		const preserveAnchorPoint = preserveAnchorId !== null ? (this.layout?.positions.get(preserveAnchorId) ?? this.layout?.positions.get(ROOT_ID) ?? null) : null;
		const renderGraph = this.index.buildVisibleGraph({ ...this.state });
		const layoutGraph = this.index.buildVisibleGraph(this.legendNeutralLayoutState());
		const renderHidden = new Set(this.state.hiddenLegendItems);
		if (!this.state.showLinkOverlay) renderHidden.add('link');
		const graph = filterLegendGraph(renderGraph, renderHidden);
		this.graph = graph;
		this.layout = layoutRadialGraph(layoutGraph, {
			ringSpacing: DEFAULT_RING_SPACING,
			nodeSpacing: DEFAULT_NODE_SPACING,
			swirlStrength: radial.swirlStrength,
		});
		const renderer = this.renderer;
		let revealRootId: string | null = null;
		renderer?.beginRenderBatch();
		try {
			renderer?.setTheme(this.resolvedCanvasScheme());
			renderer?.setData(graph, this.layout, radial.labelVisibility, radial.showRingGuides);
			this.resizeRenderer(!preserveView);
			if (preserveView) {
				const nextAnchorPoint = preserveAnchorId !== null ? (this.layout.positions.get(preserveAnchorId) ?? this.layout.positions.get(ROOT_ID) ?? null) : null;
				const anchorDx = nextAnchorPoint && preserveAnchorPoint ? nextAnchorPoint.x - preserveAnchorPoint.x : 0;
				const anchorDy = nextAnchorPoint && preserveAnchorPoint ? nextAnchorPoint.y - preserveAnchorPoint.y : 0;
				renderer?.setView(preserveView.centerX + anchorDx, preserveView.centerY + anchorDy, preserveView.zoom);
			}
			this.applyActiveState();
			if (shouldReveal) revealRootId = graph.rootId;
		} finally {
			renderer?.endRenderBatch();
		}
		if (shouldReveal && !this.disposed && token === this.rebuildToken) {
			if (revealRootId !== null) renderer?.playRevealFromRoot(revealRootId, loadingText);
			else renderer?.clearLoadingMask(true);
		}
		this.renderPanel();
	}

	private radial(): RadialSettings {
		return this.settings.radial;
	}

	private shouldPreserveView(reason: string): boolean {
		return ['legend', 'link-overlay', 'metadata'].includes(reason);
	}

	private legendNeutralLayoutState(): VisibleGraphState {
		return {
			...this.state,
			hiddenLegendItems: [],
			showLinkOverlay: true,
		};
	}

	private registerVaultEvents(): void {
		this.registerEvent(this.app.metadataCache.on('resolved', () => {
			if (this.startupSettled) this.redrawSoon();
		}));
		this.registerEvent(this.app.vault.on('rename', this.redrawSoon));
		this.registerEvent(this.app.vault.on('delete', this.redrawSoon));
		this.registerEvent(this.app.vault.on('create', this.redrawSoon));
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') this.redrawSoon();
			}),
		);
	}

	private async waitForStartupReady(): Promise<void> {
		await Promise.race([this.waitForMetadataResolved(), delay(1600)]);
		await animationFrames(2);
	}

	private waitForMetadataResolved(): Promise<void> {
		const cache = this.app.metadataCache;
		return new Promise((resolve) => {
			let settled = false;
			this.registerEvent(
				cache.on('resolved', () => {
					if (settled) return;
					settled = true;
					resolve();
				}),
			);
		});
	}

	private bindRendererEvents(): void {
		const canvas = this.renderer?.domElement;
		if (!canvas) return;
		const onWheel = (event: WheelEvent) => {
			event.preventDefault();
			const renderer = this.renderer;
			if (!renderer) return;
			const rect = canvas.getBoundingClientRect();
			const before = renderer.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
			const view = renderer.getView();
			const factor = Math.pow(1.45, -event.deltaY / 120);
			const zoom = Math.min(Math.max(view.zoom * factor, MIN_RADIAL_ZOOM), MAX_RADIAL_ZOOM);
			const afterCenterX = before.x - (event.clientX - rect.left - rect.width / 2) / zoom;
			const afterCenterY = before.y + (event.clientY - rect.top - rect.height / 2) / zoom;
			renderer.setView(afterCenterX, afterCenterY, zoom);
		};
		const onPointerDown = (event: PointerEvent) => {
			if (event.button !== 0) return;
			canvas.focus();
			const view = this.renderer?.getView();
			if (!view) return;
			this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, centerX: view.centerX, centerY: view.centerY, moved: false };
			canvas.setPointerCapture?.(event.pointerId);
		};
		const onPointerMove = (event: PointerEvent) => {
			const rect = canvas.getBoundingClientRect();
			if (this.drag) {
				const renderer = this.renderer;
				if (!renderer) return;
				const dx = event.clientX - this.drag.startX;
				const dy = event.clientY - this.drag.startY;
				this.drag.moved = this.drag.moved || Math.hypot(dx, dy) > 3;
				const view = renderer.getView();
				renderer.setView(this.drag.centerX - dx / view.zoom, this.drag.centerY + dy / view.zoom, view.zoom);
				return;
			}
			this.updateHover(event.clientX - rect.left, event.clientY - rect.top);
		};
		const onPointerUp = (event: PointerEvent) => {
			const wasDrag = this.drag?.moved ?? false;
			this.drag = null;
			canvas.releasePointerCapture?.(event.pointerId);
			if (wasDrag) return;
			const rect = canvas.getBoundingClientRect();
			this.activateAt(event.clientX - rect.left, event.clientY - rect.top, event);
		};
		const onLeave = () => {
			if (this.drag) return;
			this.hoverNodeId = null;
			this.hoverLink = null;
			this.applyActiveState();
		};
		const onDblClick = (event: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			const hit = this.renderer?.hitTest(event.clientX - rect.left, event.clientY - rect.top, false, this.hoverTargets().nodes);
			if (!hit?.nodeId || !this.graph) return;
			const node = this.graph.nodesById.get(hit.nodeId);
			if (!node) return;
			event.preventDefault();
			if (node.type === 'note') void this.openNode(node.id, event);
			else if (node.type === 'folder') this.useAsRoot(node.id);
		};
		const onContextMenu = (event: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			const hit = this.renderer?.hitTest(event.clientX - rect.left, event.clientY - rect.top, false, this.hoverTargets().nodes);
			if (!hit?.nodeId || !this.graph) return;
			const node = this.graph.nodesById.get(hit.nodeId);
			if (!node) return;
			event.preventDefault();
			this.showNodeMenu(event, node);
		};
		canvas.addEventListener('wheel', onWheel, { passive: false });
		canvas.addEventListener('pointerdown', onPointerDown);
		canvas.addEventListener('pointermove', onPointerMove);
		canvas.addEventListener('pointerup', onPointerUp);
		canvas.addEventListener('pointerleave', onLeave);
		canvas.addEventListener('dblclick', onDblClick);
		canvas.addEventListener('contextmenu', onContextMenu);
		this.register(() => {
			canvas.removeEventListener('wheel', onWheel);
			canvas.removeEventListener('pointerdown', onPointerDown);
			canvas.removeEventListener('pointermove', onPointerMove);
			canvas.removeEventListener('pointerup', onPointerUp);
			canvas.removeEventListener('pointerleave', onLeave);
			canvas.removeEventListener('dblclick', onDblClick);
			canvas.removeEventListener('contextmenu', onContextMenu);
		});
	}

	private updateHover(x: number, y: number): void {
		const targets = this.hoverTargets();
		const hit = this.renderer?.hitTest(x, y, targets.links, targets.nodes);
		const nextNode = hit?.nodeId ?? null;
		const nextLink = nextNode ? null : (hit?.edge ?? null);
		if (nextNode === this.hoverNodeId && (nextLink?.id ?? null) === (this.hoverLink?.id ?? null)) return;
		this.hoverNodeId = nextNode;
		this.hoverLink = nextLink;
		this.canvasHost?.toggleClass('is-pointing', Boolean(nextNode || nextLink));
		this.applyActiveState();
	}

	private activateAt(x: number, y: number, event: MouseEvent): void {
		const targets = this.hoverTargets();
		const hit = this.renderer?.hitTest(x, y, targets.links, targets.nodes);
		if (hit?.nodeId) {
			event.preventDefault();
			this.selectedNodeId = hit.nodeId;
			this.selectedLink = null;
			this.activePanelPage = 'inspect';
		} else if (hit?.edge) {
			event.preventDefault();
			this.selectedNodeId = null;
			this.selectedLink = hit.edge;
			this.activePanelPage = 'inspect';
		} else {
			this.selectedNodeId = null;
			this.selectedLink = null;
		}
		this.state.selectedNodeId = this.selectedNodeId;
		this.state.selectedLink = this.selectedLink;
		this.applyActiveState();
		this.renderPanel();
	}

	private applyActiveState(): void {
		if (!this.graph || !this.renderer) return;
		const active = this.resolveActiveState();
		this.renderer.setActive(active, this.radial().labelVisibility);
	}

	private resolveActiveState(): RadialActiveState {
		if (!this.graph) return emptyActiveState();
		const activeNode = this.hoverNodeId ?? this.selectedNodeId;
		const activeLink = this.hoverLink ?? this.selectedLink;
		const state = emptyActiveState();
		state.activeNodeId = activeNode;
		state.activeLinkId = activeLink?.id ?? null;
		const addNode = (nodeId: string | null | undefined, mode: string, pinned: boolean) => {
			if (!nodeId || !this.graph?.nodesById.has(nodeId)) return;
			state.relatedNodes.add(nodeId);
			state.labelNodes.add(nodeId);
			if (pinned) state.pinnedNodeIds.add(nodeId);
			if (hoverHighlightsNoteLinks(mode)) {
				for (const edge of [...this.graph.linkEdges, ...this.graph.hoverLinkEdges]) {
					if (edge.source !== nodeId && edge.target !== nodeId) continue;
					state.highlightedEdges.add(edge.id);
					state.relatedNodes.add(edge.source);
					state.relatedNodes.add(edge.target);
					state.labelNodes.add(edge.source);
					state.labelNodes.add(edge.target);
				}
			}
			addHierarchyHighlights(this.graph, nodeId, normalizeHoverHighlightMode(mode), state);
		};
		const addLink = (edge: WorldEdge | null | undefined, pinned: boolean) => {
			if (!edge) return;
			state.highlightedEdges.add(edge.id);
			state.relatedNodes.add(edge.source);
			state.relatedNodes.add(edge.target);
			state.labelNodes.add(edge.source);
			state.labelNodes.add(edge.target);
			if (pinned) {
				state.pinnedNodeIds.add(edge.source);
				state.pinnedNodeIds.add(edge.target);
			}
		};
		addNode(activeNode, this.state.hoverHighlightMode, false);
		addLink(activeLink, false);
		for (const pin of this.pinnedPaths) {
			if (!pin.active) continue;
			if (pin.kind === 'node') addNode(pin.nodeId, pin.mode, true);
			else addLink(this.findGraphEdgeForPin(pin), true);
		}
		state.hasActive = Boolean(activeNode || activeLink || this.pinnedPaths.some((pin) => pin.active));
		state.dimOthers = Boolean(activeNode || activeLink);
		return state;
	}

	private hoverTargets(): { nodes: boolean; links: boolean } {
		const mode = normalizeHoverTargetMode(this.radial().hoverTargetMode);
		return { nodes: mode !== 'links', links: mode !== 'nodes' };
	}

	private buildPanel(): void {
		this.panel = this.contentEl.createDiv({ cls: 'galaxy-panel mwm-radial-panel mwm-map-panel' });
		this.syncThemeClass();
		const header = this.panel.createDiv({ cls: 'galaxy-panel-header' });
		this.statsEl = header.createDiv({ cls: 'galaxy-panel-stats', text: 'Mini World Map' });
		const collapse = header.createEl('button', { cls: 'galaxy-panel-collapse', text: '-' });
		this.panelBody = this.panel.createDiv({ cls: 'galaxy-panel-body' });
		collapse.addEventListener('click', () => {
			const hidden = this.panelBody?.hasClass('is-hidden') ?? false;
			this.panelBody?.toggleClass('is-hidden', !hidden);
			collapse.setText(hidden ? '-' : '+');
		});
		this.renderPanel();
	}

	private renderPanel(): void {
		if (!this.panelBody) return;
		const graph = this.graph;
		this.panelBody.empty();
		if (this.statsEl) {
			this.statsEl.setText(this.t('stats.counts', { nodes: graph?.nodes.length ?? 0, links: graph?.linkEdges.length ?? 0 }));
		}
		const modeSwitch = this.panelBody.createDiv({ cls: 'mwm-mode-switch' });
		modeSwitch.createDiv({ cls: 'mwm-mode-switch-label', text: this.t('view.mode') });
		const modeRow = modeSwitch.createDiv({ cls: 'galaxy-mode-row mwm-mode-row' });
		this.modeButton(modeRow, viewModeLabel(this.settings.language, 'radial2d'), 'radial2d');
		this.modeButton(modeRow, viewModeLabel(this.settings.language, 'map3d'), 'map3d');

		const settings = this.panelBody.createDiv({ cls: 'mwm-panel-settings mwm-radial-settings' });
		const tabs = settings.createDiv({ cls: 'mwm-panel-tabs' });
		for (const [id, label] of [
			['inspect', this.t('tab.inspect')],
			['pins', this.t('tab.pins')],
			['view', this.t('tab.view')],
			['controls', this.t('tab.controls')],
			['defaults', this.t('tab.defaults')],
		] as const) {
			const button = tabs.createEl('button', { cls: this.activePanelPage === id ? 'is-active' : '', text: label, attr: { title: label } });
			button.addEventListener('click', () => {
				this.activePanelPage = id;
				this.renderPanel();
			});
		}
		const body = settings.createDiv({ cls: 'mwm-panel-page' });
		if (this.activePanelPage === 'pins') this.renderPinsPage(body);
		else if (this.activePanelPage === 'view') this.renderViewPage(body);
		else if (this.activePanelPage === 'controls') this.renderControlsPage(body);
		else if (this.activePanelPage === 'defaults') this.renderDefaultsPage(body);
		else this.renderInspectPage(body);
	}

	private modeButton(parent: HTMLElement, label: string, mode: ViewMode): void {
		const active = this.settings.viewMode === mode;
		const button = parent.createEl('button', { cls: active ? 'is-active' : '', text: label, attr: { title: label } });
		button.addEventListener('click', () => this.onViewMode(mode));
	}

	private renderInspectPage(parent: HTMLElement): void {
		if (!this.graph) return;
		if (this.selectedLink) {
			this.renderLinkInspect(parent, this.selectedLink);
			return;
		}
		const node = this.graph.nodesById.get(this.selectedNodeId ?? this.graph.focusId ?? this.graph.rootId);
		parent.createDiv({ cls: 'mwm-side-title', text: node?.title ?? 'Mini World Map' });
		if (!node) return;
		parent.createDiv({ cls: 'mwm-side-path', text: node.path || '/' });
		const facts = parent.createDiv({ cls: 'mwm-facts' });
		for (const [label, value] of [
			[this.t('inspect.type'), node.externalProxy ? `${this.t('inspect.external')} ${node.type}` : node.type],
			[this.t('inspect.depth'), String(node.depth)],
			[this.t('inspect.notes'), String(node.noteCount || node.descendantCount || 0)],
			[this.t('inspect.out'), String(node.linkCount || 0)],
			[this.t('inspect.in'), String(node.backlinkCount || 0)],
		]) {
			facts.createSpan({ text: label });
			facts.createSpan({ text: value });
		}
		const actions = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.button(actions, this.t('common.pin'), () => this.pinNode(node));
		if (node.type === 'note') this.button(actions, this.t('common.open'), () => void this.openNode(node.id));
		if (node.type === 'note') this.button(actions, this.t('common.focus'), () => this.focusNote(node.id));
		if (node.type === 'folder') this.button(actions, this.t('common.root'), () => this.useAsRoot(node.id));
		const rootParentId = this.currentRootParentId();
		if (rootParentId !== null) this.button(actions, this.t('inspect.parentRoot'), () => this.useAsRoot(rootParentId));
		this.renderNeighborList(parent, node);
	}

	private renderLinkInspect(parent: HTMLElement, edge: WorldEdge): void {
		parent.createDiv({ cls: 'mwm-side-title', text: this.t('inspect.linkOverlay') });
		const source = this.graph?.nodesById.get(edge.source);
		const target = this.graph?.nodesById.get(edge.target);
		const facts = parent.createDiv({ cls: 'mwm-facts' });
		for (const [label, value] of [
			[this.t('common.source'), source?.title ?? edge.source],
			[this.t('common.target'), target?.title ?? edge.target],
			[this.t('inspect.weight'), String(edge.weight || 0)],
			[this.t('inspect.raw'), String(edge.rawCount || edge.weight || 0)],
			[this.t('inspect.unresolved'), String(edge.unresolvedCount || 0)],
			[this.t('inspect.external'), String(edge.externalCount || 0)],
		]) {
			facts.createSpan({ text: label });
			facts.createSpan({ text: value });
		}
		const actions = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.button(actions, this.t('common.pin'), () => this.pinLink(edge));
		this.button(actions, this.t('common.source'), () => this.inspectNode(edge.source));
		this.button(actions, this.t('common.target'), () => this.inspectNode(edge.target));
	}

	private renderNeighborList(parent: HTMLElement, node: WorldNode): void {
		const outgoing = (this.index.linkEdgesBySource.get(node.id) ?? []).slice(0, 20);
		const incoming = (this.index.linkEdgesByTarget.get(node.id) ?? []).slice(0, 20);
		for (const [title, edges, side] of [
			[this.t('inspect.outgoing', { count: outgoing.length }), outgoing, 'target'],
			[this.t('inspect.backlinks', { count: incoming.length }), incoming, 'source'],
		] as const) {
			parent.createDiv({ cls: 'mwm-side-heading', text: title });
			if (edges.length === 0) parent.createDiv({ cls: 'mwm-side-muted', text: this.t('common.none') });
			for (const edge of edges) {
				const neighbor = this.index.nodes.get(edge[side]);
				if (!neighbor) continue;
				const label = `${neighbor.title} (${edge.weight})`;
				const button = parent.createEl('button', { cls: 'mwm-link-row', text: label, attr: { title: label } });
				button.addEventListener('click', () => this.inspectNode(neighbor.id));
			}
		}
	}

	private renderPinsPage(parent: HTMLElement): void {
		const actions = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.button(actions, this.t('common.pinCurrent'), () => this.pinCurrent());
		this.button(actions, this.t('common.clear'), () => this.clearPins());
		const groupRow = parent.createDiv({ cls: 'mwm-pin-group-row' });
		const input = groupRow.createEl('input', { attr: { value: this.pinGroupName, placeholder: this.t('pins.groupName') } });
		input.addEventListener('input', () => (this.pinGroupName = input.value));
		this.button(groupRow, this.t('common.group'), () => this.groupSelectedPins());
		if (this.pinnedPaths.length === 0) {
			parent.createDiv({ cls: 'mwm-side-muted', text: this.t('pins.empty') });
			return;
		}
		const groupsById = new Map(this.pinGroups.map((group) => [group.id, group]));
		const pinsByGroup = new Map<string, PinPath[]>();
		const ungrouped: PinPath[] = [];
		for (const pin of this.pinnedPaths) {
			if (!pin.groupId || !groupsById.has(pin.groupId)) {
				ungrouped.push(pin);
				continue;
			}
			const list = pinsByGroup.get(pin.groupId) ?? [];
			list.push(pin);
			pinsByGroup.set(pin.groupId, list);
		}
		if (ungrouped.length) this.renderPinGroup(parent, null, ungrouped);
		for (const group of this.pinGroups) {
			const pins = pinsByGroup.get(group.id) ?? [];
			if (pins.length) this.renderPinGroup(parent, group, pins);
		}
	}

	private renderPinGroup(parent: HTMLElement, group: PinGroup | null, pins: PinPath[]): void {
		const wrapper = parent.createDiv({ cls: 'mwm-pin-group' });
		const header = wrapper.createDiv({ cls: 'mwm-pin-group-header' });
		header.createSpan({ cls: 'mwm-pin-group-title', text: group?.name ?? this.t('pins.ungrouped') });
		header.createSpan({ cls: 'mwm-pin-count', text: String(pins.length) });
		if (group) this.button(header, this.t('common.ungroup'), () => this.removePinGroup(group.id));
		for (const pin of pins) this.renderPinRow(wrapper, pin);
	}

	private renderPinRow(parent: HTMLElement, pin: PinPath): void {
		const row = parent.createDiv({ cls: pin.active ? 'mwm-pin-row' : 'mwm-pin-row is-muted' });
		const check = row.createEl('input', {
			cls: 'mwm-pin-check',
			attr: { type: 'checkbox', title: this.t('pins.selectForGroup'), 'aria-label': this.t('pins.selectForGroup') },
		});
		check.checked = this.selectedPinIds.has(pin.id);
		check.addEventListener('change', () => {
			if (check.checked) this.selectedPinIds.add(pin.id);
			else this.selectedPinIds.delete(pin.id);
			this.renderPanel();
		});
		const main = row.createEl('button', { cls: 'mwm-pin-main', attr: { type: 'button', title: pin.path || pin.title } });
		main.addEventListener('click', () => this.locatePin(pin));
		main.createDiv({ cls: 'mwm-pin-title', text: pin.title });
		main.createDiv({ cls: 'mwm-pin-meta', text: `${this.pinKindLabel(pin)} - ${pin.path || '/'}` });
		this.button(row, pin.active ? this.t('pins.hideHighlight') : this.t('pins.showHighlight'), () => this.togglePinHighlight(pin.id));
		this.button(row, this.t('common.inspect'), () => this.inspectPin(pin));
		if (pin.groupId) this.button(row, this.t('common.ungroup'), () => this.ungroupPin(pin.id));
		this.button(row, 'X', () => this.removePin(pin.id));
	}

	private renderViewPage(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.button(row, this.t('common.search'), () => this.openSearch());
		this.button(row, this.t('common.recenter'), () => this.centerCurrentView());
		this.button(row, this.t('common.rebuild'), () => this.rebuild('manual'));
		const row2 = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.button(row2, this.t('view.atlas'), () => this.resetToAtlas(), this.state.mode === 'atlas' && !this.state.showCompleteRoot);
		this.button(row2, this.t('view.focus'), () => this.focusActiveNote(), this.state.mode === 'focus');
		this.button(row2, this.t('view.vaultRoot'), () => this.resetToRoot());
		this.button(row2, this.t('view.completeMap'), () => this.showCompleteMap(), this.state.showCompleteRoot);
		this.select(parent, this.t('view.theme'), this.radial().colorScheme, colorSchemeOptions(this.settings.language), (value) => {
			this.radial().colorScheme = normalizeColorScheme(value);
			this.saveSoon();
			this.syncThemeClass();
		});
	}

	openSearch(): void {
		if (!this.index.ready) this.index.rebuild(this.radial());
		const items = [...this.index.nodes.values()].map((node) => {
			const linkCount = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
			const noteCount = Math.max(0, node.noteCount || node.descendantCount || 0);
			const path = node.path || this.t('3d.card.root');
			const kind = this.searchKindLabel(node);
			const countText =
				node.type === 'folder' || node.type === 'external'
					? this.t('search.notes', { count: noteCount })
					: this.t('3d.searchLinks', { count: linkCount });
			return {
				value: node,
				title: node.title,
				path,
				detail: `${kind} · ${path} · ${countText}`,
				rank: linkCount + Math.log2(noteCount + 1) * 8 - node.depth,
				unresolved: node.type === 'unresolved',
				hideWhenEmpty: node.id === ROOT_ID,
				searchText: [node.title, node.path, node.id],
			};
		});
		new NodeSearchModal(this.app, items, (node) => void this.selectSearchNode(node), this.t('2d.searchPlaceholder')).open();
	}

	private async selectSearchNode(node: WorldNode): Promise<void> {
		const visualId = this.index.visualNodeId(node.id) ?? node.id;
		this.selectedNodeId = visualId;
		this.selectedLink = null;
		this.hoverNodeId = null;
		this.hoverLink = null;
		this.activePanelPage = 'inspect';
		this.state.search = '';
		this.state.selectedNodeId = visualId;
		this.state.selectedLink = null;
		if (this.state.mode === 'focus' && node.type !== 'folder') {
			this.state.mode = 'focus';
			this.state.rootPath = ROOT_ID;
			this.state.focusPath = node.id;
			await this.queueRebuild('focus');
		} else {
			await this.showSearchNodeInAtlas(node, visualId);
		}
		this.centerNode(visualId);
	}

	private async showSearchNodeInAtlas(node: WorldNode, visualId: string): Promise<void> {
		this.state.mode = 'atlas';
		this.state.focusPath = null;
		if (node.type === 'folder') {
			this.leaveCompleteMap();
			this.state.rootPath = visualId;
			await this.queueRebuild('root');
			return;
		}
		if (this.graph?.nodesById.has(visualId)) {
			this.applyActiveState();
			this.renderPanel();
			return;
		}
		this.leaveCompleteMap();
		this.state.rootPath = this.searchAtlasRoot(node, visualId);
		await this.queueRebuild('root');
	}

	private searchAtlasRoot(node: WorldNode, visualId: string): string {
		const visualNode = this.index.nodes.get(visualId);
		if (visualNode?.type === 'folder') return visualNode.id;
		const parentId = visualNode?.parentId ?? node.parentId;
		return parentId && this.index.nodes.has(parentId) ? parentId : ROOT_ID;
	}

	private centerCurrentView(): void {
		const rootId = this.graph?.rootId ?? ROOT_ID;
		if (this.renderer?.fitToLayout(rootId)) this.needsFit = false;
	}

	private showCompleteMap(): void {
		this.state.showCompleteRoot = true;
		this.applyCompleteMapState();
		this.needsFit = true;
		this.rebuild('complete');
	}

	private applyCompleteMapState(): void {
		this.state.mode = 'atlas';
		this.state.rootPath = ROOT_ID;
		this.state.focusPath = null;
		this.state.search = '';
		this.state.atlasDepth = MAX_ATLAS_DEPTH;
		this.state.nodeLimit = MAX_RENDER_NODE_LIMIT;
		this.state.linkLimit = MAX_LINK_LIMIT;
		this.state.externalLinkAnchorLimit = MAX_EXTERNAL_LINK_ANCHOR_LIMIT;
		this.state.showLinkOverlay = true;
		this.state.showExternalLinks = true;
		this.state.externalDetailMode = 'exact';
		this.state.hiddenLegendItems = [];
	}

	private leaveCompleteMap(): void {
		if (!this.state.showCompleteRoot) return;
		const radial = this.radial();
		this.state.showCompleteRoot = false;
		this.state.atlasDepth = radial.atlasDepth;
		this.state.nodeLimit = radial.renderNodeLimit;
		this.state.linkLimit = radial.linkLimit;
		this.state.externalLinkAnchorLimit = radial.externalLinkAnchorLimit;
		this.state.showExternalLinks = radial.showExternalLinks;
		this.state.externalDetailMode = radial.externalDetailMode;
		this.state.hiddenLegendItems = radial.hiddenLegendItems.slice();
		this.state.showLinkOverlay = radial.showLinkOverlay || !this.state.hiddenLegendItems.includes('link');
	}

	private centerNode(nodeId: string): void {
		const point = this.renderer?.nodePoint(nodeId);
		const view = this.renderer?.getView();
		if (!point || !view) return;
		this.renderer?.setView(point.x, point.y, Math.max(view.zoom, SEARCH_FOCUS_ZOOM));
		this.needsFit = false;
	}

	private searchKindLabel(node: WorldNode): string {
		if (node.type === 'folder') return this.t('search.folder');
		if (node.type === 'unresolved') return this.t('3d.searchUnresolved');
		if (node.type === 'external') return this.t('search.external');
		return this.t('search.note');
	}

	private renderControlsPage(parent: HTMLElement): void {
		const radial = this.radial();
		this.numberInput(parent, this.t('control.depth'), this.state.atlasDepth, 1, MAX_ATLAS_DEPTH, 1, (value) => {
			this.leaveCompleteMap();
			this.state.atlasDepth = value;
			this.rebuild('depth');
		});
		this.numberInput(parent, this.t('control.nodes'), this.state.nodeLimit, 200, MAX_RENDER_NODE_LIMIT, 100, (value) => {
			this.leaveCompleteMap();
			this.state.nodeLimit = value;
			this.rebuild('nodes');
		});
		this.numberInput(parent, this.t('control.noteLinks'), this.state.linkLimit, 0, MAX_LINK_LIMIT, 50, (value) => {
			this.leaveCompleteMap();
			this.state.linkLimit = value;
			this.rebuild('links');
		});
		const hidden = new Set(this.state.hiddenLegendItems);
		const noteLinksVisible = this.state.showLinkOverlay && !hidden.has('link');
		this.toggle(parent, this.t('control.showNoteLinks'), noteLinksVisible, (value) => {
			this.leaveCompleteMap();
			radial.showLinkOverlay = value;
			this.state.showLinkOverlay = value;
			this.setLegendHidden('link', !value);
			this.saveSoon();
			this.rebuild('link-overlay');
		});
		this.select(parent, this.t('control.hover'), this.state.hoverHighlightMode, hoverModeOptions(this.settings.language, HOVER_HIGHLIGHT_MODE_OPTIONS), (value) => {
			const mode = normalizeHoverHighlightMode(value);
			this.state.hoverHighlightMode = mode;
			radial.hoverHighlightMode = mode;
			this.state.pinNeedsHoverLinks = this.pinnedPathsNeedHoverLinks();
			this.saveSoon();
			this.rebuild('hover');
		});
		this.select(parent, this.t('control.hoverTargets'), radial.hoverTargetMode, hoverTargetOptions(this.settings.language, HOVER_TARGET_MODE_OPTIONS), (value) => {
			radial.hoverTargetMode = normalizeHoverTargetMode(value);
			this.clearDisallowedHoverTargets();
			this.saveSoon();
			this.applyActiveState();
			this.renderPanel();
		});
		this.select(parent, this.t('control.labels'), radial.labelVisibility, labelVisibilityOptions(this.settings.language, LABEL_VISIBILITY_OPTIONS), (value) => {
			radial.labelVisibility = normalizeLabelVisibility(value);
			this.state.labelVisibility = radial.labelVisibility;
			this.saveSoon();
			this.applyActiveState();
		});
		this.numberInput(parent, this.t('control.spin'), radial.swirlStrength, 0, MAX_SWIRL_STRENGTH, 1, (value) => {
			radial.swirlStrength = value;
			this.saveSoon();
			this.rebuild('spin');
		});
		this.toggle(parent, this.t('control.ringGuides'), radial.showRingGuides, (value) => {
			radial.showRingGuides = value;
			this.saveSoon();
			if (this.graph && this.layout && this.renderer) {
				this.renderer.setData(this.graph, this.layout, radial.labelVisibility, radial.showRingGuides);
				this.applyActiveState();
			}
			this.renderPanel();
		});
		this.toggle(parent, this.t('control.outsideLinks'), this.state.showExternalLinks, (value) => {
			this.leaveCompleteMap();
			this.state.showExternalLinks = value;
			radial.showExternalLinks = value;
			this.saveSoon();
			this.rebuild('external');
		});
		this.select(
			parent,
			this.t('control.outsideDetail'),
			this.state.externalDetailMode,
			outsideDetailOptions(this.settings.language),
			(value) => {
				this.leaveCompleteMap();
				this.state.externalDetailMode = normalizeExternalDetailMode(value);
				radial.externalDetailMode = this.state.externalDetailMode;
				this.saveSoon();
				this.rebuild('external-mode');
			},
		);
		this.numberInput(parent, this.t('control.exactOutsideFiles'), this.state.externalLinkAnchorLimit, 0, MAX_EXTERNAL_LINK_ANCHOR_LIMIT, 50, (value) => {
			this.leaveCompleteMap();
			this.state.externalLinkAnchorLimit = value;
			radial.externalLinkAnchorLimit = value;
			this.saveSoon();
			this.rebuild('external-limit');
		});
		this.renderLegend(parent);
	}

	private renderDefaultsPage(parent: HTMLElement): void {
		const radial = this.radial();
		this.numberInput(parent, this.t('control.defaultDepth'), radial.atlasDepth, 1, MAX_ATLAS_DEPTH, 1, (value) => {
			radial.atlasDepth = value;
			this.state.atlasDepth = value;
			this.saveSoon();
		});
		this.numberInput(parent, this.t('control.defaultNodes'), radial.renderNodeLimit, 200, MAX_RENDER_NODE_LIMIT, 100, (value) => {
			radial.renderNodeLimit = value;
			this.state.nodeLimit = value;
			this.saveSoon();
		});
		this.numberInput(parent, this.t('control.defaultNoteLinks'), radial.linkLimit, 0, MAX_LINK_LIMIT, 50, (value) => {
			radial.linkLimit = value;
			this.state.linkLimit = value;
			this.saveSoon();
		});
		this.toggle(parent, this.t('control.unresolvedLinks'), radial.includeUnresolvedLinks, (value) => {
			radial.includeUnresolvedLinks = value;
			this.saveSoon();
			this.rebuild('unresolved');
		});
		this.textArea(parent, this.t('control.ignoredFolders'), radial.ignoreFolders.join('\n'), (value) => {
			radial.ignoreFolders = value
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean);
			this.saveSoon();
			this.rebuild('ignored');
		});
	}

	private renderLegend(parent: HTMLElement): void {
		parent.createDiv({ cls: 'mwm-side-heading', text: this.t('control.legend') });
		const hidden = new Set(this.state.hiddenLegendItems);
		for (const [id, labelKey, titleKey, markerClass] of LEGEND_ITEM_DEFINITIONS) {
			const row = parent.createEl('label', {
				cls: hidden.has(id) ? 'mwm-legend-item is-muted' : 'mwm-legend-item',
				attr: { title: this.t(titleKey) },
			});
			const checkbox = row.createEl('input', { attr: { type: 'checkbox' } });
			checkbox.checked = !hidden.has(id);
			row.createSpan({ cls: `mwm-legend-mark ${markerClass}` });
			const text = row.createSpan({ cls: 'mwm-legend-copy' });
			text.createSpan({ cls: 'mwm-legend-label', text: this.t(labelKey) });
			text.createSpan({ cls: 'mwm-legend-desc', text: this.t(titleKey) });
			checkbox.addEventListener('change', () => {
				this.leaveCompleteMap();
				const value = checkbox.checked;
				if (value) hidden.delete(id);
				else hidden.add(id);
				this.radial().hiddenLegendItems = [...hidden];
				this.state.hiddenLegendItems = [...hidden];
				if (id === 'link') {
					this.radial().showLinkOverlay = value;
					this.state.showLinkOverlay = value;
				}
				this.saveSoon();
				this.rebuild('legend');
			});
		}
	}

	private setLegendHidden(id: string, isHidden: boolean): void {
		const hidden = new Set(this.radial().hiddenLegendItems);
		if (isHidden) hidden.add(id);
		else hidden.delete(id);
		this.radial().hiddenLegendItems = [...hidden];
		this.state.hiddenLegendItems = [...hidden];
	}

	private buildFloatingControls(): void {
		const host = this.canvasHost;
		if (!host) return;
		const controls = host.createDiv({ cls: 'mwm-floating-controls' });
		const languageButton = controls.createEl('button', {
			cls: 'mwm-floating-button',
			attr: { type: 'button', title: this.t('language'), 'aria-label': this.t('language') },
		});
		setIcon(languageButton, 'languages');
		languageButton.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openLanguageMenu(languageButton);
		});
	}

	private openLanguageMenu(anchor: HTMLElement): void {
		const menu = new Menu();
		for (const [value, label] of languageOptions(this.settings.language)) {
			menu.addItem((item) => {
				item.setTitle(label);
				if (value === this.settings.language) item.setIcon('check');
				item.onClick(() => {
					const language = normalizeLanguage(value);
					if (language === this.settings.language) return;
					this.settings.language = language;
					this.onLanguage(language);
					this.renderPanel();
				});
			});
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.right, y: rect.bottom });
	}

	private button(parent: HTMLElement, label: string, onClick: () => void, active = false): HTMLButtonElement {
		const button = parent.createEl('button', { cls: active ? 'is-active' : '', text: label, attr: { title: label } });
		button.addEventListener('click', onClick);
		return button;
	}

	private numberInput(parent: HTMLElement, label: string, value: number, min: number, max: number, step: number, onChange: (value: number) => void): void {
		const field = parent.createEl('label', { cls: 'mwm-panel-field' });
		field.createSpan({ text: label });
		const input = field.createEl('input', { attr: { value: String(value), type: 'number', min: String(min), max: String(max), step: String(step) } });
		input.addEventListener('change', () => onChange(clampNumber(input.value, min, max, value)));
	}

	private textArea(parent: HTMLElement, label: string, value: string, onChange: (value: string) => void): void {
		const field = parent.createEl('label', { cls: 'mwm-panel-field mwm-panel-field-stack' });
		field.createSpan({ text: label });
		const input = field.createEl('textarea');
		input.value = value;
		input.addEventListener('change', () => onChange(input.value));
	}

	private toggle(parent: HTMLElement, label: string, value: boolean, onChange: (value: boolean) => void, title?: string): void {
		const field = parent.createEl('label', { cls: 'mwm-panel-toggle', attr: { title: title ?? label } });
		const input = field.createEl('input', { attr: { type: 'checkbox' } });
		input.checked = value;
		field.createSpan({ text: label });
		input.addEventListener('change', () => onChange(input.checked));
	}

	private select<T extends string>(parent: HTMLElement, label: string, value: T, options: [T, string][], onChange: (value: T) => void): void {
		const field = parent.createEl('label', { cls: 'mwm-panel-field' });
		field.createSpan({ text: label });
		const select = field.createEl('select');
		for (const [id, text] of options) select.createEl('option', { attr: { value: id }, text });
		select.value = value;
		select.addEventListener('change', () => onChange(select.value as T));
	}

	private pinCurrent(): void {
		if (this.selectedLink) this.pinLink(this.selectedLink);
		else if (this.selectedNodeId && this.graph?.nodesById.has(this.selectedNodeId)) this.pinNode(this.graph.nodesById.get(this.selectedNodeId)!);
		else if (this.hoverLink) this.pinLink(this.hoverLink);
		else if (this.hoverNodeId && this.graph?.nodesById.has(this.hoverNodeId)) this.pinNode(this.graph.nodesById.get(this.hoverNodeId)!);
		else new Notice(this.t('pins.selectBeforePin'));
	}

	private pinNode(node: WorldNode): void {
		this.addPin({
			kind: 'node',
			nodeId: node.id,
			mode: this.state.hoverHighlightMode,
			title: node.title,
			path: node.path || '/',
		});
	}

	private pinLink(edge: WorldEdge): void {
		const source = this.graph?.nodesById.get(edge.source);
		const target = this.graph?.nodesById.get(edge.target);
		this.addPin({
			kind: 'link',
			edgeId: edge.id,
			source: edge.source,
			target: edge.target,
			mode: 'note-links',
			title: `${source?.title ?? edge.source} -> ${target?.title ?? edge.target}`,
			path: `${source?.path ?? edge.source} -> ${target?.path ?? edge.target}`,
		});
	}

	private addPin(candidate: Omit<PinPath, 'id' | 'key' | 'active' | 'groupId'>): void {
		const key = candidate.kind === 'node' ? `node:${candidate.nodeId}:${candidate.mode}` : `link:${candidate.edgeId ?? `${candidate.source}->${candidate.target}`}`;
		const pin: PinPath = { ...candidate, id: `pin-${this.nextPinId++}`, key, active: true, groupId: null };
		this.pinnedPaths.push(pin);
		this.selectedPinIds.add(pin.id);
		this.state.pinNeedsHoverLinks = this.pinnedPathsNeedHoverLinks();
		this.applyActiveState();
		this.activePanelPage = 'pins';
		this.renderPanel();
	}

	private removePin(id: string): void {
		this.pinnedPaths = this.pinnedPaths.filter((pin) => pin.id !== id);
		this.selectedPinIds.delete(id);
		this.dropEmptyPinGroups();
		this.state.pinNeedsHoverLinks = this.pinnedPathsNeedHoverLinks();
		this.applyActiveState();
		this.renderPanel();
	}

	private clearPins(): void {
		this.pinnedPaths = [];
		this.pinGroups = [];
		this.selectedPinIds.clear();
		this.state.pinNeedsHoverLinks = false;
		this.applyActiveState();
		this.renderPanel();
	}

	private groupSelectedPins(): void {
		const pins = this.pinnedPaths.filter((pin) => this.selectedPinIds.has(pin.id));
		if (pins.length === 0) {
			new Notice(this.t('pins.selectFirst'));
			return;
		}
		const groupId = `pin-group-${this.nextPinGroupId++}`;
		this.pinGroups.push({ id: groupId, name: this.pinGroupName.trim() || `Group ${this.pinGroups.length + 1}` });
		for (const pin of pins) pin.groupId = groupId;
		this.dropEmptyPinGroups();
		this.pinGroupName = '';
		this.selectedPinIds.clear();
		this.renderPanel();
	}

	private removePinGroup(groupId: string): void {
		this.pinGroups = this.pinGroups.filter((group) => group.id !== groupId);
		for (const pin of this.pinnedPaths) {
			if (pin.groupId === groupId) pin.groupId = null;
		}
		this.renderPanel();
	}

	private ungroupPin(pinId: string): void {
		const pin = this.pinnedPaths.find((item) => item.id === pinId);
		if (!pin) return;
		pin.groupId = null;
		this.dropEmptyPinGroups();
		this.renderPanel();
	}

	private dropEmptyPinGroups(): void {
		const usedGroups = new Set(this.pinnedPaths.map((pin) => pin.groupId).filter((id): id is string => Boolean(id)));
		this.pinGroups = this.pinGroups.filter((group) => usedGroups.has(group.id));
	}

	private togglePinHighlight(pinId: string): void {
		const pin = this.pinnedPaths.find((item) => item.id === pinId);
		if (!pin) return;
		pin.active = !pin.active;
		this.state.pinNeedsHoverLinks = this.pinnedPathsNeedHoverLinks();
		this.applyActiveState();
		this.renderPanel();
	}

	private locatePin(pin: PinPath): void {
		const nodeId = pin.kind === 'node' ? pin.nodeId : pin.source;
		if (!nodeId) return;
		const point = this.renderer?.nodePoint(nodeId);
		const view = this.renderer?.getView();
		if (point && view) this.renderer?.setView(point.x, point.y, Math.max(view.zoom, 0.22));
	}

	private inspectPin(pin: PinPath): void {
		this.activePanelPage = 'inspect';
		if (pin.kind === 'node' && pin.nodeId) this.inspectNode(pin.nodeId);
		else this.selectedLink = this.findGraphEdgeForPin(pin);
		this.applyActiveState();
		this.renderPanel();
	}

	private findGraphEdgeForPin(pin: PinPath): WorldEdge | null {
		if (pin.kind !== 'link' || !this.graph) return null;
		return [...this.graph.linkEdges, ...this.graph.hoverLinkEdges].find((edge) => edge.id === pin.edgeId || (edge.source === pin.source && edge.target === pin.target)) ?? null;
	}

	private pinnedPathsNeedHoverLinks(): boolean {
		return this.pinnedPaths.some((pin) => pin.active && (pin.kind === 'link' || (pin.kind === 'node' && hoverHighlightsNoteLinks(pin.mode))));
	}

	private pinKindLabel(pin: PinPath): string {
		return pin.kind === 'link' ? this.t('inspect.linkOverlay') : this.t(`hover.${normalizeHoverHighlightMode(pin.mode)}`);
	}

	private clearDisallowedHoverTargets(): void {
		const targets = this.hoverTargets();
		if (!targets.nodes) this.hoverNodeId = null;
		if (!targets.links) this.hoverLink = null;
		this.canvasHost?.toggleClass('is-pointing', Boolean((targets.nodes && this.hoverNodeId) || (targets.links && this.hoverLink)));
	}

	private inspectNode(nodeId: string): void {
		this.selectedNodeId = nodeId;
		this.selectedLink = null;
		this.applyActiveState();
		this.renderPanel();
	}

	private resetToAtlas(): void {
		this.leaveCompleteMap();
		this.state.mode = 'atlas';
		this.state.rootPath = this.state.rootPath || ROOT_ID;
		this.state.focusPath = null;
		this.needsFit = true;
		this.rebuild('atlas');
	}

	private resetToRoot(): void {
		this.leaveCompleteMap();
		this.state.mode = 'atlas';
		this.state.rootPath = ROOT_ID;
		this.state.focusPath = null;
		this.needsFit = true;
		this.rebuild('root');
	}

	private currentRootParentId(): string | null {
		const rootId = this.graph?.rootId ?? this.state.rootPath;
		if (rootId === ROOT_ID) return null;
		const rootNode = this.graph?.nodesById.get(rootId) ?? this.index.nodes.get(rootId);
		if (rootNode?.parentId !== undefined && rootNode.parentId !== null) return rootNode.parentId;
		const lastSlash = rootId.lastIndexOf('/');
		return lastSlash >= 0 ? rootId.slice(0, lastSlash) : ROOT_ID;
	}

	private useAsRoot(nodeId: string): void {
		this.leaveCompleteMap();
		this.state.mode = 'atlas';
		this.state.rootPath = nodeId;
		this.state.focusPath = null;
		this.needsFit = true;
		this.rebuild('root');
	}

	private focusActiveNote(): void {
		const selected = this.selectedNodeId ? this.index.nodes.get(this.selectedNodeId) : null;
		const active = selected?.type === 'note' ? selected.id : this.index.getActiveNotePath();
		if (active) this.focusNote(active);
	}

	private focusNote(nodeId: string): void {
		this.leaveCompleteMap();
		this.state.mode = 'focus';
		this.state.focusPath = nodeId;
		this.state.rootPath = ROOT_ID;
		this.needsFit = true;
		this.rebuild('focus');
	}

	private showNodeMenu(event: MouseEvent, node: WorldNode): void {
		const menu = new Menu();
		if (node.type === 'note') {
			menu.addItem((item) => item.setTitle(this.t('context.openNote')).setIcon('file-text').onClick(() => void this.openNode(node.id, event)));
			menu.addItem((item) => item.setTitle(this.t('context.focusNote')).setIcon('locate-fixed').onClick(() => this.focusNote(node.id)));
		}
		if (node.type === 'folder') {
			menu.addItem((item) => item.setTitle(this.t('context.useAsRoot')).setIcon('folder-open').onClick(() => this.useAsRoot(node.id)));
			if (node.representativeFile) {
				menu.addItem((item) => item.setTitle(this.t('context.openRepresentative')).setIcon('file-text').onClick(() => void this.openNode(node.representativeFile!, event)));
			}
		}
		menu.addItem((item) => item.setTitle(this.t('context.pinPath')).setIcon('pin').onClick(() => this.pinNode(node)));
		menu.showAtMouseEvent(event);
	}

	private async openNode(path: string, event?: MouseEvent): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return;
		const target = event && (event.metaKey || event.ctrlKey) ? 'split' : 'tab';
		await this.app.workspace.openLinkText(file.path, '', target, { active: true });
	}

	private syncThemeClass(): void {
		const canvasScheme = this.resolvedCanvasScheme();
		const panelScheme = this.resolvedPanelScheme();
		const canvasBackground = resolveObsidianBackground(canvasScheme, radialFallbackBackground(canvasScheme));
		this.contentEl.style.setProperty('--mwm-radial-bg', canvasBackground);
		this.contentEl.toggleClass('is-day-scheme', canvasScheme === 'day');
		this.contentEl.toggleClass('is-night-scheme', canvasScheme === 'night');
		this.panel?.removeClass('gx-theme-dark');
		this.panel?.removeClass('gx-theme-light');
		this.panel?.addClass(panelScheme === 'day' ? 'gx-theme-light' : 'gx-theme-dark');
		const renderer = this.renderer;
		renderer?.beginRenderBatch();
		try {
			const changed = renderer?.setTheme(canvasScheme, canvasBackground) ?? false;
			if (changed && this.graph && this.layout) renderer?.setData(this.graph, this.layout, this.radial().labelVisibility, this.radial().showRingGuides);
		} finally {
			renderer?.endRenderBatch();
		}
	}

	private resolvedCanvasScheme(): RadialResolvedScheme {
		const scheme = normalizeColorScheme(this.radial().colorScheme);
		if (scheme === 'day' || scheme === 'night') return scheme;
		return activeDocument.body.hasClass('theme-dark') ? 'night' : 'day';
	}

	private resolvedPanelScheme(): RadialResolvedScheme {
		return activeDocument.body.hasClass('theme-dark') ? 'night' : 'day';
	}

	private t(key: string, vars: Record<string, string | number> = {}): string {
		return t(this.settings.language, key, vars);
	}

	dispose(): void {
		this.unload();
		this.renderer?.dispose();
		this.renderer = null;
		this.contentEl.removeClass('mwm-radial-mode');
		this.contentEl.empty();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

function animationFrames(count: number): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		let timer = 0;
		const finish = () => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			resolve();
		};
		timer = window.setTimeout(finish, 96);
		let remaining = Math.max(0, count);
		const step = () => {
			if (done) return;
			remaining--;
			if (remaining <= 0) {
				finish();
				return;
			}
			window.requestAnimationFrame(step);
		};
		if (remaining <= 0) finish();
		else window.requestAnimationFrame(step);
	});
}

function addHierarchyHighlights(
	graph: VisibleWorldGraph,
	nodeId: string,
	mode: ReturnType<typeof normalizeHoverHighlightMode>,
	state: RadialActiveState,
): void {
	if (mode === 'none' || mode === 'note-links') return;
	const parentByChild = new Map(graph.hierarchyEdges.map((edge) => [edge.target, edge]));
	const childrenByParent = new Map<string, WorldEdge[]>();
	for (const edge of graph.hierarchyEdges) {
		const list = childrenByParent.get(edge.source);
		if (list) list.push(edge);
		else childrenByParent.set(edge.source, [edge]);
	}
	const addEdge = (edge: WorldEdge) => {
		state.highlightedEdges.add(edge.id);
		state.relatedNodes.add(edge.source);
		state.relatedNodes.add(edge.target);
		state.labelNodes.add(edge.source);
		state.labelNodes.add(edge.target);
	};
	if (mode === 'hierarchy-parents' || mode === 'hierarchy-parents-direct' || mode === 'hierarchy-all') {
		let edge = parentByChild.get(nodeId);
		while (edge) {
			addEdge(edge);
			edge = parentByChild.get(edge.source);
		}
	}
	if (mode === 'hierarchy-direct-children' || mode === 'hierarchy-parents-direct' || mode === 'hierarchy-all') {
		for (const edge of childrenByParent.get(nodeId) ?? []) addEdge(edge);
	}
	if (mode === 'hierarchy-descendants' || mode === 'hierarchy-all') {
		const stack = [...(childrenByParent.get(nodeId) ?? [])];
		while (stack.length > 0) {
			const edge = stack.pop();
			if (!edge) continue;
			addEdge(edge);
			stack.push(...(childrenByParent.get(edge.target) ?? []));
		}
	}
}

function filterLegendGraph(graph: VisibleWorldGraph, hidden: Set<string>): VisibleWorldGraph {
	if (hidden.size === 0) return graph;
	const keepNode = (node: WorldNode) => {
		if (node.id === graph.rootId && hidden.has('root')) return false;
		if (node.externalProxy && hidden.has('outside-file')) return false;
		if (node.type === 'external' && !node.externalProxy && hidden.has('outside')) return false;
		if (node.type === 'unresolved' && hidden.has('missing')) return false;
		if (node.type === 'folder' && node.representativeFile && hidden.has('folder-meta')) return false;
		if (node.type === 'folder' && !node.representativeFile && hidden.has('folder')) return false;
		if (node.type === 'note' && hidden.has('file')) return false;
		return true;
	};
	const nodes = graph.nodes.filter(keepNode);
	const ids = new Set(nodes.map((node) => node.id));
	const keepEdge = (edge: WorldEdge) => ids.has(edge.source) && ids.has(edge.target);
	const hierarchyEdges = hidden.has('tree') ? [] : graph.hierarchyEdges.filter(keepEdge);
	const keepLinkEdge = (edge: WorldEdge) => {
		if (!keepEdge(edge)) return false;
		if (edge.externalCount && hidden.has('outside-link')) return false;
		if (edge.unresolvedCount && hidden.has('dashed-link')) return false;
		return Boolean(edge.externalCount) || !hidden.has('link');
	};
	const keepHoverLinkEdge = (edge: WorldEdge) => {
		if (!keepEdge(edge)) return false;
		if (edge.externalCount && hidden.has('outside-link')) return false;
		if (edge.unresolvedCount && hidden.has('dashed-link')) return false;
		return true;
	};
	const linkEdges = graph.linkEdges.filter(keepLinkEdge);
	const hoverLinkEdges = graph.hoverLinkEdges.filter(keepHoverLinkEdge);
	return { ...graph, nodes, nodesById: new Map(nodes.map((node) => [node.id, node])), hierarchyEdges, linkEdges, hoverLinkEdges };
}
