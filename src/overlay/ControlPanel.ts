import type { GalaxySettings, Language, SizeBy, ViewMode, VisualPreset } from '../settings';
import { DEFAULT_GALAXY_SETTINGS } from '../settings';
import type { StylePreset } from '../render/stylePresets';
import { STYLE_PRESETS } from '../render/stylePresets';
import type { ColorTheme } from '../render/colorThemes';
import { COLOR_THEMES } from '../render/colorThemes';
import type { VisualTokens } from '../render/presets';
import { t, viewModeLabel } from '../i18n';
import { Slider } from './Slider';

type PanelPage = 'view' | 'appearance' | 'physics' | 'motion' | 'advanced';

export interface ControlPanelCallbacks {
	onViewMode?: (mode: ViewMode) => void;
	onBloom: () => void;
	onPhysics: () => void;
	onLook: () => void;
	onCruise: (on: boolean) => void;
	onCruiseSpeed: () => void;
	onPreset: () => void;
	onStylePreset: (p: StylePreset) => void;
	onShowUnresolved: (on: boolean) => void;
	onImportColors: () => void;
	onShuffleColors: () => void;
	onColorTheme: (t: ColorTheme) => void;
	onRecenter: () => void;
	onReveal: () => void;
	onShowOrphans: (on: boolean) => void;
	onSizeBy: () => void;
	onQuality: () => void;
	onSearch: () => void;
	onReset: () => void;
	runScenario: (s: 'S1' | 'S2' | 'S3') => void;
}

export class ControlPanel {
	readonly statsEl: HTMLElement;
	private root: HTMLElement;
	private body: HTMLElement;
	private page: PanelPage = 'view';
	private sliders: Slider[] = [];
	private cruiseBtn: HTMLButtonElement | null = null;
	private presetSelect: HTMLSelectElement | null = null;
	private unresolvedBtn: HTMLButtonElement | null = null;
	private orphanBtn: HTMLButtonElement | null = null;
	private sizeBySelect: HTMLSelectElement | null = null;
	private qualityBtn: HTMLButtonElement | null = null;
	private styleChips: HTMLButtonElement[] = [];

	constructor(
		parent: HTMLElement,
		private settings: GalaxySettings,
		private language: Language,
		private cb: ControlPanelCallbacks,
		private viewMode: ViewMode = 'map3d',
	) {
		this.root = parent.createDiv({ cls: 'galaxy-panel gx-theme-space mwm-map-panel' });
		const header = this.root.createDiv({ cls: 'galaxy-panel-header' });
		this.statsEl = header.createDiv({ cls: 'galaxy-panel-stats', text: '…' });
		const collapseBtn = header.createEl('button', { cls: 'galaxy-panel-collapse', text: '-' });
		this.body = this.root.createDiv({ cls: 'galaxy-panel-body' });
		collapseBtn.addEventListener('click', () => {
			const hidden = this.body.hasClass('is-hidden');
			this.body.toggleClass('is-hidden', !hidden);
			collapseBtn.setText(hidden ? '-' : '+');
		});
		this.render();
	}

	private render(): void {
		this.body.empty();
		this.sliders = [];
		this.styleChips = [];
		this.cruiseBtn = null;
		this.presetSelect = null;
		this.unresolvedBtn = null;
		this.orphanBtn = null;
		this.sizeBySelect = null;
		this.qualityBtn = null;

		const modeSwitch = this.body.createDiv({ cls: 'mwm-mode-switch' });
		modeSwitch.createDiv({ cls: 'mwm-mode-switch-label', text: this.tt('view.mode') });
		const modeRow = modeSwitch.createDiv({ cls: 'galaxy-mode-row mwm-mode-row' });
		this.modeButton(modeRow, 'radial2d');
		this.modeButton(modeRow, 'map3d');

		const settings = this.body.createDiv({ cls: 'mwm-panel-settings mwm-3d-settings' });
		const tabs = settings.createDiv({ cls: 'mwm-panel-tabs' });
		for (const [id, label] of [
			['view', this.tt('tab.view')],
			['appearance', this.tt('tab.appearance')],
			['physics', this.tt('tab.physics')],
			['motion', this.tt('tab.motion')],
			['advanced', this.tt('tab.advanced')],
		] as const) {
			const button = tabs.createEl('button', { cls: this.page === id ? 'is-active' : '', text: label });
			button.addEventListener('click', () => {
				this.page = id;
				this.render();
			});
		}

		const pageEl = settings.createDiv({ cls: 'mwm-panel-page' });
		if (this.page === 'appearance') this.renderAppearancePage(pageEl);
		else if (this.page === 'physics') this.renderPhysicsPage(pageEl);
		else if (this.page === 'motion') this.renderMotionPage(pageEl);
		else if (this.page === 'advanced') this.renderAdvancedPage(pageEl);
		else this.renderViewPage(pageEl);
	}

