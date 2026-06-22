import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_MINI_WORLD_MAP } from '../constants';
import type { SettingsHost, ViewMode } from '../settings';
import { Map3DController } from './Map3DController';
import { Radial2DController } from './Radial2DController';

type ActiveController = Radial2DController | Map3DController;

export class MiniWorldMapView extends ItemView {
	navigation = true;
	controller: ActiveController | null = null;
	private initRetryTimer = 0;
	private initRetryCount = 0;
	private bootStatusEl: HTMLElement | null = null;
	private bootStatusTimer = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private host: SettingsHost,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_MINI_WORLD_MAP;
	}

	getDisplayText(): string {
		return 'Mini World Map';
	}

	getIcon(): string {
		return 'network';
	}

	get counts(): { nodes: number; links: number } {
		return this.controller?.counts ?? { nodes: 0, links: 0 };
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('mini-world-map-view', 'galaxy-view-content');
		this.showBootStatus(`Mini World Map view opening (${this.host.settings.viewMode})`);
		this.registerEvent(this.app.workspace.on('css-change', () => this.controller?.onCssChange?.()));
		this.tryInit();
	}

	onResize(): void {
		if (!this.controller) {
			this.tryInit();
			return;
		}
		this.controller.resize();
	}

	switchMode(mode: ViewMode): void {
		if (this.host.settings.viewMode !== mode) {
			this.host.setViewMode(mode);
			return;
		}
		this.rebuild();
	}

	private tryInit(): void {
		if (this.controller) return;
		const { clientWidth: width, clientHeight: height } = this.contentEl;
		if (width < 10 || height < 10) {
			this.showBootStatus(`Mini World Map waiting for pane size (${Math.round(width)} x ${Math.round(height)})`);
			this.scheduleInitRetry();
			return;
		}
		this.clearInitRetry();
		this.initRetryCount = 0;
		this.showBootStatus(`Mini World Map starting ${this.host.settings.viewMode === 'map3d' ? '3D' : '2D'} map`);
		if (this.host.settings.viewMode === 'map3d') {
			const controller = new Map3DController(
				this.app,
				this.contentEl,
				this.host.settings.galaxy3d,
				() => void this.host.saveSettings(),
				(mode) => this.switchMode(mode),
				this.host.settings.language,
				(language) => this.host.setLanguage(language),
			);
			controller.onContextLost = () => this.rebuild();
			this.controller = controller;
			this.addChild(controller.store);
			this.startController(controller);
		} else {
			const controller = new Radial2DController(
				this.app,
				this.contentEl,
				this.host.settings,
				() => void this.host.saveSettings(),
				(mode) => this.switchMode(mode),
				(language) => this.host.setLanguage(language),
			);
			this.controller = controller;
			this.addChild(controller);
			this.startController(controller);
		}
	}

	private startController(controller: ActiveController): void {
		void controller
			.start()
			.then(() => {
				if (this.controller !== controller) return;
				this.showBootStatus(`Mini World Map ${this.host.settings.viewMode === 'map3d' ? '3D' : '2D'} map started: ${controller.counts.nodes} nodes, ${controller.counts.links} links`);
				this.clearBootStatus(12000);
			})
			.catch((error) => {
				if (this.controller !== controller) return;
				console.error('[Mini World Map] failed to start view', error);
				new Notice('Mini World Map failed to load. Check the developer console for details.');
				controller.dispose();
				this.controller = null;
				this.contentEl.empty();
				this.contentEl.addClass('mini-world-map-view', 'galaxy-view-content');
				this.showBootStatus('Mini World Map failed to start. Check the developer console.');
			});
	}

	private scheduleInitRetry(): void {
		if (this.initRetryTimer) return;
		const delay = Math.min(600, 32 + this.initRetryCount * 48);
		this.initRetryCount++;
		this.initRetryTimer = window.setTimeout(() => {
			this.initRetryTimer = 0;
			this.tryInit();
		}, delay);
	}

	private clearInitRetry(): void {
		if (!this.initRetryTimer) return;
		window.clearTimeout(this.initRetryTimer);
		this.initRetryTimer = 0;
	}

	private rebuild(): void {
		this.clearInitRetry();
		this.controller?.dispose();
		this.controller = null;
		this.contentEl.empty();
		this.contentEl.addClass('mini-world-map-view', 'galaxy-view-content');
		this.showBootStatus(`Mini World Map rebuilding (${this.host.settings.viewMode})`);
		this.tryInit();
	}

	async onClose(): Promise<void> {
		this.clearInitRetry();
		this.clearBootStatus();
		this.controller?.dispose();
		this.controller = null;
		this.contentEl.empty();
	}

	private showBootStatus(text: string): void {
		if (this.bootStatusTimer) {
			window.clearTimeout(this.bootStatusTimer);
			this.bootStatusTimer = 0;
		}
		if (!this.bootStatusEl) this.bootStatusEl = this.contentEl.createDiv({ cls: 'mwm-boot-status' });
		this.bootStatusEl.setText(text);
	}

	private clearBootStatus(delayMs = 0): void {
		if (this.bootStatusTimer) {
			window.clearTimeout(this.bootStatusTimer);
			this.bootStatusTimer = 0;
		}
		if (delayMs > 0) {
			this.bootStatusTimer = window.setTimeout(() => {
				this.bootStatusTimer = 0;
				this.clearBootStatus();
			}, delayMs);
			return;
		}
		this.bootStatusEl?.remove();
		this.bootStatusEl = null;
	}
}

export { MiniWorldMapView as GalaxyView };
