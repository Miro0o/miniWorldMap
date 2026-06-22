import { Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { VIEW_TYPE_MINI_WORLD_MAP } from './constants';
import type { Language, MiniWorldMapSettings, ViewMode } from './settings';
import {
	DEFAULT_RADIAL_SETTINGS,
	HOVER_HIGHLIGHT_MODE_OPTIONS,
	HOVER_TARGET_MODE_OPTIONS,
	LABEL_VISIBILITY_OPTIONS,
	MAX_ATLAS_DEPTH,
	MAX_LINK_LIMIT,
	MAX_RENDER_NODE_LIMIT,
	MAX_SWIRL_STRENGTH,
	clampNumber,
	mergeSettings,
	normalizeHoverHighlightMode,
	normalizeHoverTargetMode,
	normalizeLabelVisibility,
	normalizeLanguage,
	normalizeViewMode,
} from './settings';
import { hoverModeOptions, hoverTargetOptions, labelVisibilityOptions, languageOptions, t, viewModeLabel } from './i18n';
import { MiniWorldMapView } from './view/GalaxyView';
import { Map3DController } from './view/Map3DController';

export default class MiniWorldMapPlugin extends Plugin {
	settings: MiniWorldMapSettings = mergeSettings(null);

	async onload(): Promise<void> {
		console.info('[Mini World Map] loading');
		this.settings = mergeSettings(await this.loadData());
		this.registerView(VIEW_TYPE_MINI_WORLD_MAP, (leaf) => new MiniWorldMapView(leaf, this));

		this.addRibbonIcon('network', 'Open Mini World Map', () => {
			void this.activateView();
		});

		this.addCommand({
			id: 'open-map',
			name: 'Open Mini World Map',
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: 'toggle-render-mode',
			name: 'Toggle Mini World Map render mode',
			callback: () => {
				this.setViewMode(this.settings.viewMode === 'radial2d' ? 'map3d' : 'radial2d');
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'rebuild-index',
			name: 'Rebuild Mini World Map index',
			callback: () => {
				let rebuilt = false;
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
					const view = leaf.view;
					if (view instanceof MiniWorldMapView && 'rebuild' in (view.controller ?? {})) {
						(view.controller as { rebuild?: (reason: string) => void }).rebuild?.('manual');
						rebuilt = true;
					}
				}
				new Notice(t(this.settings.language, rebuilt ? 'notice.rebuilt' : 'notice.openToBuild'));
			},
		});

		this.addCommand({
			id: 'search-3d',
			name: 'Search 3D map node and fly',
			callback: () => {
				void this.activateView().then((view) => {
					if (view?.controller instanceof Map3DController) view.controller.openSearch();
					else new Notice(t(this.settings.language, 'notice.switchTo3d'));
				});
			},
		});

		this.addSettingTab(new MiniWorldMapSettingTab(this.app, this));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	setViewMode(mode: ViewMode): void {
		this.settings.viewMode = normalizeViewMode(mode);
		void this.saveSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
			const view = leaf.view;
			if (view instanceof MiniWorldMapView) view.switchMode(this.settings.viewMode);
		}
	}

	setLanguage(language: Language): void {
		this.settings.language = normalizeLanguage(language);
		void this.saveSettings();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)) {
			const view = leaf.view;
			if (view instanceof MiniWorldMapView) view.switchMode(this.settings.viewMode);
		}
	}

	async activateView(): Promise<MiniWorldMapView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_MINI_WORLD_MAP)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf(true);
			await leaf.setViewState({ type: VIEW_TYPE_MINI_WORLD_MAP, active: true });
		}
		if (leaf.isDeferred) await leaf.loadIfDeferred();
		await workspace.revealLeaf(leaf);
		return leaf.view instanceof MiniWorldMapView ? leaf.view : null;
	}
}

