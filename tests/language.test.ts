import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Setting, SettingDefinitionRender, SettingGroup, WorkspaceLeaf } from 'obsidian';
import { Events, TFile, TFolder } from './helpers/obsidian';
import { mergeSettings, type Language } from '../src/settings';
import type { RadialLayout } from '../src/layout/radial/layoutRadial';
import type { VisibleWorldGraph } from '../src/world/types';
import type { WorldMapIndex } from '../src/world/WorldMapIndex';
import { t } from '../src/i18n';

const menu = vi.hoisted(() => ({ actions: new Map<string, () => void>() }));
vi.mock('obsidian', async () => ({
	...await import('./helpers/obsidian'),
	Plugin: class {},
	PluginSettingTab: class { update() {} },
	Setting: class {},
	Menu: class {
		addItem(build: (item: unknown) => void) {
			let title = '';
			build({ setTitle(value: string) { title = value; }, setIcon() {}, onClick(action: () => void) { menu.actions.set(title, action); } });
		}
		showAtPosition() {}
	},
}));
vi.mock('../src/layout/WorkerForceLayout', () => ({ WorkerForceLayout: class { isSettled() { return true; } dispose() {} } }));

import MiniWorldMapPlugin from '../src/main';
import { MiniWorldMapView } from '../src/view/GalaxyView';
import { Radial2DController } from '../src/view/Radial2DController';
import { GraphController } from '../src/view/GraphController';

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', { setTimeout, clearTimeout, cancelAnimationFrame: vi.fn() });
	menu.actions.clear();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture() {
	const files = [new TFile('One.md'), new TFile('A/Two.md')];
	for (const file of files) Object.assign(file.stat, { mtime: new Date('2026-08-15T12:00:00Z').getTime() });
	const vault = Object.assign(new Events(), {
		getRoot: vi.fn(() => new TFolder('', [files[0]!, new TFolder('A', [files[1]!])])),
		getMarkdownFiles: vi.fn(() => files),
		getAbstractFileByPath: (path: string) => files.find((file) => file.path === path),
		getName: () => 'test', configDir: '.obsidian',
	});
	const leaves: { view: MiniWorldMapView }[] = [];
	const app = {
		vault, metadataCache: Object.assign(new Events(), { resolvedLinks: { 'One.md': { 'A/Two.md': 2 } }, unresolvedLinks: {} }),
		workspace: { getLeavesOfType: () => leaves },
	} as unknown as App;
	const settings = mergeSettings(null);
	const plugin = Object.assign(Object.create(MiniWorldMapPlugin.prototype), { app, settings, saveSettings: vi.fn(async () => {}) }) as MiniWorldMapPlugin;
	const addView = (controller: Radial2DController | GraphController) => {
		const view = new MiniWorldMapView({ app } as unknown as WorkspaceLeaf, plugin);
		view.controller = controller;
		leaves.push({ view });
		return view;
	};
	return { app, vault, settings, plugin, addView };
}

