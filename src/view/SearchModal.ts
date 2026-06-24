import type { App } from 'obsidian';
import { SuggestModal, prepareFuzzySearch } from 'obsidian';

export interface NodeSearchItem<T> {
	value: T;
	title: string;
	path: string;
	detail: string;
	rank: number;
	unresolved?: boolean;
	hideWhenEmpty?: boolean;
	searchText?: string[];
}

interface Hit<T> {
	item: NodeSearchItem<T>;
	score: number;
}

/** Shared node search for map views (Obsidian SuggestModal, keyboard friendly). */
export class NodeSearchModal<T> extends SuggestModal<Hit<T>> {
	constructor(
		app: App,
		private items: NodeSearchItem<T>[],
		private onPick: (value: T) => void,
		placeholder: string,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getSuggestions(query: string): Hit<T>[] {
		const q = query.trim();
		if (!q) {
			return this.items
				.filter((item) => !item.unresolved && !item.hideWhenEmpty)
				.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title))
				.slice(0, 20)
				.map((item) => ({ item, score: 0 }));
		}
		const fuzzy = prepareFuzzySearch(q);
		const hits: Hit<T>[] = [];
		for (const item of this.items) {
			let bestScore: number | null = null;
			for (const text of item.searchText ?? [item.title, item.path]) {
				const match = fuzzy(text);
				if (!match) continue;
				bestScore = bestScore === null ? match.score : Math.max(bestScore, match.score);
			}
			if (bestScore !== null) hits.push({ item, score: bestScore });
		}
		return hits.sort((a, b) => b.score - a.score || b.item.rank - a.item.rank || a.item.title.localeCompare(b.item.title)).slice(0, 50);
	}

	renderSuggestion(hit: Hit<T>, el: HTMLElement): void {
		el.createDiv({ text: hit.item.title });
		el.createDiv({
			cls: 'gx-search-path',
			text: hit.item.detail,
		});
	}

	onChooseSuggestion(hit: Hit<T>): void {
		this.onPick(hit.item.value);
	}
}
