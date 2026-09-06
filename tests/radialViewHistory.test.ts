import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { Events, TFile, TFolder } from './helpers/obsidian';
import { mergeSettings } from '../src/settings';
import { defaultVisibleGraphState } from '../src/world/visibleGraph';
import type { VisibleGraphState, VisibleWorldGraph } from '../src/world/types';
import type { WorldMapIndex } from '../src/world/WorldMapIndex';
import type { RadialLayout } from '../src/layout/radial/layoutRadial';
import { Radial2DController } from '../src/view/Radial2DController';
import { RadialViewHistory, type RadialViewEntry } from '../src/view/RadialViewHistory';

function entry(rootPath: string): RadialViewEntry {
	return { state: { ...defaultVisibleGraphState(mergeSettings(null).radial), rootPath }, view: { centerX: 0, centerY: 0, zoom: 1 } };
}

describe('bounded map navigation history', () => {
	it('traverses both directions, keeps the forward branch on repeat visits, and replaces it on a new destination', () => {
		const history = new RadialViewHistory();
		expect(history.canGoBack || history.canGoForward).toBe(false);
		for (const root of ['A', 'B', 'C']) history.push(entry(root));
		history.go(-1);
		history.push({ ...entry('B'), view: { centerX: 50, centerY: 20, zoom: 0.1 } });
		expect(history.canGoForward).toBe(true);
		history.go(1);
		expect(history.current?.state.rootPath).toBe('C');
		history.go(-1);
		expect(history.current?.view.centerX).toBe(50);
		history.push(entry('D'));
		expect(history.canGoForward).toBe(false);
		history.go(1);
		expect(history.current?.state.rootPath).toBe('D');
		history.go(-1);
		history.go(-1);
		history.go(-1);
		expect(history.current?.state.rootPath).toBe('A');
	});

	it('retains only the latest 100 views', () => {
		const history = new RadialViewHistory();
		for (let i = 0; i < 150; i++) history.push(entry(String(i)));
		let steps = 0;
		while (history.canGoBack) { history.go(-1); steps++; }
		expect(steps).toBe(99);
		expect(history.current?.state.rootPath).toBe('50');
	});
});

interface ControllerInternals {
	state: VisibleGraphState;
	selectedNodeId: string | null;
	selectedLink: VisibleGraphState['selectedLink'];
	hoverNodeId: string | null;
	hoverLink: VisibleGraphState['selectedLink'];
	graph: VisibleWorldGraph;
	layout: RadialLayout;
	index: WorldMapIndex;
	history: RadialViewHistory;
	backButton: HTMLButtonElement;
	forwardButton: HTMLButtonElement;
	queueRebuild(reason: string): Promise<void>;
	navigateHistory(direction: -1 | 1): void;
	useAsRoot(id: string): void;
	focusNote(id: string): void;
	showCompleteMap(): void;
	openSearchNodeAsRoot(id: string): Promise<void>;
	buildFloatingControls(): void;
}

const controllers: Radial2DController[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', {
		setTimeout, clearTimeout, cancelAnimationFrame: clearTimeout,
		requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	});
});
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
	vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

async function fixture() {
	const settings = mergeSettings(null);
	const root = new TFolder('', [
		new TFolder('A', [new TFile('A/one.md')]),
		new TFolder('B', [new TFile('B/two.md')]),
		new TFolder('C', [new TFile('C/three.md')]),
	]);
	const vault = Object.assign(new Events(), { getRoot: () => root, getName: () => 'test' });
	const app = { vault, metadataCache: Object.assign(new Events(), { resolvedLinks: {}, unresolvedLinks: {} }) } as unknown as App;
	const controller = new Radial2DController(app, { empty() {}, removeClass() {} } as unknown as HTMLElement, settings, () => {}, () => {}, () => {});
	controllers.push(controller);
	controller.load();
	const view = { centerX: 0, centerY: 0, zoom: 1 };
	const renderer = {
		getView: () => ({ ...view }),
		setView: (centerX: number, centerY: number, zoom: number) => Object.assign(view, { centerX, centerY, zoom }),
		setData: vi.fn(), resize() {}, beginRenderBatch() {}, endRenderBatch() {},
		showLoadingMask() {}, playRevealFromRoot() {}, clearLoadingMask() {}, setActive: vi.fn(), dispose() {},
		nodePoint: (id: string) => internals.layout.positions.get(id),
		fitToLayout: () => { Object.assign(view, { centerX: 0, centerY: 0, zoom: 0.5 }); return true; },
	};
	Object.assign(controller, { renderer, canvasHost: { clientWidth: 1200, clientHeight: 800, removeClass() {} } });
	const internals = controller as unknown as ControllerInternals;
	const started = internals.queueRebuild('start');
	await vi.runAllTimersAsync();
	await started;
	const settle = () => vi.runAllTimersAsync();
	const navigate = async (root: string) => { internals.useAsRoot(root); await settle(); };
	const go = async (direction: -1 | 1) => { internals.navigateHistory(direction); await settle(); };
	return { controller, internals, view, renderer, navigate, go, settle, settings, root };
}

