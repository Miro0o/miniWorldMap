import type { RadialSettings } from '../settings';
import type { VisibleGraphState, VisibleWorldGraph, WorldModel } from './types';
import { buildVisibleWorldGraph } from './visibleGraph';

/** Keep the render and legend-neutral graphs without retaining old vault snapshots. */
export class VisibleGraphCache {
	private model: WorldModel | null = null;
	private settingsKey = '';
	private entries = new Map<string, VisibleWorldGraph>();

	get(model: WorldModel, state: VisibleGraphState, settings: RadialSettings): VisibleWorldGraph {
		// Only these settings supply fallbacks during materialization. Appearance
		// settings and legend flags already belong to the explicit view state.
		const settingsKey = JSON.stringify([
			settings.atlasDepth, settings.focusSiblingLimit, settings.renderNodeLimit,
			settings.linkLimit, settings.externalLinkAnchorLimit,
		]);
		if (model !== this.model || settingsKey !== this.settingsKey) {
			this.clear();
			this.model = model;
			this.settingsKey = settingsKey;
		}
		const key = JSON.stringify(state);
		const graph = this.entries.get(key) ?? buildVisibleWorldGraph(model, state, settings);
		this.entries.delete(key);
		this.entries.set(key, graph);
		if (this.entries.size > 2) this.entries.delete(this.entries.keys().next().value!);
		return graph;
	}

	clear(): void {
		this.model = null;
		this.entries.clear();
	}
}
