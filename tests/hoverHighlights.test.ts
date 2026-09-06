import { describe, expect, it } from 'vitest';
import { Radial2DController } from '../src/view/Radial2DController';
import { createHighlightIndex } from '../src/view/radialHighlights';
import type { RadialActiveState } from '../src/render/RadialRenderer';
import { completeGraph } from './helpers/radialFixtures';
import { combineHoverHighlights, type HierarchyHighlightMode, mergeSettings } from '../src/settings';
import { hoverModeLabel } from '../src/i18n';

const graph = completeGraph(['A/B/B.md', 'A/B/Direct.md', 'A/B/Deep/Leaf.md', 'Other.md'].map((path) => ({
	path, basename: path.split('/').pop()!.replace('.md', ''), kind: 'note',
})), '', { 'A/B/B.md': { 'Other.md': 1 } });
const scopes: [HierarchyHighlightMode | null, [string, string][]][] = [
	[null, []],
	['hierarchy-parents', [['', 'A'], ['A', 'A/B']]],
	['hierarchy-direct-children', [['A/B', 'A/B/Direct.md'], ['A/B', 'A/B/Deep']]],
	['hierarchy-descendants', [['A/B', 'A/B/Direct.md'], ['A/B', 'A/B/Deep'], ['A/B/Deep', 'A/B/Deep/Leaf.md']]],
	['hierarchy-parents-direct', [['', 'A'], ['A', 'A/B'], ['A/B', 'A/B/Direct.md'], ['A/B', 'A/B/Deep']]],
	['hierarchy-all', [['', 'A'], ['A', 'A/B'], ['A/B', 'A/B/Direct.md'], ['A/B', 'A/B/Deep'], ['A/B/Deep', 'A/B/Deep/Leaf.md']]],
];

function controller(mode: string, nodeId: string | null = 'A/B') {
	return Object.assign(Object.create(Radial2DController.prototype), {
		graph, highlightIndex: createHighlightIndex(graph), state: { hoverHighlightMode: mode },
		hoverNodeId: nodeId, selectedNodeId: null, hoverLink: null, selectedLink: null,
		pinnedPaths: [] as { kind: string; nodeId: string; mode: string; active: boolean; groupIds: string[] }[], pinGroups: [],
	}) as { resolveActiveState(): RadialActiveState; pinnedPaths: { kind: string; nodeId: string; mode: string; active: boolean; groupIds: string[] }[] };
}

describe('independent hover highlights', () => {
	it.each(scopes)('applies scope %s with note links independently on or off', (scope, pairs) => {
		for (const noteLinks of [false, true]) {
			const active = controller(combineHoverHighlights(noteLinks, scope)).resolveActiveState();
			const hierarchy = graph.hierarchyEdges.filter((edge) => pairs.some(([a, b]) => edge.source === a && edge.target === b));
			expect(hierarchy).toHaveLength(pairs.length);
			const notes = [...graph.linkEdges, ...graph.hoverLinkEdges].filter((edge) => edge.source === 'A/B' || edge.target === 'A/B');
			expect(notes.length).toBeGreaterThan(0);
			const expected = [...hierarchy, ...(noteLinks ? notes : [])];
			expect(active.highlightedEdges).toEqual(new Set(expected.map((edge) => edge.id)));
			expect(active.relatedNodes).toEqual(new Set(['A/B', ...expected.flatMap((edge) => [edge.source, edge.target])]));
		}
	});

	it('retains the combined scope of a pin after hover highlighting is turned off', () => {
		const combined = 'note-links+hierarchy-parents';
		const view = controller('none', null);
		view.pinnedPaths.push({ kind: 'node', nodeId: 'A/B', mode: combined, active: true, groupIds: [] });
		expect(view.resolveActiveState().highlightedEdges).toEqual(controller(combined).resolveActiveState().highlightedEdges);
		expect(hoverModeLabel('en', combined)).toBe('Note links + Parents');
		expect(hoverModeLabel('zh', combined)).toBe('笔记链接 + 父级');
	});

	it('highlights the direct children of the vault root', () => {
		const active = controller('hierarchy-direct-children', '').resolveActiveState();
		expect(active.highlightedEdges).toEqual(new Set(graph.hierarchyEdges.filter((edge) => edge.source === '').map((edge) => edge.id)));
		expect(active.hasActive).toBe(true);
	});

	it('renders two independent checkboxes and retains the disabled hierarchy scope', () => {
		const settings = mergeSettings({ radial: { hoverHighlightMode: 'note-links+hierarchy-parents' } });
		const toggles = new Map<string, { value: boolean; change(value: boolean): void }>();
		let select: { value: string; disabled: boolean; change(value: HierarchyHighlightMode): void };
		const host = { createEl: () => host, createDiv: () => host };
		const view = Object.assign(Object.create(Radial2DController.prototype), {
			settings, state: { hoverHighlightMode: settings.radial.hoverHighlightMode },
			toggle(_parent: unknown, label: string, value: boolean, change: (value: boolean) => void) { toggles.set(label, { value, change }); },
			select(_parent: unknown, _label: string, value: string, _options: unknown, change: (value: HierarchyHighlightMode) => void, _title: string, disabled: boolean) { select = { value, disabled, change }; },
			saveSoon() {}, renderPanel() {}, rebuild() {}, pinnedPathsNeedHoverLinks: () => false,
		}) as { renderHoverControls(parent: HTMLElement): void };
		const render = () => view.renderHoverControls(host as unknown as HTMLElement);
		render();
		expect(toggles.get('Note links')!.value).toBe(true);
		expect(toggles.get('Hierarchy links')!.value).toBe(true);
		toggles.get('Hierarchy links')!.change(false);
		render();
		expect(settings.radial.hoverHighlightMode).toBe('note-links');
		expect(select!.disabled).toBe(true);
		expect(select!.value).toBe('hierarchy-parents');
		toggles.get('Hierarchy links')!.change(true);
		render();
		select!.change('hierarchy-direct-children');
		expect(settings.radial.hoverHighlightMode).toBe('note-links+hierarchy-direct-children');
		toggles.get('Note links')!.change(false);
		expect(settings.radial.hoverHighlightMode).toBe('hierarchy-direct-children');
	});
});
