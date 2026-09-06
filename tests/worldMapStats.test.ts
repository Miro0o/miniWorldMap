import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { filterLegendGraph } from '../src/view/radialViewHelpers';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';
import { buildSubtreeNodeCounts, renderedNodeCounts } from '../src/world/worldMapStats';

const settings = { ...DEFAULT_RADIAL_SETTINGS, includeUnresolvedLinks: true, ignoreFolders: ['Ignored'] };
const records = ['Loose.md', 'A/A.md', 'A/Note.md', 'A/Empty', 'A/Sub/Leaf.md', 'AB/Other.md', 'Ignored/Hidden.md']
	.map((path) => ({ path, basename: path.split('/').pop()!.replace(/\.md$/, ''), kind: path.endsWith('.md') ? 'note' as const : 'folder' as const }));

function fixture() {
	return buildWorldMap(records, { 'A/Note.md': { 'AB/Other.md': 3 } }, { 'A/Note.md': { 'AB/Missing': 2 } }, settings);
}

describe('map count units and scopes', () => {
	it('counts folders, folded folder notes, missing targets and the Vault root exactly once', () => {
		const model = fixture();
		const counts = buildSubtreeNodeCounts(model);
		expect(model.nodes.get('')!.noteCount).toBe(5);
		expect(model.nodes.get('A')!.noteCount).toBe(3);
		expect(counts.get('')).toBe(10);
		expect(counts.get('A')).toBe(6);
		expect(counts.get('AB')).toBe(2);
		expect(counts.get('A/Empty')).toBe(1);
		expect(counts.has('Ignored')).toBe(false);
		const graph = buildVisibleWorldGraph(model, { ...defaultVisibleGraphState(settings), showCompleteRoot: true }, settings);
		expect(graph.nodes.length).toBe(counts.get(''));
		expect(renderedNodeCounts(graph)).toEqual({ inside: 10, outside: 0, folders: 5, notes: 4, missing: 1 });
	});

	it.each(['grouped', 'exact'] as const)('separates the current subtree from %s outside nodes', (externalDetailMode) => {
		const model = fixture();
		const graph = buildVisibleWorldGraph(model, { ...defaultVisibleGraphState(settings), rootPath: 'A', showCompleteRoot: true, externalDetailMode }, settings);
		const counts = renderedNodeCounts(graph);
		expect(counts.inside).toBe(buildSubtreeNodeCounts(model).get('A'));
		expect(counts).toMatchObject({ inside: 6, folders: 3, notes: 2, missing: 1 });
		expect(counts.outside).toBeGreaterThan(0);
		expect(counts.inside + counts.outside).toBe(graph.nodes.length);
		// The missing target's text says AB, but it belongs to its source in A.
		expect(graph.nodes.some((node) => node.type === 'unresolved' && node.parentId === 'A')).toBe(true);
	});

	it('reports the filtered rendering without changing the full subtree total', () => {
		const model = fixture();
		const graph = buildVisibleWorldGraph(model, { ...defaultVisibleGraphState(settings), rootPath: 'A', showCompleteRoot: true }, settings);
		const hidden = filterLegendGraph(graph, new Set(['root', 'missing', 'outside', 'outside-file']));
		expect(renderedNodeCounts(hidden)).toEqual({ inside: 4, outside: 0, folders: 2, notes: 2, missing: 0 });
		expect(buildSubtreeNodeCounts(model).get('A')).toBe(6);
		expect(hidden.nodes.length).toBe(4);
	});

	it('retains all subtree nodes when a render budget hides notes', () => {
		const entries = Array.from({ length: 250 }, (_, i) => ({ path: `A/Note ${i}.md`, basename: `Note ${i}`, kind: 'note' as const }));
		const model = buildWorldMap(entries, {}, {}, settings);
		const graph = buildVisibleWorldGraph(model, { ...defaultVisibleGraphState(settings), rootPath: 'A', nodeLimit: 200 }, settings);
		expect(buildSubtreeNodeCounts(model).get('A')).toBe(251);
		expect(renderedNodeCounts(graph).inside).toBe(graph.nodes.length);
		expect(graph.nodes.length).toBeLessThan(251);
		expect(model.nodes.get('A')!.noteCount).toBe(250);
	});

	it('keeps an empty Vault as one map node and zero Markdown files', () => {
		const model = buildWorldMap([], {}, {}, settings);
		expect(buildSubtreeNodeCounts(model).get('')).toBe(1);
		expect(model.nodes.get('')!.noteCount).toBe(0);
		expect(renderedNodeCounts(null)).toEqual({ inside: 0, outside: 0, folders: 0, notes: 0, missing: 0 });
	});
});
