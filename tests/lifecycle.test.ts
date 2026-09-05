import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import { Events, TFile, TFolder } from './helpers/obsidian';
import { mergeSettings } from '../src/settings';

vi.mock('obsidian', () => import('./helpers/obsidian'));
vi.mock('../src/layout/WorkerForceLayout', () => ({ WorkerForceLayout: class { dispose() {} } }));

import { GraphStore } from '../src/data/GraphStore';
import { GraphController } from '../src/view/GraphController';
import { MiniWorldMapView } from '../src/view/GalaxyView';
import { Radial2DController } from '../src/view/Radial2DController';
import { WorldMapIndex } from '../src/world/WorldMapIndex';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { vaultEntries } from '../src/world/vaultSnapshot';
import type { RadialLayout } from '../src/layout/radial/layoutRadial';

function fixture() {
	const root = new TFolder('', [new TFolder('A', [new TFile('A/one.md')])]);
	const metadataCache = Object.assign(new Events(), { resolvedLinks: { 'A/one.md': {} }, unresolvedLinks: {} });
	const vault = Object.assign(new Events(), {
		getMarkdownFiles: vi.fn(() => [new TFile('A/one.md')]),
		getRoot: vi.fn(() => root),
		getName: () => 'test',
	});
	const app = { metadataCache, vault } as unknown as App;
	return { app, metadataCache, vault, root, settings: mergeSettings(null) };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', { setTimeout, clearTimeout, cancelAnimationFrame: vi.fn() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('map lifecycle', () => {
	it('starts 3D without a resolved event, then accepts later metadata normally', async () => {
		const { app, metadataCache, vault } = fixture();
		metadataCache.resolvedLinks = {} as typeof metadataCache.resolvedLinks;
		const store = new GraphStore(app);
		store.load();
		store.init(false, true, () => {});
		const ready = vi.fn();
		const waiting = store.ensureCacheReady().then(ready);
		await vi.advanceTimersByTimeAsync(1599);
		expect(ready).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(ready).toHaveBeenCalledOnce();
		expect(metadataCache.listenerCount).toBe(1);
		metadataCache.emit('resolved');
		await vi.advanceTimersByTimeAsync(800);
		expect(vault.getMarkdownFiles).toHaveBeenCalledOnce();
		store.unload();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('finishes metadata waits immediately on resolved and removes the timeout', async () => {
		const { app, metadataCache } = fixture();
		metadataCache.resolvedLinks = {} as typeof metadataCache.resolvedLinks;
		const store = new GraphStore(app);
		store.load();
		const waiting = store.ensureCacheReady();
		metadataCache.emit('resolved');
		await waiting;
		expect(metadataCache.listenerCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		store.unload();
	});

	it('unloads 3D listeners and cancels a pending vault rebuild', () => {
		const { app, metadataCache, vault, settings } = fixture();
		const controller = new GraphController(app, {} as HTMLElement, settings.galaxy3d, () => {});
		controller.store.load();
		controller.store.init(false, true, () => {});
		metadataCache.emit('resolved');
		controller.dispose();
		vi.advanceTimersByTime(1000);
		expect(metadataCache.listenerCount + vault.listenerCount).toBe(0);
		expect(vault.getMarkdownFiles).not.toHaveBeenCalled();
		controller.dispose();
	});

	it('releases a pending metadata wait on unload', async () => {
		const { app, metadataCache } = fixture();
		metadataCache.resolvedLinks = {} as typeof metadataCache.resolvedLinks;
		const store = new GraphStore(app);
		store.load();
		const ready = store.ensureCacheReady();
		store.unload();
		await ready;
		expect(metadataCache.listenerCount).toBe(0);
	});

	it('prevents async 3D startup from creating a canvas after disposal', async () => {
		const { app, metadataCache, vault, settings } = fixture();
		metadataCache.resolvedLinks = {} as typeof metadataCache.resolvedLinks;
		const createDiv = vi.fn();
		const controller = new GraphController(app, { createDiv } as unknown as HTMLElement, settings.galaxy3d, () => {});
		vi.spyOn(controller, 'applyPreset').mockImplementation(() => {});
		controller.store.load();
		const started = controller.start();
		controller.dispose();
		await started;
		expect(createDiv).not.toHaveBeenCalled();
		expect(vault.getMarkdownFiles).not.toHaveBeenCalled();
		expect(metadataCache.listenerCount).toBe(0);
	});

	it('removes controller children from the view when closing', async () => {
		const { app, settings } = fixture();
		const host = { settings, saveSettings: async () => {}, setViewMode() {}, setLanguage() {} };
		const view = new MiniWorldMapView({ app } as unknown as WorkspaceLeaf, host);
		view.load();
		const controller = new GraphController(app, {} as HTMLElement, settings.galaxy3d, () => {});
		view.controller = controller;
		view.addChild(controller.store);
		const remove = vi.spyOn(view, 'removeChild');
		await view.onClose();
		expect(remove).toHaveBeenCalledWith(controller.store);
		expect(view.controller).toBeNull();
	});

	it('cancels 2D debounced rebuilds and flushes pending settings on close', () => {
		const { app, settings, vault } = fixture();
		const save = vi.fn();
		const controller = new Radial2DController(app, { empty() {}, removeClass() {} } as unknown as HTMLElement, settings, save, () => {}, () => {});
		controller.load();
		const internals = controller as unknown as { registerVaultEvents(): void; saveSoon(): void };
		internals.registerVaultEvents();
		internals.saveSoon();
		vault.emit('create');
		controller.dispose();
		vi.advanceTimersByTime(2000);
		expect(vault.getRoot).not.toHaveBeenCalled();
		expect(vault.listenerCount).toBe(0);
		expect(save).toHaveBeenCalledOnce();
	});
});

describe('vault index invalidation', () => {
	it('reuses the model and file snapshot for content edits without link changes', async () => {
		const { app, settings, vault } = fixture();
		const index = new WorldMapIndex(app, settings.radial);
		const build = vi.spyOn(index.computation, 'buildModel');
		await index.ensureReady();
		const model = index.model;
		for (let i = 0; i < 3; i++) {
			index.invalidate('links');
			await index.ensureReady();
			expect(index.model).toBe(model);
		}
		expect(build).toHaveBeenCalledOnce();
		expect(vault.getRoot).toHaveBeenCalledOnce();
		index.dispose();
	});

	it('matches a fresh index after in-place link changes, key reordering, settings and file deletion', async () => {
		const { app, settings, root } = fixture();
		root.children.push(new TFile('two.md'), new TFile('three.md'));
		settings.radial.includeUnresolvedLinks = true;
		app.metadataCache.resolvedLinks = { 'A/one.md': { 'two.md': 1, 'three.md': 2 } };
		const index = new WorldMapIndex(app, settings.radial);
		const verify = async () => {
			await index.ensureReady();
			expect(index.model).toEqual(buildWorldMap([...vaultEntries(app.vault)], app.metadataCache.resolvedLinks, app.metadataCache.unresolvedLinks, settings.radial, 'test'));
		};
		await verify();
		app.metadataCache.resolvedLinks['A/one.md']!['two.md'] = 5;
		app.metadataCache.unresolvedLinks['A/one.md'] = { missing: 2 };
		index.invalidate('links');
		await verify();
		delete app.metadataCache.resolvedLinks['A/one.md']!['two.md'];
		app.metadataCache.resolvedLinks['A/one.md']!['two.md'] = 5;
		index.invalidate('links');
		await verify();
		settings.radial.ignoreFolders.push('A');
		await verify();
		settings.radial.ignoreFolders = [];
		root.children.pop();
		index.invalidate();
		await verify();
		index.dispose();
	});

	it('discards a snapshot invalidated while its worker result is pending', async () => {
		const { app, settings, root } = fixture();
		const index = new WorldMapIndex(app, settings.radial);
		let resolveBuild!: (model: ReturnType<typeof buildWorldMap>) => void;
		const stale = buildWorldMap([...vaultEntries(app.vault)], {}, {}, settings.radial);
		const build = vi.spyOn(index.computation, 'buildModel').mockImplementationOnce(() => new Promise((resolve) => { resolveBuild = resolve; }));
		const ready = index.ensureReady();
		await vi.advanceTimersByTimeAsync(0);
		root.children.push(new TFile('new.md'));
		index.invalidate();
		resolveBuild(stale);
		await ready;
		expect(index.nodes.has('new.md')).toBe(true);
		expect(index.model).not.toBe(stale);
		expect(build).toHaveBeenCalledTimes(2);
		index.dispose();
	});

	it('ignores older layouts when settings change during computation', async () => {
		const { app, settings } = fixture();
		const controller = new Radial2DController(app, { empty() {}, removeClass() {} } as unknown as HTMLElement, settings, () => {}, () => {}, () => {});
		controller.load();
		const internals = controller as unknown as { index: WorldMapIndex; layout: RadialLayout; queueRebuild(reason: string): Promise<void> };
		await internals.queueRebuild('legend');
		const old = internals.layout;
		let resolveLayout!: (layout: RadialLayout) => void;
		vi.spyOn(internals.index.computation, 'layout').mockImplementationOnce(() => new Promise((resolve) => { resolveLayout = resolve; }));
		settings.radial.swirlStrength = 50;
		const stale = internals.queueRebuild('legend');
		await vi.advanceTimersByTimeAsync(0);
		settings.radial.swirlStrength = 100;
		await internals.queueRebuild('legend');
		const newest = internals.layout;
		expect(newest).not.toBe(old);
		resolveLayout(old);
		await stale;
		expect(internals.layout).toBe(newest);
		controller.dispose();
	});

	it('reuses layout for legend changes and refreshes it after a vault edit', async () => {
		const { app, settings, vault, root } = fixture();
		const controller = new Radial2DController(app, { empty() {}, removeClass() {} } as unknown as HTMLElement, settings, () => {}, () => {}, () => {});
		controller.load();
		const internals = controller as unknown as { registerVaultEvents(): void; queueRebuild(reason: string): Promise<void>; layout: unknown; graph: { nodesById: Map<string, unknown> } };
		internals.registerVaultEvents();
		await internals.queueRebuild('legend');
		const originalLayout = internals.layout;
		for (const hidden of [['link'], ['tree'], []]) {
			settings.radial.hiddenLegendItems = hidden;
			await internals.queueRebuild('legend');
			expect(internals.layout).toBe(originalLayout);
		}
		expect(vault.getRoot).toHaveBeenCalledOnce();
		const note = new TFile('new.md');
		root.children.push(note);
		vault.emit('create', note);
		await vi.advanceTimersByTimeAsync(700);
		expect(internals.graph.nodesById.has('new.md')).toBe(true);
		expect(internals.layout).not.toBe(originalLayout);
		controller.dispose();
	});

	it('reuses metadata for display changes and rebuilds when explicitly invalidated', async () => {
		const { app, vault, root, settings } = fixture();
		const index = new WorldMapIndex(app, settings.radial);
		await index.ensureReady();
		const original = index.model;
		settings.radial.hiddenLegendItems = ['link'];
		settings.radial.swirlStrength = 40;
		await index.ensureReady();
		expect(index.model).toBe(original);
		expect(vault.getRoot).toHaveBeenCalledOnce();
		root.children.push(new TFile('new.md'));
		index.invalidate();
		await index.ensureReady();
		expect(index.nodes.has('new.md')).toBe(true);
		expect(vault.getRoot).toHaveBeenCalledTimes(2);
	});

	it('detects index settings mutated in place', async () => {
		const { app, settings, vault } = fixture();
		const index = new WorldMapIndex(app, settings.radial);
		await index.ensureReady();
		settings.radial.ignoreFolders.push('A');
		await index.ensureReady();
		expect(index.nodes.has('A/one.md')).toBe(false);
		settings.radial.includeUnresolvedLinks = !settings.radial.includeUnresolvedLinks;
		await index.ensureReady();
		expect(vault.getRoot).toHaveBeenCalledOnce();
	});
});