	private renderViewPage(parent: HTMLElement): void {
		const row = parent.createDiv({ cls: 'galaxy-panel-row' });
		const searchBtn = row.createEl('button', { text: this.tt('common.search') });
		searchBtn.addEventListener('click', this.cb.onSearch);
		const recenterBtn = row.createEl('button', { text: this.tt('common.recenter') });
		recenterBtn.addEventListener('click', this.cb.onRecenter);
		const revealBtn = row.createEl('button', { text: this.tt('3d.reveal') });
		revealBtn.addEventListener('click', this.cb.onReveal);
	}

	private renderAppearancePage(parent: HTMLElement): void {
		const s = this.settings;
		const d = DEFAULT_GALAXY_SETTINGS;
		const themeField = parent.createEl('label', { cls: 'mwm-panel-field' });
		themeField.createSpan({ text: this.tt('view.theme') });
		this.presetSelect = themeField.createEl('select');
		for (const [value, label] of this.themeOptions()) {
			this.presetSelect.createEl('option', { attr: { value }, text: label });
		}
		this.presetSelect.value = s.preset;
		this.presetSelect.addEventListener('change', () => {
			if (!this.presetSelect) return;
			s.preset = this.presetSelect.value as VisualPreset;
			this.cb.onPreset();
		});

		const chipRow = parent.createDiv({ cls: 'gx-chips' });
		for (const preset of STYLE_PRESETS) {
			const chip = chipRow.createEl('button', { cls: 'gx-chip', text: this.tt(`style.${preset.id}`) });
			chip.addEventListener('click', () => {
				this.cb.onStylePreset(preset);
				this.refreshAll();
				this.markActiveChip(preset.id);
			});
			chip.dataset['presetId'] = preset.id;
			this.styleChips.push(chip);
		}

		this.sliders.push(
			new Slider(parent, this.slider('3d.nodeSize', 0.3, 2.5, 0.05, d.look.nodeSize, () => s.look.nodeSize, (v) => (s.look.nodeSize = v), cbFmt('x'), this.cb.onLook)),
			new Slider(parent, this.slider('3d.linkOpacity', 0, 0.6, 0.01, d.look.linkOpacity, () => s.look.linkOpacity, (v) => (s.look.linkOpacity = v), undefined, this.cb.onLook)),
			new Slider(parent, this.slider('3d.twinkle', 0, 2, 0.1, d.look.twinkle, () => s.look.twinkle, (v) => (s.look.twinkle = v), (v) => (v < 0.05 ? this.tt('3d.twinkleOff') : v.toFixed(1)), this.cb.onLook)),
			new Slider(parent, this.slider('3d.glowStrength', 0, 2.5, 0.05, d.bloom.strength, () => s.bloom.strength, (v) => (s.bloom.strength = v), undefined, this.cb.onBloom)),
			new Slider(parent, this.slider('3d.glowRadius', 0, 1.2, 0.05, d.bloom.radius, () => s.bloom.radius, (v) => (s.bloom.radius = v), undefined, this.cb.onBloom)),
			new Slider(parent, this.slider('3d.glowThreshold', 0, 1, 0.05, d.bloom.threshold, () => s.bloom.threshold, (v) => (s.bloom.threshold = v), undefined, this.cb.onBloom)),
		);

		const sizeField = parent.createEl('label', { cls: 'mwm-panel-field' });
		sizeField.createSpan({ text: this.tt('3d.sizeBy') });
		this.sizeBySelect = sizeField.createEl('select');
		for (const [value, label] of this.sizeOptions()) {
			this.sizeBySelect.createEl('option', { attr: { value }, text: label });
		}
		this.sizeBySelect.value = s.look.sizeBy;
		this.sizeBySelect.addEventListener('change', () => {
			if (!this.sizeBySelect) return;
			s.look.sizeBy = this.sizeBySelect.value as SizeBy;
			this.cb.onSizeBy();
		});

		const themeSel = parent.createEl('select', { cls: 'gx-theme-select' });
		const customOpt = themeSel.createEl('option', { text: this.tt('3d.colorTheme'), value: '' });
		customOpt.disabled = true;
		for (const colorTheme of COLOR_THEMES) {
			themeSel.createEl('option', { text: this.tt(`color.${colorTheme.id}`), value: colorTheme.id });
		}
		themeSel.value = COLOR_THEMES.some((theme) => theme.id === s.colorTheme) ? s.colorTheme : '';
		if (!themeSel.value) customOpt.selected = true;
		themeSel.addEventListener('change', () => {
			const colorTheme = COLOR_THEMES.find((theme) => theme.id === themeSel.value);
			if (colorTheme) this.cb.onColorTheme(colorTheme);
		});

		const colorRow = parent.createDiv({ cls: 'galaxy-panel-row' });
		const importBtn = colorRow.createEl('button', { text: this.tt('3d.importColors') });
		importBtn.addEventListener('click', () => {
			this.cb.onImportColors();
			customOpt.selected = true;
		});
		const shuffleBtn = colorRow.createEl('button', { text: this.tt('3d.shuffleColors') });
		shuffleBtn.addEventListener('click', () => {
			this.cb.onShuffleColors();
			customOpt.selected = true;
		});
	}

