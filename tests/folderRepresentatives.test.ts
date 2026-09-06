import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { type WorldFileRecord } from '../src/world/types';
import { buildVisibleWorldGraph, defaultVisibleGraphState, visualNodeId } from '../src/world/visibleGraph';
import { buildSubtreeNodeCounts } from '../src/world/worldMapStats';

function recordsFor(paths: string[]): WorldFileRecord[] {
	return paths.map((path) => ({
		path,
		basename: path.split('/').pop()!.replace(/\.md$/i, ''),
		kind: /\.md$/i.test(path) ? 'note' : 'folder',
	}));
}

describe('folder note matching', () => {
	it.each([
		['📚 学习', '学习'],
		['学习 📚', '学习'],
		['📚学习🧠', '学习'],
		['👩🏽‍💻 编程', '编程'],
		['🇨🇳 中国', '中国'],
		['🏳️‍🌈 Pride', 'Pride'],
		['🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Scotland', 'Scotland'],
		['1️⃣ Chapter 1', 'Chapter 1'],
		['📚 Topic 🧠 Notes', 'Topic Notes'],
		['📚 ATLAS', 'atlas'],
		['📚 学习', '🧠 学习'],
	])('matches folder %s to its child note %s', (folder, title) => {
		const notePath = `${folder}/${title}.md`;
		const model = buildWorldMap(recordsFor([notePath]), {}, {}, DEFAULT_RADIAL_SETTINGS);
		expect(model.folderRepresentatives.get(folder)).toBe(notePath);
		expect(model.nodes.get(folder)).toMatchObject({ title: folder, path: folder, representativeFile: notePath });
		expect(model.nodes.get(notePath)).toMatchObject({ title, path: notePath, isRepresentativeFile: true, representativeFor: folder });
	});

	it.each([false, true])('prefers the original same-name match regardless of input order (reversed: %s)', (reversed) => {
		const folder = '📚 Atlas';
		const paths = [`${folder}/Atlas.md`, `${folder}/📚 ATLAS.md`];
		const model = buildWorldMap(recordsFor(reversed ? paths.reverse() : paths), {}, {}, DEFAULT_RADIAL_SETTINGS);
		expect(model.folderRepresentatives.get(folder)).toBe(`${folder}/📚 ATLAS.md`);
		expect(model.nodes.get(`${folder}/Atlas.md`)?.isRepresentativeFile).toBeUndefined();
	});

	it.each([false, true])('keeps ambiguous emoji-insensitive matches separate (reversed: %s)', (reversed) => {
		const paths = ['📚 Atlas/Atlas.md', '📚 Atlas/🧠 Atlas.md'];
		const model = buildWorldMap(recordsFor(reversed ? paths.reverse() : paths), {}, {}, DEFAULT_RADIAL_SETTINGS);
		expect(model.folderRepresentatives.size).toBe(0);
		expect([...model.nodes.values()].some((node) => node.isRepresentativeFile)).toBe(false);
	});

	it.each([
		['📚 Topic 1', 'Topic 2'],
		['📚 C++', 'C'],
		['📚 Topic-A', 'Topic A'],
		['📚 #1', '1'],
		['📚 Topic', 'Other'],
		['📚', '🧠'],
	])('does not merge different names: %s and %s', (folder, title) => {
		const model = buildWorldMap(recordsFor([`${folder}/${title}.md`]), {}, {}, DEFAULT_RADIAL_SETTINGS);
		expect(model.folderRepresentatives.size).toBe(0);
	});

	it('preserves exact matches for emoji-only names', () => {
		const model = buildWorldMap(recordsFor(['📚/📚.md']), {}, {}, DEFAULT_RADIAL_SETTINGS);
		expect(model.folderRepresentatives.get('📚')).toBe('📚/📚.md');
	});

	it('matches only direct child notes and keeps similar folders distinct', () => {
		const model = buildWorldMap(recordsFor([
			'📚 Atlas/Atlas.md',
			'🧠 Atlas/Atlas.md',
			'🌍 Atlas/Sub/Atlas.md',
			'Atlas.md',
		]), {}, {}, DEFAULT_RADIAL_SETTINGS);
		expect([...model.folderRepresentatives]).toEqual([
			['📚 Atlas', '📚 Atlas/Atlas.md'],
			['🧠 Atlas', '🧠 Atlas/Atlas.md'],
		]);
	});

	it.each(['atlas', 'focus'] as const)('folds the note and redirects links, focus and counts in %s mode', (mode) => {
		const folder = '📚 学习';
		const note = `${folder}/学习.md`;
		const child = `${folder}/子笔记.md`;
		const model = buildWorldMap(recordsFor([note, child]), {
			[note]: { [child]: 2 },
			[child]: { [note]: 3 },
		}, {}, DEFAULT_RADIAL_SETTINGS);
		const graph = buildVisibleWorldGraph(model, {
			...defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS),
			mode,
			focusPath: note,
			showCompleteRoot: true,
			showLinkOverlay: true,
			hiddenLegendItems: [],
		}, DEFAULT_RADIAL_SETTINGS);
		expect(graph.nodes.map((node) => node.id)).toEqual(['', folder, child]);
		expect(graph.linkEdges).toEqual(expect.arrayContaining([
			expect.objectContaining({ source: folder, target: child, weight: 2 }),
			expect.objectContaining({ source: child, target: folder, weight: 3 }),
		]));
		expect(graph.hierarchyEdges.some((edge) => edge.source === note || edge.target === note)).toBe(false);
		expect(visualNodeId(model, note)).toBe(folder);
		if (mode === 'focus') expect(graph.focusId).toBe(folder);
		expect(buildSubtreeNodeCounts(model).get(folder)).toBe(2);
		expect(model.nodes.get(folder)?.noteCount).toBe(2);
	});
});
