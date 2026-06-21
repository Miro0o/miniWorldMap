import type { App } from 'obsidian';
import { SuggestModal, prepareFuzzySearch } from 'obsidian';
import type { Language } from '../settings';
import type { GraphNode } from '../types';
import { t } from '../i18n';

interface Hit {
	index: number;
	node: GraphNode;
	score: number;
}

/** 搜索星系节点 → 镜头飞行（Obsidian 原生 SuggestModal，键盘友好） */
export class NodeSearchModal extends SuggestModal<Hit> {
	constructor(
		app: App,
		private nodes: GraphNode[],
		private onPick: (index: number) => void,
		private language: Language = 'en',
	) {
		super(app);
		this.setPlaceholder(this.tt('3d.searchPlaceholder'));
	}

	getSuggestions(query: string): Hit[] {
		const q = query.trim();
		if (!q) {
			// 空查询：按度数给出枢纽 top 20——「星座导览」
			return [...this.nodes.entries()]
				.filter(([, n]) => !n.unresolved)
				.sort((a, b) => b[1].degree - a[1].degree)
				.slice(0, 20)
				.map(([index, node]) => ({ index, node, score: 0 }));
		}
		const fuzzy = prepareFuzzySearch(q);
		const hits: Hit[] = [];
		for (let i = 0; i < this.nodes.length; i++) {
			const node = this.nodes[i];
			if (!node) continue;
			const m = fuzzy(node.name) ?? fuzzy(node.id);
			if (m) hits.push({ index: i, node, score: m.score });
		}
		return hits.sort((a, b) => b.score - a.score || b.node.degree - a.node.degree).slice(0, 50);
	}

	renderSuggestion(hit: Hit, el: HTMLElement): void {
		el.createDiv({ text: hit.node.name });
		el.createDiv({
			cls: 'gx-search-path',
			text: `${hit.node.unresolved ? this.tt('3d.searchUnresolved') : hit.node.id} · ${this.tt('3d.searchLinks', { count: hit.node.degree })}`,
		});
	}

	onChooseSuggestion(hit: Hit): void {
		this.onPick(hit.index);
	}

	private tt(key: string, vars: Record<string, string | number> = {}): string {
		return t(this.language, key, vars);
	}
}