class MiniWorldMapSettingTab extends PluginSettingTab {
	constructor(
		app: import('obsidian').App,
		private plugin: MiniWorldMapPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const radial = this.plugin.settings.radial;
		const language = this.plugin.settings.language;
		containerEl.empty();
		containerEl.createEl('h2', { text: t(language, 'settings.title') });

		new Setting(containerEl)
			.setName(t(language, 'language'))
			.setDesc(t(language, 'settings.languageDesc'))
			.addDropdown((dropdown) => {
				for (const [value, label] of languageOptions(language)) dropdown.addOption(value, label);
				dropdown.setValue(this.plugin.settings.language).onChange(async (value) => {
					this.plugin.settings.language = normalizeLanguage(value);
					await this.plugin.saveSettings();
					this.display();
				});
			});

		new Setting(containerEl)
			.setName(t(language, 'settings.defaultMode'))
			.setDesc(t(language, 'settings.defaultModeDesc'))
			.addDropdown((dropdown) =>
				dropdown
					.addOption('radial2d', viewModeLabel(language, 'radial2d'))
					.addOption('map3d', viewModeLabel(language, 'map3d'))
					.setValue(this.plugin.settings.viewMode)
					.onChange(async (value) => {
						this.plugin.settings.viewMode = normalizeViewMode(value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.defaultDepth'))
			.setDesc(t(language, 'settings.depthDesc'))
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(radial.atlasDepth)
					.setDynamicTooltip()
					.onChange(async (value) => {
						radial.atlasDepth = clampNumber(value, 1, MAX_ATLAS_DEPTH, DEFAULT_RADIAL_SETTINGS.atlasDepth);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.defaultNodes'))
			.setDesc(t(language, 'settings.nodeLimitDesc'))
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_RADIAL_SETTINGS.renderNodeLimit))
					.setValue(String(radial.renderNodeLimit))
					.onChange(async (value) => {
						radial.renderNodeLimit = clampNumber(value, 200, MAX_RENDER_NODE_LIMIT, DEFAULT_RADIAL_SETTINGS.renderNodeLimit);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.defaultNoteLinks'))
			.setDesc(t(language, 'settings.linkLimitDesc'))
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_RADIAL_SETTINGS.linkLimit))
					.setValue(String(radial.linkLimit))
					.onChange(async (value) => {
						radial.linkLimit = clampNumber(value, 0, MAX_LINK_LIMIT, DEFAULT_RADIAL_SETTINGS.linkLimit);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.showNoteLinks'))
			.setDesc(t(language, 'settings.showLinksDesc'))
			.addToggle((toggle) =>
				toggle.setValue(radial.showLinkOverlay && !radial.hiddenLegendItems.includes('link')).onChange(async (value) => {
					radial.showLinkOverlay = value;
					const hidden = new Set(radial.hiddenLegendItems);
					if (value) hidden.delete('link');
					else hidden.add('link');
					radial.hiddenLegendItems = [...hidden];
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.hover'))
			.setDesc(t(language, 'settings.hoverDesc'))
			.addDropdown((dropdown) => {
				for (const [value, label] of hoverModeOptions(language, HOVER_HIGHLIGHT_MODE_OPTIONS)) dropdown.addOption(value, label);
				dropdown.setValue(radial.hoverHighlightMode).onChange(async (value) => {
					radial.hoverHighlightMode = normalizeHoverHighlightMode(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t(language, 'control.hoverTargets'))
			.setDesc(t(language, 'settings.hoverTargetsDesc'))
			.addDropdown((dropdown) => {
				for (const [value, label] of hoverTargetOptions(language, HOVER_TARGET_MODE_OPTIONS)) dropdown.addOption(value, label);
				dropdown.setValue(radial.hoverTargetMode).onChange(async (value) => {
					radial.hoverTargetMode = normalizeHoverTargetMode(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t(language, 'control.labels'))
			.setDesc(t(language, 'settings.labelsDesc'))
			.addDropdown((dropdown) => {
				for (const [value, label] of labelVisibilityOptions(language, LABEL_VISIBILITY_OPTIONS)) dropdown.addOption(value, label);
				dropdown.setValue(radial.labelVisibility).onChange(async (value) => {
					radial.labelVisibility = normalizeLabelVisibility(value);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t(language, 'control.spin'))
			.setDesc(t(language, 'settings.spinDesc'))
			.addSlider((slider) =>
				slider
					.setLimits(0, MAX_SWIRL_STRENGTH, 1)
					.setValue(radial.swirlStrength)
					.setDynamicTooltip()
					.onChange(async (value) => {
						radial.swirlStrength = clampNumber(value, 0, MAX_SWIRL_STRENGTH, DEFAULT_RADIAL_SETTINGS.swirlStrength);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.unresolvedLinks'))
			.setDesc(t(language, 'settings.unresolvedDesc'))
			.addToggle((toggle) =>
				toggle.setValue(radial.includeUnresolvedLinks).onChange(async (value) => {
					radial.includeUnresolvedLinks = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t(language, 'control.ignoredFolders'))
			.setDesc(t(language, 'settings.ignoredDesc'))
			.addTextArea((text) =>
				text.setValue(radial.ignoreFolders.join('\n')).onChange(async (value) => {
					radial.ignoreFolders = value
						.split('\n')
						.map((line) => line.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				}),
			);
	}
}
