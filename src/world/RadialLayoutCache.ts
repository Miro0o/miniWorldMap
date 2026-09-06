import type { RadialLayout, RadialLayoutOptions } from '../layout/radial/types';
import type { VisibleWorldGraph } from './types';

/** A view retains its last two layouts across controller/mode changes.
 * Compare the complete input, including Map contents, after refreshing metadata.
 * Copies isolate the cache from renderer animation and caller mutations.
 */
export class RadialLayoutCache {
	private entries = new Map<string, RadialLayout>();

	key(graph: VisibleWorldGraph, options: RadialLayoutOptions): string {
		return JSON.stringify([graph, options], (_key, value: unknown) => value instanceof Map ? [...value] : value);
	}

	get(key: string): RadialLayout | undefined {
		const layout = this.entries.get(key);
		if (!layout) return undefined;
		this.entries.delete(key);
		this.entries.set(key, layout);
		return structuredClone(layout);
	}

	set(key: string, layout: RadialLayout): void {
		this.entries.delete(key);
		this.entries.set(key, structuredClone(layout));
		while (this.entries.size > 2) this.entries.delete(this.entries.keys().next().value!);
	}

	clear(): void {
		this.entries.clear();
	}
}