describe('2D history integration', () => {
	it.each([0.002, 0.2])('preserves visual spacing and records search framing at zoom %s', async (zoom) => {
		const { internals, view, settle } = await fixture();
		Object.assign(view, { zoom });
		const spacing = internals.layout.positions.get('')!.siblingSpacing!;
		const search = internals.openSearchNodeAsRoot('A'); await settle(); await search;
		const point = internals.layout.positions.get('A')!;
		expect(view).toEqual({ centerX: point.x, centerY: point.y, zoom: zoom * (spacing / point.siblingSpacing!) });
		expect(internals.history.current?.view).toEqual(view);
	});

	it('restores the viewport and limits with no old selection when navigating, going back or going forward', async () => {
		const { internals, renderer, view, navigate, go } = await fixture();
		const expectNoSelection = () => {
			expect(internals).toMatchObject({ selectedNodeId: null, selectedLink: null, hoverNodeId: null, hoverLink: null });
			expect(internals.state).toMatchObject({ selectedNodeId: null, selectedLink: null });
			expect(renderer.setActive).toHaveBeenLastCalledWith(
				expect.objectContaining({ activeNodeId: null, activeLinkId: null, dimOthers: false }),
				expect.any(String),
			);
		};
		const start = { centerX: 123, centerY: -456, zoom: 0.002 };
		Object.assign(view, start);
		internals.state.atlasDepth = 2;
		await internals.queueRebuild('depth');
		await internals.queueRebuild('metadata');
		expect(internals.history.canGoBack).toBe(false);
		// A folder is selected by the click that opens its map.
		internals.selectedNodeId = internals.state.selectedNodeId = internals.hoverNodeId = 'A';
		await navigate('A');
		expectNoSelection();
		const second = { centerX: 777, centerY: 888, zoom: 0.15 };
		Object.assign(view, second);
		internals.state.atlasDepth = 3;
		internals.selectedLink = internals.state.selectedLink = internals.hoverLink = internals.graph.hierarchyEdges[0]!;
		await go(-1);
		expectNoSelection();
		expect(internals.graph.rootId).toBe('');
		expect(internals.state.atlasDepth).toBe(2);
		expect(view).toEqual(start);
		expect(internals.history.canGoBack).toBe(false);
		await go(1);
		expectNoSelection();
		expect(internals.graph.rootId).toBe('A');
		expect(internals.state.atlasDepth).toBe(3);
		expect(view).toEqual(second);
		await go(-1);
		internals.selectedNodeId = internals.state.selectedNodeId = internals.hoverNodeId = 'B';
		await navigate('B');
		expectNoSelection();
		expect(internals.history.canGoForward).toBe(false);
		await go(-1);
		expect(internals.graph.rootId).toBe('');
	});

	it('restores normal, complete-root and focused-note views without changing saved defaults', async () => {
		const { internals, settings, navigate, go, settle } = await fixture();
		const defaults = structuredClone(settings.radial);
		await navigate('A');
		internals.showCompleteMap(); await settle();
		expect(internals.state.showCompleteRoot).toBe(true);
		internals.focusNote('B/two.md'); await settle();
		expect(internals.graph.focusId).toBe('B/two.md');
		await go(-1);
		expect(internals.graph.rootId).toBe('A');
		expect(internals.state.showCompleteRoot).toBe(true);
		await go(-1);
		expect(internals.state.showCompleteRoot).toBe(false);
		await go(1); await go(1);
		expect(internals.graph.focusId).toBe('B/two.md');
		expect(settings.radial).toEqual(defaults);
	});

	it('records only the completed destination when a slow layout is superseded', async () => {
		const { internals, navigate, go, settle } = await fixture();
		const original = internals.layout;
		let resolveLayout!: (layout: RadialLayout) => void;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		internals.useAsRoot('A'); await settle();
		await navigate('B');
		resolveLayout(original); await settle();
		expect(internals.graph.rootId).toBe('B');
		await go(-1);
		expect(internals.graph.rootId).toBe('');
		expect(internals.history.canGoBack).toBe(false);
	});

	it('keeps the history cursor and current map on failed navigation and allows retry', async () => {
		const { internals, navigate, go } = await fixture();
		await navigate('A');
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(internals.index.computation, 'layout').mockRejectedValueOnce(new Error('layout failed'));
		await go(-1);
		expect(internals.graph.rootId).toBe('A');
		expect(internals.state.rootPath).toBe('A');
		expect(internals.history.current?.state.rootPath).toBe('A');
		expect(error).toHaveBeenCalledOnce();
		await go(-1);
		expect(internals.graph.rootId).toBe('');
	});

	it('preserves a pending history camera when a metadata rebuild supersedes its layout', async () => {
		const { internals, view, navigate, settle } = await fixture();
		const saved = { centerX: 10, centerY: -90, zoom: 0.04 };
		Object.assign(view, saved);
		await navigate('A');
		let resolveLayout!: (layout: RadialLayout) => void;
		const old = internals.layout;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		internals.navigateHistory(-1); await settle();
		await internals.queueRebuild('metadata');
		resolveLayout(old); await settle();
		expect(internals.graph.rootId).toBe('');
		expect(view).toEqual(saved);
		expect(internals.history.canGoBack).toBe(false);
		expect(internals.history.canGoForward).toBe(true);
	});

	it('fits a new root when a metadata rebuild supersedes its pending navigation', async () => {
		const { internals, view, renderer, settle, go } = await fixture();
		const previousView = { centerX: 12345, centerY: -67890, zoom: 0.003 };
		Object.assign(view, previousView);
		const old = internals.layout;
		let resolveLayout!: (layout: RadialLayout) => void;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		const fit = vi.spyOn(renderer, 'fitToLayout');
		internals.useAsRoot('A'); await settle();
		await internals.queueRebuild('metadata');
		expect(internals.graph.rootId).toBe('A');
		expect(fit).toHaveBeenCalledWith('A');
		expect(view.zoom).toBe(0.5);
		resolveLayout(old); await settle();
		await go(-1);
		expect(view).toEqual(previousView);
	});

	it('does not clear the current loading mask when a superseded layout fails', async () => {
		const { internals, renderer, settle } = await fixture();
		const old = internals.layout;
		let rejectLayout!: (error: Error) => void;
		let resolveLayout!: (layout: RadialLayout) => void;
		vi.spyOn(internals.index.computation, 'layout')
			.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLayout = reject; }))
			.mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		const clear = vi.spyOn(renderer, 'clearLoadingMask');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		internals.useAsRoot('A'); await settle();
		internals.useAsRoot('B'); await settle();
		rejectLayout(new Error('superseded layout failed')); await settle();
		expect(clear).not.toHaveBeenCalled();
		resolveLayout(old); await settle();
	});

	it('centers a searched root when metadata finishes its pending navigation', async () => {
		const { internals, view, settle, go } = await fixture();
		Object.assign(view, { centerX: 12345, centerY: -67890, zoom: 0.003 });
		const old = internals.layout;
		const previousSpacing = old.positions.get('')!.siblingSpacing!;
		let resolveLayout!: (layout: RadialLayout) => void;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		const search = internals.openSearchNodeAsRoot('A'); await settle();
		await internals.queueRebuild('metadata');
		const point = internals.layout.positions.get('A')!;
		expect(view).toEqual({ centerX: point.x, centerY: point.y, zoom: 0.003 * previousSpacing / point.siblingSpacing! });
		const destination = { ...view };
		resolveLayout(old); await search;
		expect(view).toEqual(destination);
		await go(-1); await go(1);
		expect(view).toEqual(destination);
	});

	it('records search navigation and prevents a superseded search from moving the newer camera', async () => {
		const { internals, view, navigate, go, settle } = await fixture();
		let resolveLayout!: (layout: RadialLayout) => void;
		const old = internals.layout;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		const search = internals.openSearchNodeAsRoot('A'); await settle();
		await navigate('B');
		const current = { ...view };
		resolveLayout(old); await search;
		expect(view).toEqual(current);
		await go(-1);
		expect(internals.graph.rootId).toBe('');
		const nextSearch = internals.openSearchNodeAsRoot('C'); await settle(); await nextSearch;
		const searchView = { ...view };
		await go(-1); await go(1);
		expect(internals.graph.rootId).toBe('C');
		expect(view).toEqual(searchView);
	});

	it('updates button availability and language without changing navigation state', async () => {
		const { controller, internals, navigate, go } = await fixture();
		const buttons: { disabled: boolean; setAttr: ReturnType<typeof vi.fn>; addEventListener: ReturnType<typeof vi.fn> }[] = [];
		Object.assign(controller, { canvasHost: { createDiv: () => ({ createEl: () => {
			const button = { disabled: false, setAttr: vi.fn(), addEventListener: vi.fn() };
			buttons.push(button); return button;
		} }), removeClass() {} } });
		internals.buildFloatingControls();
		expect(internals.backButton.disabled).toBe(true);
		expect(internals.forwardButton.disabled).toBe(true);
		await navigate('A');
		expect(internals.backButton.disabled).toBe(false);
		await go(-1);
		expect(internals.forwardButton.disabled).toBe(false);
		controller.setLanguage('zh');
		expect(buttons[0]!.setAttr).toHaveBeenCalledWith('aria-label', '后退到上一个地图视图');
		expect(buttons[1]!.setAttr).toHaveBeenCalledWith('title', '前进到下一个地图视图');
	});
});