	private renderPhysicsPage(parent: HTMLElement): void {
		const s = this.settings;
		const d = DEFAULT_GALAXY_SETTINGS;
		this.sliders.push(
			new Slider(parent, this.slider('3d.repel', 20, 400, 5, d.physics.repel, () => s.physics.repel, (v) => (s.physics.repel = v), (v) => String(Math.round(v)), this.cb.onPhysics)),
			new Slider(parent, this.slider('3d.linkDistance', 20, 200, 5, d.physics.linkDistance, () => s.physics.linkDistance, (v) => (s.physics.linkDistance = v), (v) => String(Math.round(v)), this.cb.onPhysics)),
			new Slider(parent, this.slider('3d.linkStrength', 0.1, 2, 0.1, d.physics.linkStrength, () => s.physics.linkStrength, (v) => (s.physics.linkStrength = v), cbFmt('x1'), this.cb.onPhysics)),
			new Slider(parent, this.slider('3d.centerPull', 0, 0.2, 0.005, d.physics.centerPull, () => s.physics.centerPull, (v) => (s.physics.centerPull = v), (v) => v.toFixed(3), this.cb.onPhysics)),
			new Slider(parent, this.slider('3d.flatten', 0, 0.8, 0.02, d.physics.flatten, () => s.physics.flatten, (v) => (s.physics.flatten = v), undefined, this.cb.onPhysics)),
		);
	}

	private renderMotionPage(parent: HTMLElement): void {
		const s = this.settings;
		const d = DEFAULT_GALAXY_SETTINGS;
		const row = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.cruiseBtn = row.createEl('button', { text: this.cruiseLabel() });
		this.cruiseBtn.addEventListener('click', () => {
			s.cruise = !s.cruise;
			this.cruiseBtn?.setText(this.cruiseLabel());
			this.cb.onCruise(s.cruise);
		});
		this.sliders.push(
			new Slider(parent, this.slider('3d.speed', 0.2, 3, 0.1, d.cruiseSpeed, () => s.cruiseSpeed, (v) => (s.cruiseSpeed = v), cbFmt('x1'), this.cb.onCruiseSpeed)),
		);
		const helpBody = parent.createDiv({ cls: 'galaxy-panel-help' });
		for (const key of ['3d.help.drag', '3d.help.pan', '3d.help.mac', '3d.help.fly', '3d.help.pick', '3d.help.keys', '3d.help.slider']) {
			helpBody.createDiv({ text: this.tt(key) });
		}
	}

