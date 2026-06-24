import type { App } from 'obsidian';
import { TFile, TFolder } from 'obsidian';
import type { RadialSettings } from '../settings';
import { buildWorldMap, normalizeVaultPath } from './buildWorldMap';
import type { LinkTable, VisibleGraphState, VisibleWorldGraph, WorldEdge, WorldFileRecord, WorldModel, WorldNode } from './types';
import { ROOT_ID } from './types';
import { buildVisibleWorldGraph, visualNodeId } from './visibleGraph';

export class WorldMapIndex {
	model: WorldModel | null = null;

	constructor(
		private app: App,
		private settings: RadialSettings,
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

	rebuild(settings: RadialSettings = this.settings): void {
		this.settings = settings;
		this.model = buildWorldMap(
			this.collectVaultEntries(),
			this.app.metadataCache.resolvedLinks as LinkTable,
			this.app.metadataCache.unresolvedLinks as LinkTable,
			settings,
			this.app.vault.getName(),
		);
	}

	buildVisibleGraph(state: VisibleGraphState): VisibleWorldGraph {
		if (!this.model) this.rebuild();
		return buildVisibleWorldGraph(this.model!, state, this.settings);
	}

	visualNodeId(id: string | null | undefined): string | null {
		return this.model ? visualNodeId(this.model, id) : (id ?? null);
	}

	getActiveNotePath(): string | null {
		const active = this.app.workspace.getActiveFile();
		if (active && this.nodes.has(active.path)) return active.path;
		return [...this.nodes.values()].find((node) => node.type === 'note')?.id ?? null;
	}

	private collectVaultEntries(): WorldFileRecord[] {
		const entries: WorldFileRecord[] = [];
		const root = typeof this.app.vault.getRoot === 'function' ? this.app.vault.getRoot() : null;
		const stack = root && Array.isArray(root.children) ? [...root.children] : [];
		while (stack.length > 0) {
			const entry = stack.pop();
			if (entry instanceof TFolder) {
				const path = normalizeVaultPath(entry.path);
				if (path) entries.push({ path, basename: entry.name, kind: 'folder' });
				if (Array.isArray(entry.children)) {
					for (let index = entry.children.length - 1; index >= 0; index--) {
						const child = entry.children[index];
						if (child) stack.push(child);
					}
				}
			} else if (entry instanceof TFile && entry.extension === 'md') {
				entries.push({ path: entry.path, basename: entry.basename, kind: 'note', size: entry.stat.size });
			}
		}
		if (entries.length === 0) {
			for (const file of this.app.vault.getMarkdownFiles()) {
				entries.push({ path: file.path, basename: file.basename, kind: 'note', size: file.stat.size });
			}
		}
		if (!entries.some((entry) => entry.path === ROOT_ID)) return entries;
		return entries.filter((entry) => entry.path !== ROOT_ID);
	}
}
