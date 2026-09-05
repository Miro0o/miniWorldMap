import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { VisibleGraphCache } from '../src/world/VisibleGraphCache';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';

function fixture() {
	const settings = { ...DEFAULT_RADIAL_SETTINGS, hiddenLegendItems: [], ignoreFolders: [] };
	const model = buildWorldMap([
		{ path: 'A/one.md', basename: 'one', kind: 'note' },
		{ path: 'A/two.md', basename: 'two', kind: 'note' },
		{ path: 'B/other.md', basename: 'other', kind: 'note' },
	], { 'A/one.md': { 'A/two.md': 1, 'B/other.md': 2 } }, {}, settings);
	return { settings, model, state: defaultVisibleGraphState(settings) };
}

describe('visible graph caching', () => {
	it('keeps the neutral layout graph while cycling legend visibility', () => {
		const { model, settings, state } = fixture();
		const cache = new VisibleGraphCache();
		const neutral = cache.get(model, state, settings);
		for (const hiddenLegendItems of [['link'], ['outside'], ['tree'], []]) {
			const changed = { ...state, hiddenLegendItems };
			const changedSettings = { ...settings, hiddenLegendItems };
			expect(cache.get(model, changed, changedSettings)).toEqual(buildVisibleWorldGraph(model, changed, changedSettings));
			expect(cache.get(model, { ...state }, changedSettings)).toBe(neutral);
		}
	});

	it('invalidates on a new vault snapshot and explicit clear', () => {
		const { model, settings, state } = fixture();
		const cache = new VisibleGraphCache();
		const original = cache.get(model, state, settings);
		expect(cache.get({ ...model }, state, settings)).not.toBe(original);
		cache.clear();
		expect(cache.get(model, state, settings)).not.toBe(original);
	});

	it('observes in-place state changes for roots, budgets, focus and cross-root detail', () => {
		const { model, settings, state } = fixture();
		const cache = new VisibleGraphCache();
		cache.get(model, state, settings);
		for (const update of [
			{ rootPath: 'A' }, { linkLimit: 0 }, { linkLimit: 20, externalDetailMode: 'exact' as const },
			{ mode: 'focus' as const, focusPath: 'A/two.md' }, { showCompleteRoot: true },
		]) {
			Object.assign(state, update);
			expect(cache.get(model, state, settings)).toEqual(buildVisibleWorldGraph(model, state, settings));
		}
	});

	it('invalidates changed fallback settings', () => {
		const { model, settings, state } = fixture();
		state.linkLimit = NaN;
		const cache = new VisibleGraphCache();
		cache.get(model, state, settings);
		settings.linkLimit = 0;
		expect(cache.get(model, state, settings).linkEdges).toHaveLength(0);
	});
});
