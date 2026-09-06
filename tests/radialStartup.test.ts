import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { Events, TFile, TFolder } from './helpers/obsidian';
import { mergeSettings } from '../src/settings';
import type { RadialLayout } from '../src/layout/radial/layoutRadial';
import type { WorldMapIndex } from '../src/world/WorldMapIndex';
import { Radial2DController } from '../src/view/Radial2DController';

vi.mock('../src/render/RadialRenderer', async (importOriginal) => ({
	...await importOriginal<typeof import('../src/render/RadialRenderer')>(),
	RadialRenderer: class {
		setLinkPickingEnabled() {} showLoadingMask() {} clearLoadingMask() {}
		setData() {} setActive() {} resize() {} dispose() {}
		beginRenderBatch() {} endRenderBatch() {} playRevealFromRoot() {}
		getView() { return { centerX: 0, centerY: 0, zoom: 1 }; }
		setView() {} fitToLayout() { return true; }
	},
}));

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

function fixture() {
	const settings = mergeSettings(null);
	settings.radial.includeUnresolvedLinks = true;
	const root = new TFolder('', [new TFolder('A', [new TFile('A/one.md')]), new TFile('two.md')]);
	const metadataCache = Object.assign(new Events(), { resolvedLinks: { 'A/one.md': {} }, unresolvedLinks: {} });
	const app = {
		metadataCache,
		vault: Object.assign(new Events(), { getRoot: () => root, getName: () => 'test' }),
	} as unknown as App;
	const host = { clientWidth: 1200, clientHeight: 800 };
	const content = { empty() {}, addClass() {}, removeClass() {}, createDiv: () => host } as unknown as HTMLElement;
	const controller = new Radial2DController(app, content, settings, () => {}, () => {}, () => {});
	controllers.push(controller);
	controller.load();
	const internals = controller as unknown as { index: WorldMapIndex; renderPanel(): void };
	const stats = { setText: vi.fn(), setAttr: vi.fn() };
	const panel = { empty() {}, createDiv: () => panel, createEl: () => panel, addEventListener() {} };
	Object.assign(controller, {
		buildPanel() { Object.assign(controller, { statsEl: stats, panelBody: panel }); internals.renderPanel(); },
		buildFloatingControls() {}, bindRendererEvents() {}, renderViewPage() {},
	});
	const resolveLinks = () => {
		app.metadataCache.resolvedLinks['A/one.md'] = { 'two.md': 2 };
		app.metadataCache.unresolvedLinks['A/one.md'] = { missing: 1 };
		metadataCache.emit('resolved');
	};
	return { controller, internals, stats, metadataCache, resolveLinks };
}

describe('first 2D map counts', () => {
	it('shows a loading state until the first graph is available', async () => {
		const { controller, stats } = fixture();
		const started = controller.start();
		expect(stats.setText).not.toHaveBeenCalledWith(expect.stringContaining('0 nodes / 0 links'));
		await vi.runAllTimersAsync(); await started;
		expect(stats.setText).toHaveBeenLastCalledWith('Current rendering: 4 nodes / 0 links');
	});

	it('updates the map and panel when metadata resolves during the first layout', async () => {
		const { controller, internals, stats, resolveLinks } = fixture();
		const computeLayout = internals.index.computation.layout.bind(internals.index.computation);
		let finishLayout!: () => void;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(async (graph, options) => {
			const layout = await computeLayout(graph, options);
			return new Promise<RadialLayout | null>((resolve) => { finishLayout = () => resolve(layout); });
		});
		const started = controller.start();
		await vi.advanceTimersByTimeAsync(10);
		resolveLinks();
		finishLayout(); await started;
		await vi.runAllTimersAsync();
		expect(controller.counts).toEqual({ nodes: 5, links: 2 });
		expect(stats.setText).toHaveBeenLastCalledWith('Current rendering: 5 nodes / 2 links');
	});

	it('does not repeat a layout for metadata already consumed before computation', async () => {
		const { controller, internals, resolveLinks } = fixture();
		const layout = vi.spyOn(internals.index.computation, 'layout');
		const started = controller.start();
		resolveLinks();
		await vi.runAllTimersAsync(); await started;
		expect(controller.counts).toEqual({ nodes: 5, links: 2 });
		expect(layout).toHaveBeenCalledOnce();
	});
});
