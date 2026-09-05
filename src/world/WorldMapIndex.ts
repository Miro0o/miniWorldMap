import type { App } from 'obsidian';
import type { RadialSettings } from '../settings';
import type { LinkTable, VisibleGraphState, VisibleWorldGraph, WorldEdge, WorldFileRecord, WorldModel, WorldNode } from './types';
import { visualNodeId } from './visibleGraph';
import { VisibleGraphCache } from './VisibleGraphCache';
import { WorldMapComputation } from './WorldMapComputation';
import { collectEntries, snapshotLinks } from './vaultSnapshot';

export class WorldMapIndex {
	model: WorldModel | null = null;
	private dirty = true;
	private indexSettingsKey = '';
	private visibleCache = new VisibleGraphCache();
	private revision = 0;
	private disposed = false;
	private records: WorldFileRecord[] | null = null;
	private resolved: LinkTable | null = null;
	private unresolved: LinkTable | null = null;
	private rootTitle = '';
	private pending: Promise<void> | null = null;

	constructor(
		private app: App,
		private settings: RadialSettings,
		readonly computation = new WorldMapComputation(),
	) {}

	get ready(): boolean {
		return this.model !== null;
	}

	get nodes(): Map<string, WorldNode> {
		return this.model?.nodes ?? new Map();
	}

	get stats() {
		return this.model?.stats ?? {
			loadedEntries: 0,
			scannedMarkdown: 0,
			folders: 0,
			notes: 0,
			unresolved: 0,
			hierarchyEdges: 0,
			linkEdges: 0,
			maxDepth: 0,
		};
	}

	get linkEdgesBySource(): Map<string, WorldEdge[]> {
		return this.model?.linkEdgesBySource ?? new Map<string, WorldEdge[]>();
	}

	get linkEdgesByTarget(): Map<string, WorldEdge[]> {
		return this.model?.linkEdgesByTarget ?? new Map<string, WorldEdge[]>();
	}

	invalidate(kind: 'structure' | 'links' = 'structure'): void {
		this.dirty = true;
		this.revision++;
		if (kind === 'structure') this.records = null;
	}

	async ensureReady(settings: RadialSettings = this.settings): Promise<boolean> {
		while (!this.disposed) {
			if (this.pending) {
				await this.pending;
				continue;
			}
			this.settings = settings;
			if (this.model && !this.dirty && this.settingsKey(settings) === this.indexSettingsKey) return true;
			const pending = this.refreshAsync(settings);
			this.pending = pending;
			try {
				await pending;
			} finally {
				if (this.pending === pending) this.pending = null;
			}
		}
		return false;
	}

	private async refreshAsync(settings: RadialSettings): Promise<void> {
		const revision = this.revision;
		const cancelled = () => this.disposed || revision !== this.revision;
		const key = this.settingsKey(settings);
		const indexSettings = { includeUnresolvedLinks: settings.includeUnresolvedLinks, ignoreFolders: settings.ignoreFolders.slice() };
		const records = this.records ?? await collectEntries(this.app.vault, cancelled);
		if (!records || cancelled()) return;
		const resolved = await snapshotLinks(this.app.metadataCache.resolvedLinks, this.resolved, cancelled);
		if (!resolved || cancelled()) return;
		const unresolved = await snapshotLinks(this.app.metadataCache.unresolvedLinks, this.unresolved, cancelled);
		if (!unresolved || cancelled()) return;
		const rootTitle = this.app.vault.getName();
		if (!this.model || records !== this.records || resolved !== this.resolved
			|| (settings.includeUnresolvedLinks && unresolved !== this.unresolved)
			|| key !== this.indexSettingsKey || rootTitle !== this.rootTitle) {
			const model = await this.computation.buildModel({ records, resolved, unresolved, settings: indexSettings, rootTitle });
			if (!model || cancelled()) return;
			this.model = model;
			this.visibleCache.clear();
		}
		this.records = records;
		this.resolved = resolved;
		this.unresolved = unresolved;
		this.rootTitle = rootTitle;
		this.indexSettingsKey = key;
		this.dirty = false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.revision++;
		this.computation.dispose();
		this.model = null;
		this.dirty = true;
		this.records = null;
		this.resolved = null;
		this.unresolved = null;
		this.visibleCache.clear();
	}

	private settingsKey(settings: RadialSettings): string {
		return JSON.stringify([settings.includeUnresolvedLinks, settings.ignoreFolders]);
	}

	buildVisibleGraph(state: VisibleGraphState): VisibleWorldGraph {
		if (!this.model) throw new Error('World map index is not ready');
		return this.visibleCache.get(this.model, state, this.settings);
	}

	visualNodeId(id: string | null | undefined): string | null {
		return this.model ? visualNodeId(this.model, id) : (id ?? null);
	}

	getActiveNotePath(): string | null {
		const active = this.app.workspace.getActiveFile();
		if (active && this.nodes.has(active.path)) return active.path;
		return [...this.nodes.values()].find((node) => node.type === 'note')?.id ?? null;
	}
}
