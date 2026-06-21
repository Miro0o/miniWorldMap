import { ItemView, WorkspaceLeaf } from 'obsidian';
import { VIEW_TYPE_MINI_WORLD_MAP } from '../constants';
import type { SettingsHost, ViewMode } from '../settings';
import { Map3DController } from './Map3DController';
import { Radial2DController } from './Radial2DController';

type ActiveController = Radial2DController | Map3DController;

export class MiniWorldMapView extends ItemView {
	navigation = true;
	controller: ActiveController | null = null;

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
		if (width < 10 || height < 10) return;
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
			void controller.start();
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
			void controller.start();
		}
	}

	private rebuild(): void {
		this.controller?.dispose();
		this.controller = null;
		this.contentEl.empty();
		this.tryInit();
	}

	async onClose(): Promise<void> {
		this.controller?.dispose();
		this.controller = null;
		this.contentEl.empty();
	}
}

export { MiniWorldMapView as GalaxyView };