	private renderAdvancedPage(parent: HTMLElement): void {
		const s = this.settings;
		const advRow = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.unresolvedBtn = advRow.createEl('button', { text: this.unresolvedLabel() });
		this.unresolvedBtn.addEventListener('click', () => {
			s.showUnresolved = !s.showUnresolved;
			this.unresolvedBtn?.setText(this.unresolvedLabel());
			this.cb.onShowUnresolved(s.showUnresolved);
		});
		this.orphanBtn = advRow.createEl('button', { text: this.orphanLabel() });
		this.orphanBtn.addEventListener('click', () => {
			s.showOrphans = !s.showOrphans;
			this.orphanBtn?.setText(this.orphanLabel());
			this.cb.onShowOrphans(s.showOrphans);
		});
		const advRow2 = parent.createDiv({ cls: 'galaxy-panel-row' });
		this.qualityBtn = advRow2.createEl('button', { text: this.qualityLabel() });
		this.qualityBtn.addEventListener('click', () => {
			const order: typeof s.qualityOverride[] = ['auto', 'high', 'low', 'mobile'];
			s.qualityOverride = order[(order.indexOf(s.qualityOverride) + 1) % order.length] ?? 'auto';
			this.qualityBtn?.setText(this.qualityLabel());
			this.cb.onQuality();
		});
		const resetBtn = advRow2.createEl('button', { text: this.tt('common.resetDefaults') });
		resetBtn.addEventListener('click', () => {
			this.cb.onReset();
			this.refreshAll();
		});
		if (__GALAXY_DEV__) {
			const devRow = parent.createDiv({ cls: 'galaxy-panel-row' });
			for (const sc of ['S1', 'S2', 'S3'] as const) {
				const b = devRow.createEl('button', { text: sc });
				b.addEventListener('click', () => this.cb.runScenario(sc));
			}
		}
	}

	private modeButton(parent: HTMLElement, mode: ViewMode): void {
		const button = parent.createEl('button', { cls: this.viewMode === mode ? 'is-active' : '', text: viewModeLabel(this.language, mode) });
		button.addEventListener('click', () => this.cb.onViewMode?.(mode));
	}

	private slider(
		key: string,
		min: number,
		max: number,
		step: number,
		defaultValue: number,
		get: () => number,
		set: (v: number) => void,
		fmt: ((v: number) => string) | undefined,
		onInput: () => void,
	): ConstructorParameters<typeof Slider>[1] {
		return {
			label: this.tt(key),
			min,
			max,
			step,
			defaultValue,
			get,
			set,
			fmt,
			onInput,
			defaultLabel: this.tt('common.default'),
		};
	}

	private cruiseLabel(): string {
		return this.settings.cruise ? this.tt('3d.cruiseOn') : this.tt('3d.cruiseOff');
	}

	private unresolvedLabel(): string {
		return this.settings.showUnresolved ? this.tt('3d.unresolvedShow') : this.tt('3d.unresolvedHide');
	}

	private orphanLabel(): string {
		return this.settings.showOrphans ? this.tt('3d.orphansShow') : this.tt('3d.orphansHide');
	}

	private qualityLabel(): string {
		return this.tt(`3d.quality.${this.settings.qualityOverride}`);
	}

	private themeOptions(): [VisualPreset, string][] {
		return [
			['auto', this.tt('theme.auto')],
			['night', this.tt('theme.night')],
			['day', this.tt('theme.day')],
			['deep-space', this.tt('theme.deep')],
		];
	}

	private sizeOptions(): [SizeBy, string][] {
		return [
			['degree', this.tt('3d.sizeOption.degree')],
			['fileSize', this.tt('3d.sizeOption.fileSize')],
			['uniform', this.tt('3d.sizeOption.uniform')],
		];
	}

	private markActiveChip(id: string): void {
		for (const chip of this.styleChips) chip.toggleClass('is-active', chip.dataset['presetId'] === id);
	}

	refreshAll(): void {
		for (const sl of this.sliders) sl.refresh();
		this.cruiseBtn?.setText(this.cruiseLabel());
		if (this.presetSelect) this.presetSelect.value = this.settings.preset;
		this.unresolvedBtn?.setText(this.unresolvedLabel());
		this.orphanBtn?.setText(this.orphanLabel());
		if (this.sizeBySelect) this.sizeBySelect.value = this.settings.look.sizeBy;
		this.qualityBtn?.setText(this.qualityLabel());
	}

	setLanguage(language: Language): void {
		this.language = language;
		this.render();
	}

	setPanelTheme(cls: VisualTokens['panelClass']): void {
		this.root.removeClass('gx-theme-space');
		this.root.removeClass('gx-theme-night');
		this.root.removeClass('gx-theme-dark');
		this.root.removeClass('gx-theme-light');
		this.root.addClass(cls);
	}

	dispose(): void {
		this.root.remove();
		this.sliders = [];
		this.styleChips = [];
	}

	private tt(key: string, vars: Record<string, string | number> = {}): string {
		return t(this.language, key, vars);
	}
}

function cbFmt(kind: 'x' | 'x1'): (value: number) => string {
	return (value) => (kind === 'x1' ? `${value.toFixed(1)}x` : `${value.toFixed(2)}x`);
}