describe('language changes', () => {
	it('refreshes all open panels through the language menu without rebuilding either map', async () => {
		const { app, vault, settings, plugin, addView } = fixture();
		const content = { empty() {}, removeClass() {} } as unknown as HTMLElement;
		const radial = new Radial2DController(app, content, settings, () => {}, () => {}, (language) => plugin.setLanguage(language));
		radial.load();
		const internals = radial as unknown as {
			index: WorldMapIndex; graph: VisibleWorldGraph; layout: RadialLayout; state: unknown;
			queueRebuild(reason: string): Promise<void>; renderPanel(): void; openLanguageMenu(anchor: HTMLElement): void;
		};
		await internals.queueRebuild('legend');
		const render2d = vi.spyOn(internals, 'renderPanel').mockImplementation(() => { body.scrollTop = 0; });
		const body = { scrollTop: 90 };
		const pins = [{ id: 'pin-1', nodeId: 'One.md' }];
		const setData = vi.fn();
		const renderer = { setData, dispose() {}, view: { centerX: 123, centerY: 456, zoom: 0.25 } };
		const button2d = { setAttr: vi.fn() };
		Object.assign(radial, { panelBody: body, renderer, pinnedPaths: pins, selectedNodeId: 'One.md', activePanelPage: 'pins', languageButton: button2d });
		const snapshot = { graph: internals.graph, layout: internals.layout, model: internals.index.model, state: structuredClone(internals.state) };
		const compute = vi.spyOn(internals.index.computation, 'layout');

		const three = new GraphController(app, content, settings.galaxy3d, () => {}, null, 'en', (language) => plugin.setLanguage(language));
		three.store.rebuild(false);
		const selected = three.store.data.nodes.findIndex((node) => node.id === 'One.md');
		const panel = { setLanguage: vi.fn(), statsEl: { setText: vi.fn() }, dispose() {} };
		const button3d = { setAttr: vi.fn() };
		Object.assign(three, { selected, panel, languageButton: button3d });
		const data = three.store.data, positions = three.store.positions;
		const rebuild3d = vi.spyOn(three.store, 'rebuild');
		const view2d = addView(radial), view3d = addView(three);
		const switch2d = vi.spyOn(view2d, 'switchMode'), switch3d = vi.spyOn(view3d, 'switchMode');
		vault.getRoot.mockClear(); vault.getMarkdownFiles.mockClear();

		internals.openLanguageMenu({ getBoundingClientRect: () => ({ right: 0, bottom: 0 }) } as HTMLElement);
		menu.actions.get('中文')!();
		expect(settings.language).toBe('zh');
		expect(render2d).toHaveBeenCalledOnce();
		expect(panel.setLanguage).toHaveBeenCalledWith('zh', expect.objectContaining({
			title: 'One', folder: t('zh', '3d.card.root'), type: t('zh', '3d.inspect.note'),
			modified: new Date('2026-08-15T12:00:00Z').toLocaleDateString('zh-CN'),
		}));
		expect(button2d.setAttr).toHaveBeenCalledWith('title', t('zh', 'language'));
		expect(button3d.setAttr).toHaveBeenCalledWith('aria-label', t('zh', 'language'));
		expect(panel.statsEl.setText).toHaveBeenCalledWith(expect.stringContaining(t('zh', 'state.settled')));
		expect(body.scrollTop).toBe(90);
		expect(internals.graph).toBe(snapshot.graph); expect(internals.layout).toBe(snapshot.layout);
		expect(internals.index.model).toBe(snapshot.model); expect(internals.state).toEqual(snapshot.state);
		expect(radial).toMatchObject({ selectedNodeId: 'One.md', activePanelPage: 'pins', pinnedPaths: pins, renderer });
		expect(three.store.data).toBe(data); expect(three.store.positions).toBe(positions);
		expect(three).toMatchObject({ selected });
		for (const action of [vault.getRoot, vault.getMarkdownFiles, compute, setData, rebuild3d, switch2d, switch3d]) expect(action).not.toHaveBeenCalled();
		expect(view2d.controller).toBe(radial); expect(view3d.controller).toBe(three);
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		plugin.setLanguage('zh');
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(render2d).toHaveBeenCalledOnce();
		radial.dispose(); three.dispose();
	});

	it('updates the selected 3D detail and other views from the 3D language menu', () => {
		const { app, settings, plugin, addView } = fixture();
		const three = new GraphController(app, {} as HTMLElement, settings.galaxy3d, () => {}, null, 'en', (language) => plugin.setLanguage(language));
		const panel = { setLanguage: vi.fn(), dispose() {} };
		Object.assign(three, { panel });
		addView(three);
		const internals = three as unknown as { openLanguageMenu(anchor: HTMLElement): void };
		internals.openLanguageMenu({ getBoundingClientRect: () => ({ right: 0, bottom: 0 }) } as HTMLElement);
		menu.actions.get('中文')!();
		expect(settings.language).toBe('zh');
		expect(panel.setLanguage).toHaveBeenCalledExactlyOnceWith('zh', null);
		three.dispose();
	});

	it('routes language changes in plugin settings through the same UI-only entry point', async () => {
		const { plugin } = fixture();
		const tabs: { getSettingDefinitions(): { items: SettingDefinitionRender[] }[]; update(): void }[] = [];
		Object.assign(plugin, { loadData: async () => null, registerView() {}, addRibbonIcon() {}, addCommand() {}, addSettingTab: (tab: typeof tabs[number]) => tabs.push(tab) });
		await plugin.onload();
		const setLanguage = vi.spyOn(plugin, 'setLanguage');
		const update = vi.spyOn(tabs[0]!, 'update');
		let change!: (value: Language) => void;
		const dropdown = { addOption() { return dropdown; }, setValue() { return dropdown; }, onChange(handler: typeof change) { change = handler; return dropdown; } };
		tabs[0]!.getSettingDefinitions()[0]!.items[0]!.render(
			{ addDropdown: (build: (value: typeof dropdown) => void) => build(dropdown) } as unknown as Setting,
			{} as SettingGroup,
		);
		change('zh');
		expect(setLanguage).toHaveBeenCalledExactlyOnceWith('zh');
		expect(plugin.settings.language).toBe('zh');
		expect(update).toHaveBeenCalledOnce();
	});
});
