import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { layoutRadialGraph, type RadialLayout } from '../src/layout/radial/layoutRadial';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { ROOT_ID, type VisibleWorldGraph } from '../src/world/types';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';

const records = [
	{ path: 'Atlas', basename: 'Atlas', kind: 'folder' as const },
	{ path: 'Atlas/Atlas.md', basename: 'Atlas', kind: 'note' as const },
	{ path: 'Atlas/Topic A.md', basename: 'Topic A', kind: 'note' as const },
	{ path: 'Atlas/Sub', basename: 'Sub', kind: 'folder' as const },
	{ path: 'Atlas/Sub/Topic B.md', basename: 'Topic B', kind: 'note' as const },
	{ path: 'Outside/Other.md', basename: 'Other', kind: 'note' as const },
	{ path: '.obsidian/Hidden.md', basename: 'Hidden', kind: 'note' as const },
];

function model(overrides: Partial<typeof DEFAULT_RADIAL_SETTINGS> = {}) {
	const settings = { ...DEFAULT_RADIAL_SETTINGS, ignoreFolders: [...DEFAULT_RADIAL_SETTINGS.ignoreFolders, '.obsidian'], ...overrides };
	return buildWorldMap(
		records,
		{
			'Atlas/Topic A.md': { 'Atlas/Sub/Topic B.md': 2, 'Outside/Other.md': 1 },
			'Outside/Other.md': { 'Atlas/Topic A.md': 1 },
		},
		{
			'Atlas/Topic A.md': { Missing: 1 },
		},
		settings,
	);
}

function angleDelta(a: number, b: number): number {
	const full = Math.PI * 2;
	const delta = ((a - b + Math.PI) % full + full) % full - Math.PI;
	return Math.abs(delta);
}

function signedAngleDelta(a: number, b: number): number {
	const full = Math.PI * 2;
	return ((a - b + Math.PI) % full + full) % full - Math.PI;
}

function angleSpreadAround(center: number, angles: number[]): number {
	const deltas = angles.map((angle) => signedAngleDelta(angle, center));
	return Math.max(...deltas) - Math.min(...deltas);
}

function hierarchyRouteCrossings(graph: VisibleWorldGraph, layout: RadialLayout): number {
	const segments: {
		edge: VisibleWorldGraph['hierarchyEdges'][number];
		source: { x: number; y: number };
		target: { x: number; y: number };
	}[] = [];
	for (const edge of graph.hierarchyEdges) {
		const source = layout.positions.get(edge.source);
		const target = layout.positions.get(edge.target);
		if (source && target) segments.push({ edge, source, target });
	}
	let crossings = 0;
	for (let i = 0; i < segments.length; i++) {
		for (let j = i + 1; j < segments.length; j++) {
			const a = segments[i]!;
			const b = segments[j]!;
			if (a.edge.source === b.edge.source || a.edge.source === b.edge.target || a.edge.target === b.edge.source || a.edge.target === b.edge.target) continue;
			if (segmentsIntersect(a.source, a.target, b.source, b.target)) crossings++;
		}
	}
	return crossings;
}

function segmentsIntersect(
	a: { x: number; y: number },
	b: { x: number; y: number },
	c: { x: number; y: number },
	d: { x: number; y: number },
): boolean {
	const abC = cross(a, b, c);
	const abD = cross(a, b, d);
	const cdA = cross(c, d, a);
	const cdB = cross(c, d, b);
	return abC * abD < -0.000001 && cdA * cdB < -0.000001;
}

function cross(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

describe('world-map model', () => {
	it('indexes folders, notes, representatives, unresolved links, and ignored folders', () => {
		const m = model();
		expect(m.nodes.has(ROOT_ID)).toBe(true);
		expect(m.nodes.has('Atlas')).toBe(true);
		expect(m.nodes.has('Atlas/Topic A.md')).toBe(true);
		expect(m.nodes.has('.obsidian/Hidden.md')).toBe(false);
		expect(m.nodes.get('Atlas')?.representativeFile).toBe('Atlas/Atlas.md');
		expect(m.nodes.get('Atlas/Atlas.md')?.isRepresentativeFile).toBe(true);
		expect([...m.nodes.values()].filter((node) => node.type === 'unresolved')).toHaveLength(1);
		expect(m.stats.notes).toBe(4);
	});

	it('can omit unresolved nodes', () => {
		const m = model({ includeUnresolvedLinks: false });
		expect([...m.nodes.values()].filter((node) => node.type === 'unresolved')).toHaveLength(0);
	});
});

describe('visible world graph', () => {
	it('builds an atlas graph with hierarchy edges and representative folding', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = true;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(graph.rootId).toBe('Atlas');
		expect(graph.nodesById.has('Atlas/Atlas.md')).toBe(false);
		expect(graph.hierarchyEdges.length).toBeGreaterThan(0);
		expect(graph.linkEdges.length).toBeGreaterThan(0);
	});

	it('creates grouped and exact outside-root proxies', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = true;
		state.externalDetailMode = 'grouped';
		const grouped = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(grouped.nodes.some((node) => node.type === 'external' && !node.externalProxy)).toBe(true);
		expect(grouped.nodes.some((node) => node.externalProxy)).toBe(false);

		state.externalDetailMode = 'exact';
		const exact = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(exact.nodes.some((node) => node.externalProxy)).toBe(true);
	});

	it('keeps hover links available when the visible link overlay is off', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = false;
		state.showExternalLinks = false;
		state.hoverHighlightMode = 'note-links';
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(graph.linkEdges).toHaveLength(0);
		expect(graph.hoverLinkEdges.length).toBeGreaterThan(0);
	});

	it('builds a focus graph around the active note', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.mode = 'focus';
		state.focusPath = 'Atlas/Topic A.md';
		state.showLinkOverlay = true;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		expect(graph.focusId).toBe('Atlas/Topic A.md');
		expect(graph.nodesById.has('Atlas/Sub/Topic B.md')).toBe(true);
	});

	it('expands the complete root atlas across depth and link budgets', () => {
		const deepRecords: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Deep', basename: 'Deep', kind: 'folder' },
		];
		let current = 'Deep';
		for (let index = 0; index < 8; index++) {
			current = `${current}/Layer ${index}`;
			deepRecords.push({ path: current, basename: `Layer ${index}`, kind: 'folder' });
		}
		const deepNote = `${current}/Deep.md`;
		deepRecords.push({ path: deepNote, basename: 'Deep', kind: 'note' });
		for (let index = 0; index < 4; index++) {
			deepRecords.push({ path: `Note ${index}.md`, basename: `Note ${index}`, kind: 'note' });
		}
		const resolvedLinks = {
			[deepNote]: Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`Note ${index}.md`, 1])),
		};
		const m = buildWorldMap(deepRecords, resolvedLinks, {}, DEFAULT_RADIAL_SETTINGS);
		const limitedState = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		limitedState.atlasDepth = 1;
		limitedState.linkLimit = 1;
		limitedState.showLinkOverlay = true;
		const limited = buildVisibleWorldGraph(m, limitedState, DEFAULT_RADIAL_SETTINGS);

		const completeState = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		completeState.atlasDepth = 1;
		completeState.linkLimit = 1;
		completeState.showLinkOverlay = true;
		completeState.showCompleteRoot = true;
		const complete = buildVisibleWorldGraph(m, completeState, DEFAULT_RADIAL_SETTINGS);

		expect(limited.nodesById.has(deepNote)).toBe(false);
		expect(limited.linkEdges).toHaveLength(1);
		expect(complete.nodesById.has(deepNote)).toBe(true);
		expect(complete.hiddenNodeCount).toBe(0);
		expect(complete.linkEdges).toHaveLength(4);
	});
});

describe('radial layout', () => {
	it('keeps the root centered and ring depths ordered', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Atlas';
		state.showLinkOverlay = true;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const root = layout.positions.get(graph.rootId);
		expect(root?.x).toBeCloseTo(layout.centerX);
		expect(root?.y).toBeCloseTo(layout.centerY);
		expect([...layout.positions.values()].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
		const radii = layout.rings.map((ring) => ring.radius);
		expect(radii).toEqual([...radii].sort((a, b) => a - b));
	});

	it('keeps folder descendants outside their parent folder rings', () => {
		const m = model();
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = ROOT_ID;
		state.showLinkOverlay = false;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const root = layout.positions.get(ROOT_ID);
		const atlas = layout.positions.get('Atlas');
		const sub = layout.positions.get('Atlas/Sub');
		const topic = layout.positions.get('Atlas/Sub/Topic B.md');

		expect(root?.radius).toBeCloseTo(0);
		expect(atlas?.radius).toBeGreaterThan(root?.radius ?? -1);
		expect(sub?.radius).toBeGreaterThan(atlas?.radius ?? -1);
		expect(topic?.radius).toBeGreaterThan(sub?.radius ?? -1);
		expect(atlas?.depth).toBe(1);
		expect(sub?.depth).toBe(2);
		expect(topic?.depth).toBe(3);
	});

	it('keeps descendant branches approximately aligned with their parents', () => {
		const branchRecords = [
			{ path: 'Alpha', basename: 'Alpha', kind: 'folder' as const },
			{ path: 'Alpha/One.md', basename: 'One', kind: 'note' as const },
			{ path: 'Alpha/Two.md', basename: 'Two', kind: 'note' as const },
			{ path: 'Alpha/Sub', basename: 'Sub', kind: 'folder' as const },
			{ path: 'Alpha/Sub/Deep.md', basename: 'Deep', kind: 'note' as const },
			{ path: 'Beta', basename: 'Beta', kind: 'folder' as const },
			{ path: 'Beta/One.md', basename: 'One', kind: 'note' as const },
			{ path: 'Beta/Two.md', basename: 'Two', kind: 'note' as const },
			{ path: 'Gamma', basename: 'Gamma', kind: 'folder' as const },
			{ path: 'Gamma/One.md', basename: 'One', kind: 'note' as const },
		];
		const m = buildWorldMap(branchRecords, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const alpha = layout.positions.get('Alpha');
		const alphaSub = layout.positions.get('Alpha/Sub');
		const deep = layout.positions.get('Alpha/Sub/Deep.md');
		const beta = layout.positions.get('Beta');
		const betaOne = layout.positions.get('Beta/One.md');

		expect(angleDelta(alphaSub?.angle ?? 0, alpha?.angle ?? 0)).toBeLessThan(0.9);
		expect(angleDelta(deep?.angle ?? 0, alphaSub?.angle ?? 0)).toBeLessThan(0.9);
		expect(angleDelta(betaOne?.angle ?? 0, beta?.angle ?? 0)).toBeLessThan(0.9);
	});

	it('fans crowded siblings around the parent ray instead of stacking them on one angle', () => {
		const childRecords = Array.from({ length: 28 }, (_, index) => ({
			path: `Topic/Child ${index}.md`,
			basename: `Child ${index}`,
			kind: 'note' as const,
		}));
		const m = buildWorldMap(
			[{ path: 'Topic', basename: 'Topic', kind: 'folder' as const }, ...childRecords],
			{},
			{},
			DEFAULT_RADIAL_SETTINGS,
		);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const parent = layout.positions.get('Topic');

		const childDeltas = childRecords.map((record) => signedAngleDelta(layout.positions.get(record.path)?.angle ?? 0, parent?.angle ?? 0));
		const absoluteDeltas = childDeltas.map(Math.abs);
		const roundedAngles = new Set(childRecords.map((record) => Math.round((layout.positions.get(record.path)?.angle ?? 0) * 100)));
		expect(Math.max(...absoluteDeltas)).toBeLessThan(3.05);
		expect(Math.max(...childDeltas) - Math.min(...childDeltas)).toBeGreaterThan(4.6);
		expect(roundedAngles.size).toBeGreaterThan(18);
	});

	it('keeps a deep route from spiraling across unrelated angles', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [{ path: 'Core', basename: 'Core', kind: 'folder' }];
		for (let branch = 0; branch < 12; branch++) {
			const branchPath = `Core/Branch ${branch}`;
			records.push({ path: branchPath, basename: `Branch ${branch}`, kind: 'folder' as const });
			for (let section = 0; section < 8; section++) {
				const sectionPath = `${branchPath}/Section ${section}`;
				records.push({ path: sectionPath, basename: `Section ${section}`, kind: 'folder' as const });
				for (let topic = 0; topic < 6; topic++) {
					const topicPath = `${sectionPath}/Topic ${topic}`;
					records.push({ path: topicPath, basename: `Topic ${topic}`, kind: 'folder' as const });
					records.push({ path: `${topicPath}/Leaf ${topic}.md`, basename: `Leaf ${topic}`, kind: 'note' as const });
				}
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const route = [
			'Core',
			'Core/Branch 5',
			'Core/Branch 5/Section 4',
			'Core/Branch 5/Section 4/Topic 3',
			'Core/Branch 5/Section 4/Topic 3/Leaf 3.md',
		].map((id) => layout.positions.get(id)?.angle ?? 0);
		const stepDeltas = route.slice(1).map((angle, index) => angleDelta(angle, route[index] ?? 0));
		const branchAngles = Array.from({ length: 12 }, (_, index) => layout.positions.get(`Core/Branch ${index}`)?.angle ?? 0);

		expect(angleSpreadAround(layout.positions.get('Core')?.angle ?? 0, branchAngles)).toBeGreaterThan(4.2);
		expect(Math.max(...stepDeltas)).toBeLessThan(1.16);
		expect(angleSpreadAround(route[0] ?? 0, route)).toBeLessThan(1.9);
	});

	it('keeps large same-depth subtrees spread across a controlled arc', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Hub', basename: 'Hub', kind: 'folder' },
			{ path: 'Hub/Big', basename: 'Big', kind: 'folder' },
			{ path: 'Hub/Small A', basename: 'Small A', kind: 'folder' },
			{ path: 'Hub/Small B', basename: 'Small B', kind: 'folder' },
			{ path: 'Hub/Small C', basename: 'Small C', kind: 'folder' },
			{ path: 'Hub/Small A/Leaf.md', basename: 'Leaf', kind: 'note' },
			{ path: 'Hub/Small B/Leaf.md', basename: 'Leaf', kind: 'note' },
			{ path: 'Hub/Small C/Leaf.md', basename: 'Leaf', kind: 'note' },
		];
		for (let index = 0; index < 18; index++) {
			records.push({ path: `Hub/Big/Topic ${index}.md`, basename: `Topic ${index}`, kind: 'note' });
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const big = layout.positions.get('Hub/Big');
		const bigChildAngles = Array.from({ length: 18 }, (_, index) => layout.positions.get(`Hub/Big/Topic ${index}.md`)?.angle ?? 0);

		const spread = angleSpreadAround(big?.angle ?? 0, bigChildAngles);
		expect(spread).toBeGreaterThan(0.55);
		expect(spread).toBeLessThan(1.4);
	});

	it('spends extra radius on deep hierarchy bands while preserving inner ring spacing', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [{ path: 'Root', basename: 'Root', kind: 'folder' }];
		for (let branch = 0; branch < 10; branch++) {
			const branchPath = `Root/Branch ${branch}`;
			records.push({ path: branchPath, basename: `Branch ${branch}`, kind: 'folder' });
			for (let depth = 0; depth < 5; depth++) {
				const path = `${branchPath}/${Array.from({ length: depth + 1 }, (_, index) => `Layer ${index}`).join('/')}`;
				records.push({ path, basename: `Layer ${depth}`, kind: 'folder' });
				records.push({ path: `${path}/Leaf ${branch}-${depth}.md`, basename: `Leaf ${branch}-${depth}`, kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const hierarchyRings = layout.rings.filter((ring) => ring.depth > 0).sort((a, b) => a.depth - b.depth);
		const gaps = hierarchyRings.slice(1).map((ring, index) => ring.radius - (hierarchyRings[index]?.radius ?? 0));
		const averageGap = ((hierarchyRings[hierarchyRings.length - 1]?.radius ?? 0) - (hierarchyRings[0]?.radius ?? 0)) / Math.max(1, hierarchyRings.length - 1);
		const innerGaps = gaps.slice(0, 1);
		const middleGaps = gaps.slice(1, 4);
		const outerGaps = gaps.slice(-3);
		const averageOuterGap = outerGaps.reduce((sum, gap) => sum + gap, 0) / Math.max(1, outerGaps.length);

		expect(layout.ringSpacing).toBeLessThan(900);
		expect(Math.min(...gaps)).toBeGreaterThan(layout.ringSpacing * 0.78);
		expect(Math.max(...innerGaps)).toBeLessThan(layout.ringSpacing * 1.55);
		expect(Math.max(...middleGaps)).toBeGreaterThan(layout.ringSpacing * 1.55);
		expect(averageGap).toBeGreaterThan(layout.ringSpacing * 1.55);
		expect(averageOuterGap).toBeGreaterThan(layout.ringSpacing * 1.95);
	});

	it('gives crowded middle rings extra radial room on large maps', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [{ path: 'Topic', basename: 'Topic', kind: 'folder' }];
		for (let branch = 0; branch < 14; branch++) {
			const branchPath = `Topic/Branch ${branch}`;
			records.push({ path: branchPath, basename: `Branch ${branch}`, kind: 'folder' });
			for (let group = 0; group < 14; group++) {
				const groupPath = `${branchPath}/Group ${group}`;
				const hubPath = `${groupPath}/Hub`;
				records.push({ path: groupPath, basename: `Group ${group}`, kind: 'folder' });
				records.push({ path: hubPath, basename: 'Hub', kind: 'folder' });
				records.push({ path: `${hubPath}/Leaf.md`, basename: 'Leaf', kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Topic';
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const ringsByDepth = new Map(layout.rings.map((ring) => [ring.depth, ring.radius]));
		const firstGap = (ringsByDepth.get(1) ?? 0) - (ringsByDepth.get(0) ?? 0);
		const middleGap = (ringsByDepth.get(2) ?? 0) - (ringsByDepth.get(1) ?? 0);
		const laterMiddleGap = (ringsByDepth.get(3) ?? 0) - (ringsByDepth.get(2) ?? 0);

		expect(firstGap).toBeGreaterThan(layout.ringSpacing * 0.9);
		expect(middleGap).toBeGreaterThan(layout.ringSpacing * 1.35);
		expect(laterMiddleGap).toBeGreaterThan(layout.ringSpacing * 1.35);
	});

	it('keeps crowded baseline rings dominant while sparse deep tails form radial bands', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [];
		for (let index = 0; index < 180; index++) {
			records.push({ path: `Entry ${index}.md`, basename: `Entry ${index}`, kind: 'note' });
		}
		let deepPath = 'Deep';
		records.push({ path: deepPath, basename: 'Deep', kind: 'folder' });
		for (let depth = 0; depth < 8; depth++) {
			deepPath = `${deepPath}/Layer ${depth}`;
			records.push({ path: deepPath, basename: `Layer ${depth}`, kind: 'folder' });
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.atlasDepth = 20;
		state.nodeLimit = 1000;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const ringsByDepth = new Map(layout.rings.map((ring) => [ring.depth, ring.radius]));
		const sparseGaps = [4, 5, 6, 7, 8]
			.map((depth) => (ringsByDepth.get(depth) ?? 0) - (ringsByDepth.get(depth - 1) ?? 0))
			.filter((gap) => gap > 0);
		const averageSparseGap = sparseGaps.reduce((sum, gap) => sum + gap, 0) / Math.max(1, sparseGaps.length);
		const lateSparseGaps = [7, 8, 9]
			.map((depth) => (ringsByDepth.get(depth) ?? 0) - (ringsByDepth.get(depth - 1) ?? 0))
			.filter((gap) => gap > 0);
		const averageLateSparseGap = lateSparseGaps.reduce((sum, gap) => sum + gap, 0) / Math.max(1, lateSparseGaps.length);

		expect(ringsByDepth.get(1) ?? 0).toBeGreaterThan(averageSparseGap * 3);
		expect(averageSparseGap).toBeGreaterThan(layout.ringSpacing * 1.2);
		expect(averageLateSparseGap).toBeGreaterThan(averageSparseGap * 1.16);
	});

	it('allocates more root angle to dense early subtrees', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Root', basename: 'Root', kind: 'folder' },
			{ path: 'Root/Dense', basename: 'Dense', kind: 'folder' },
		];
		for (let group = 0; group < 14; group++) {
			const groupPath = `Root/Dense/Group ${group}`;
			records.push({ path: groupPath, basename: `Group ${group}`, kind: 'folder' });
			for (let leaf = 0; leaf < 6; leaf++) {
				records.push({ path: `${groupPath}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' });
			}
		}
		for (let index = 0; index < 7; index++) {
			const sparsePath = `Root/Sparse ${index}`;
			records.push({ path: sparsePath, basename: `Sparse ${index}`, kind: 'folder' });
			records.push({ path: `${sparsePath}/Note.md`, basename: 'Note', kind: 'note' });
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Root';
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const denseSpan = layout.positions.get('Root/Dense')?.sectorSpan ?? 0;
		const denseAngle = layout.positions.get('Root/Dense')?.angle ?? 0;
		const denseGroupAngles = Array.from({ length: 14 }, (_, index) => layout.positions.get(`Root/Dense/Group ${index}`)?.angle ?? denseAngle);
		const denseGroupSpread = angleSpreadAround(denseAngle, denseGroupAngles);
		const sparseSpans = Array.from({ length: 7 }, (_, index) => layout.positions.get(`Root/Sparse ${index}`)?.sectorSpan ?? 0);
		const averageSparseSpan = sparseSpans.reduce((sum, span) => sum + span, 0) / Math.max(1, sparseSpans.length);

		expect(denseSpan).toBeGreaterThan(Math.PI);
		expect(denseSpan).toBeGreaterThan(averageSparseSpan * 24);
		expect(denseGroupSpread).toBeGreaterThan(Math.min(denseSpan * 0.62, Math.PI * 1.25));
		expect(hierarchyRouteCrossings(graph, layout)).toBe(0);
	});

	it('keeps a crowded lower perimeter expanded when one branch continues deeper', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [{ path: 'Map', basename: 'Map', kind: 'folder' }];
		for (let area = 0; area < 18; area++) {
			const areaPath = `Map/Area ${area}`;
			const shelfPath = `${areaPath}/Shelf`;
			const clusterPath = `${shelfPath}/Cluster`;
			records.push({ path: areaPath, basename: `Area ${area}`, kind: 'folder' });
			records.push({ path: shelfPath, basename: 'Shelf', kind: 'folder' });
			records.push({ path: clusterPath, basename: 'Cluster', kind: 'folder' });
			for (let leaf = 0; leaf < 5; leaf++) {
				records.push({ path: `${clusterPath}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' });
			}
		}
		let deepPath = 'Map/Deep';
		records.push({ path: deepPath, basename: 'Deep', kind: 'folder' });
		const routeIds = [deepPath];
		for (let depth = 0; depth < 8; depth++) {
			deepPath = `${deepPath}/Layer ${depth}`;
			records.push({ path: deepPath, basename: `Layer ${depth}`, kind: 'folder' });
			routeIds.push(deepPath);
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Map';
		state.showLinkOverlay = false;
		state.atlasDepth = 20;
		state.nodeLimit = 2500;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const ringsByDepth = new Map(layout.rings.map((ring) => [ring.depth, ring.radius]));
		const lowerPerimeterGap = (ringsByDepth.get(4) ?? 0) - (ringsByDepth.get(3) ?? 0);
		const previousGap = (ringsByDepth.get(3) ?? 0) - (ringsByDepth.get(2) ?? 0);
		const routeRadii = routeIds.map((id) => layout.positions.get(id)?.radius ?? 0);
		const routeAngles = routeIds.map((id) => layout.positions.get(id)?.angle ?? 0);
		const angleSteps = routeAngles.slice(1).map((angle, index) => angleDelta(angle, routeAngles[index] ?? 0));

		expect(lowerPerimeterGap).toBeGreaterThan(previousGap * 1.18);
		expect(lowerPerimeterGap).toBeGreaterThan(layout.ringSpacing * 1.45);
		expect((routeRadii[routeRadii.length - 1] ?? 0) - (ringsByDepth.get(4) ?? 0)).toBeLessThan(layout.ringSpacing * 18);
		expect(routeRadii).toEqual([...routeRadii].sort((a, b) => a - b));
		expect(Math.max(...angleSteps)).toBeLessThan(0.36);
		expect(hierarchyRouteCrossings(graph, layout)).toBe(0);
	});

	it('keeps narrow deep routes growing outward on sparse outer rings', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [];
		for (let index = 0; index < 160; index++) {
			records.push({ path: `Crowd ${index}.md`, basename: `Crowd ${index}`, kind: 'note' });
		}
		let path = 'Atlas';
		records.push({ path, basename: 'Atlas', kind: 'folder' });
		const routeIds = [path];
		for (let depth = 0; depth < 9; depth++) {
			path = `${path}/Topic ${depth}`;
			records.push({ path, basename: `Topic ${depth}`, kind: 'folder' });
			routeIds.push(path);
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.atlasDepth = 20;
		state.nodeLimit = 1000;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const routeRadii = routeIds.map((id) => layout.positions.get(id)?.radius ?? 0);
		const routeAngles = routeIds.map((id) => layout.positions.get(id)?.angle ?? 0);
		const outerSteps = routeRadii.slice(3).map((radius, index) => radius - (routeRadii[index + 2] ?? 0));
		const angleSteps = routeAngles.slice(1).map((angle, index) => angleDelta(angle, routeAngles[index] ?? 0));

		expect(Math.min(...outerSteps)).toBeGreaterThan(layout.ringSpacing * 0.36);
		expect(Math.max(...angleSteps)).toBeLessThan(0.36);
		expect(routeRadii).toEqual([...routeRadii].sort((a, b) => a - b));
		expect(hierarchyRouteCrossings(graph, layout)).toBe(0);
	});

	it('keeps vault-root outer hierarchy routes advancing outward near the perimeter', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [];
		for (let area = 0; area < 18; area++) {
			const areaPath = `Area ${area}`;
			records.push({ path: areaPath, basename: `Area ${area}`, kind: 'folder' });
			for (let section = 0; section < 7; section++) {
				const sectionPath = `${areaPath}/Section ${section}`;
				records.push({ path: sectionPath, basename: `Section ${section}`, kind: 'folder' });
				for (let leaf = 0; leaf < 2; leaf++) {
					records.push({ path: `${sectionPath}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' });
				}
			}
		}
		const routeBase = 'U.S. Social Development';
		const routeMid = `${routeBase}/U.S. Tertiary Education`;
		const routeHub = `${routeMid}/U.S. Sports Institutions`;
		records.push({ path: routeBase, basename: 'U.S. Social Development', kind: 'folder' });
		records.push({ path: routeMid, basename: 'U.S. Tertiary Education', kind: 'folder' });
		records.push({ path: routeHub, basename: 'U.S. Sports Institutions', kind: 'folder' });
		for (const league of ['NBA', 'NFL', 'NHL', 'MLB', 'MLS', 'NCAA']) {
			records.push({ path: `${routeHub}/${league}.md`, basename: `${league} (National League)`, kind: 'note' });
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = ROOT_ID;
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const maxDepth = Math.max(...[...layout.positions.values()].filter((point) => !point.external).map((point) => Math.round(point.depth || 0)));
		const outerSteps = graph.hierarchyEdges
			.map((edge) => ({ source: layout.positions.get(edge.source), target: layout.positions.get(edge.target) }))
			.filter((edge): edge is { source: NonNullable<typeof edge.source>; target: NonNullable<typeof edge.target> } =>
				Boolean(edge.source && edge.target && !edge.source.external && !edge.target.external && Math.round(edge.target.depth || 0) >= maxDepth - 1),
			)
			.map((edge) => edge.target.radius - edge.source.radius);

		expect(outerSteps.length).toBeGreaterThan(0);
		expect(Math.min(...outerSteps)).toBeGreaterThan(layout.ringSpacing * 0.54);
	});

	it('lets delayed deep branches spend a controlled arc instead of a spiral wedge', () => {
		const deepBase = 'Trunk/Branch/Layer A/Layer B/Layer C';
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Trunk', basename: 'Trunk', kind: 'folder' },
			{ path: 'Trunk/Branch', basename: 'Branch', kind: 'folder' },
			{ path: 'Trunk/Branch/Layer A', basename: 'Layer A', kind: 'folder' },
			{ path: 'Trunk/Branch/Layer A/Layer B', basename: 'Layer B', kind: 'folder' },
			{ path: deepBase, basename: 'Layer C', kind: 'folder' },
		];
		for (let leaf = 0; leaf < 18; leaf++) {
			records.push({ path: `${deepBase}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' });
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const parent = layout.positions.get(deepBase);
		const leaves = Array.from({ length: 18 }, (_, index) => layout.positions.get(`${deepBase}/Leaf ${index}.md`)?.angle ?? 0);
		const spread = angleSpreadAround(parent?.angle ?? 0, leaves);

		expect(spread).toBeGreaterThan(0.55);
		expect(spread).toBeLessThan(1.3);
	});

	it('lets the final visible ring spend radius before widening deep leaf fans', () => {
		const hubs = ['Alpha', 'Beta'];
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Topic', basename: 'Topic', kind: 'folder' },
		];
		for (const hub of hubs) {
			const branchPath = `Topic/${hub}`;
			const lanePath = `${branchPath}/Lane`;
			const hubPath = `${lanePath}/Hub`;
			records.push({ path: branchPath, basename: hub, kind: 'folder' });
			records.push({ path: lanePath, basename: 'Lane', kind: 'folder' });
			records.push({ path: hubPath, basename: 'Hub', kind: 'folder' });
			for (let leaf = 0; leaf < 36; leaf++) {
				records.push({ path: `${hubPath}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Topic';
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const ringsByDepth = new Map(layout.rings.map((ring) => [ring.depth, ring.radius]));
		const finalGap = (ringsByDepth.get(4) ?? 0) - (ringsByDepth.get(3) ?? 0);

		for (const hub of hubs) {
			const parent = layout.positions.get(`Topic/${hub}/Lane/Hub`);
			const leaves = Array.from({ length: 36 }, (_, index) => layout.positions.get(`Topic/${hub}/Lane/Hub/Leaf ${index}.md`)?.angle ?? 0);
			const spread = angleSpreadAround(parent?.angle ?? 0, leaves);

			expect(spread).toBeGreaterThan(0.7);
			expect(spread).toBeLessThan(1.45);
		}
		expect(finalGap).toBeGreaterThan(layout.ringSpacing * 1.05);
		expect(hierarchyRouteCrossings(graph, layout)).toBe(0);
	});

	it('relaxes the penultimate visible baseline ring before the map edge', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Topic', basename: 'Topic', kind: 'folder' },
		];
		for (let group = 0; group < 8; group++) {
			const groupPath = `Topic/Group ${group}`;
			records.push({ path: groupPath, basename: `Group ${group}`, kind: 'folder' });
			for (let hub = 0; hub < 10; hub++) {
				const hubPath = `${groupPath}/Hub ${hub}`;
				records.push({ path: hubPath, basename: `Hub ${hub}`, kind: 'folder' });
				records.push({ path: `${hubPath}/Leaf.md`, basename: 'Leaf', kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Topic';
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const ringsByDepth = new Map(layout.rings.map((ring) => [ring.depth, ring.radius]));
		const penultimateGap = (ringsByDepth.get(2) ?? 0) - (ringsByDepth.get(1) ?? 0);
		const finalGap = (ringsByDepth.get(3) ?? 0) - (ringsByDepth.get(2) ?? 0);

		expect(penultimateGap).toBeGreaterThan(layout.ringSpacing * 1.34);
		expect(finalGap).toBeGreaterThan(layout.ringSpacing * 1.5);
	});

	it('keeps grouped and exact outside nodes beyond the regular map shell', () => {
		for (const mode of ['grouped', 'exact'] as const) {
			const m = model();
			const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
			state.rootPath = 'Atlas';
			state.showLinkOverlay = true;
			state.showExternalLinks = true;
			state.externalDetailMode = mode;
			const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
			const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
			const regularRadii = graph.nodes
				.filter((node) => node.type !== 'external' && !node.externalProxy)
				.map((node) => layout.positions.get(node.id)?.radius ?? 0);
			const outsideRadii = graph.nodes
				.filter((node) => node.type === 'external' || node.externalProxy)
				.map((node) => layout.positions.get(node.id)?.radius ?? 0);
			const maxRegularRadius = Math.max(...regularRadii);
			const minOutsideRadius = Math.min(...outsideRadii);

			expect(outsideRadii.length).toBeGreaterThan(0);
			expect(minOutsideRadius).toBeGreaterThan(maxRegularRadius + layout.ringSpacing * 0.42);
			if (mode === 'exact') {
				const groupRadii = graph.nodes
					.filter((node) => node.type === 'external' && !node.externalProxy)
					.map((node) => layout.positions.get(node.id)?.radius ?? 0);
				const fileRadii = graph.nodes
					.filter((node) => node.externalProxy)
					.map((node) => layout.positions.get(node.id)?.radius ?? 0);
				expect(fileRadii.length).toBeGreaterThan(0);
				expect(Math.min(...fileRadii)).toBeGreaterThan(Math.max(...groupRadii) + layout.ringSpacing * 0.24);
			}
		}
	});

	it('scales outside shell distance away from large regular maps', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'CyberSecurity', basename: 'CyberSecurity', kind: 'folder' },
		];
		const resolvedLinks: Record<string, Record<string, number>> = {};
		for (let area = 0; area < 22; area++) {
			const areaPath = `CyberSecurity/Area ${area}`;
			records.push({ path: areaPath, basename: `Area ${area}`, kind: 'folder' });
			for (let topic = 0; topic < 12; topic++) {
				const topicPath = `${areaPath}/Topic ${topic}.md`;
				const outsidePath = `Outside/Reference ${area}-${topic}.md`;
				records.push({ path: topicPath, basename: `Topic ${topic}`, kind: 'note' });
				records.push({ path: outsidePath, basename: `Reference ${area}-${topic}`, kind: 'note' });
				resolvedLinks[topicPath] = { [outsidePath]: 1 };
			}
		}
		const m = buildWorldMap(records, resolvedLinks, {}, DEFAULT_RADIAL_SETTINGS);
		for (const mode of ['grouped', 'exact'] as const) {
			const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
			state.rootPath = 'CyberSecurity';
			state.showLinkOverlay = true;
			state.showExternalLinks = true;
			state.externalDetailMode = mode;
			state.nodeLimit = 1200;
			const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
			const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
			const regularRadii = graph.nodes
				.filter((node) => node.type !== 'external' && !node.externalProxy)
				.map((node) => layout.positions.get(node.id)?.radius ?? 0);
			const outsideRadii = graph.nodes
				.filter((node) => node.type === 'external' || node.externalProxy)
				.map((node) => layout.positions.get(node.id)?.radius ?? 0);
			const maxRegularRadius = Math.max(...regularRadii);
			const minOutsideRadius = Math.min(...outsideRadii);

			expect(outsideRadii.length).toBeGreaterThan(0);
			expect(minOutsideRadius).toBeGreaterThan(maxRegularRadius + Math.max(layout.ringSpacing * 0.72, maxRegularRadius * 0.075));
		}
	});

	it('expands crowded deep fans without throwing the route off its parent ray', () => {
		const crowdedBase = 'Branch 9/Lane/Hub';
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [];
		for (let branch = 0; branch < 22; branch++) {
			const branchPath = `Branch ${branch}`;
			const lanePath = `${branchPath}/Lane`;
			const hubPath = `${lanePath}/Hub`;
			records.push({ path: branchPath, basename: `Branch ${branch}`, kind: 'folder' });
			records.push({ path: lanePath, basename: 'Lane', kind: 'folder' });
			records.push({ path: hubPath, basename: 'Hub', kind: 'folder' });
			const leafCount = branch === 9 ? 24 : 2;
			for (let leaf = 0; leaf < leafCount; leaf++) {
				records.push({ path: `${hubPath}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1600;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const parent = layout.positions.get(crowdedBase);
		const leaves = Array.from({ length: 24 }, (_, index) => layout.positions.get(`${crowdedBase}/Leaf ${index}.md`)?.angle ?? 0);
		const centeredLeafIndex = leaves.reduce(
			(best, angle, index) => (angleDelta(angle, parent?.angle ?? 0) < angleDelta(leaves[best] ?? 0, parent?.angle ?? 0) ? index : best),
			0,
		);
		const middleRoute = [
			'Branch 9',
			'Branch 9/Lane',
			crowdedBase,
			`${crowdedBase}/Leaf ${centeredLeafIndex}.md`,
		].map((id) => layout.positions.get(id)?.angle ?? 0);
		const routeSteps = middleRoute.slice(1).map((angle, index) => angleDelta(angle, middleRoute[index] ?? 0));
		const leafDeltas = leaves.map((angle) => angleDelta(angle, parent?.angle ?? 0));

		const spread = angleSpreadAround(parent?.angle ?? 0, leaves);
		expect(spread).toBeGreaterThan(0.65);
		expect(spread).toBeLessThan(1.5);
		expect(Math.max(...routeSteps)).toBeLessThan(1.15);
		expect(Math.max(...leafDeltas)).toBeLessThan(2.45);
	});

	it('keeps dense leaf fans inside their parent sectors so sibling routes do not cross', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Topic', basename: 'Topic', kind: 'folder' },
			{ path: 'Topic/Alpha', basename: 'Alpha', kind: 'folder' },
			{ path: 'Topic/Beta', basename: 'Beta', kind: 'folder' },
		];
		for (const parent of ['Alpha', 'Beta']) {
			for (let index = 0; index < 18; index++) {
				records.push({ path: `Topic/${parent}/Leaf ${index}.md`, basename: `Leaf ${index}`, kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const alpha = layout.positions.get('Topic/Alpha');
		const beta = layout.positions.get('Topic/Beta');

		for (const parent of ['Alpha', 'Beta']) {
			const parentPoint = layout.positions.get(`Topic/${parent}`);
			const siblingPoint = layout.positions.get(`Topic/${parent === 'Alpha' ? 'Beta' : 'Alpha'}`);
			const leaves = Array.from({ length: 18 }, (_, index) => layout.positions.get(`Topic/${parent}/Leaf ${index}.md`)?.angle ?? 0);
			const maxDelta = Math.max(...leaves.map((angle) => angleDelta(angle, parentPoint?.angle ?? 0)));
			const nearestSiblingDelta = Math.min(...leaves.map((angle) => angleDelta(angle, siblingPoint?.angle ?? 0)));

			expect(maxDelta).toBeLessThan((parentPoint?.sectorSpan ?? Math.PI * 2) * 0.5 + 0.04);
			expect(nearestSiblingDelta).toBeGreaterThan(0.08);
		}

		expect(angleDelta(alpha?.angle ?? 0, beta?.angle ?? 0)).toBeGreaterThan(0.8);
	});

	it('keeps jagged same-depth routes in hierarchy order', () => {
		const parents = ['Alpha', 'Beta', 'Gamma', 'Delta'];
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Topic', basename: 'Topic', kind: 'folder' },
			...parents.map((parent) => ({ path: `Topic/${parent}`, basename: parent, kind: 'folder' as const })),
		];
		for (const parent of parents) {
			for (let index = 0; index < 24; index++) {
				records.push({ path: `Topic/${parent}/Leaf ${index}.md`, basename: `Leaf ${index}`, kind: 'note' });
			}
		}
		const m = buildWorldMap(records, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.rootPath = 'Topic';
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const leafRadii = parents.flatMap((parent) =>
			Array.from({ length: 24 }, (_, index) => layout.positions.get(`Topic/${parent}/Leaf ${index}.md`)?.radius ?? 0),
		);

		expect(Math.max(...leafRadii) - Math.min(...leafRadii)).toBeGreaterThan(25);
		expect(hierarchyRouteCrossings(graph, layout)).toBe(0);
	});

	it('sizes nodes primarily by note-link degree instead of descendant count', () => {
		const records: { path: string; basename: string; kind: 'folder' | 'note' }[] = [
			{ path: 'Archive', basename: 'Archive', kind: 'folder' },
			{ path: 'Linked.md', basename: 'Linked', kind: 'note' },
		];
		for (let index = 0; index < 80; index++) {
			records.push({ path: `Archive/Quiet ${index}.md`, basename: `Quiet ${index}`, kind: 'note' });
			records.push({ path: `Targets/Target ${index}.md`, basename: `Target ${index}`, kind: 'note' });
		}
		const resolvedLinks = Object.fromEntries(
			Array.from({ length: 24 }, (_, index) => [`Targets/Target ${index}.md`, 1]),
		);
		const m = buildWorldMap(records, { 'Linked.md': resolvedLinks }, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = true;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const linked = layout.positions.get('Linked.md');
		const archive = layout.positions.get('Archive');

		expect(linked?.nodeRadius ?? 0).toBeGreaterThan((archive?.nodeRadius ?? 0) * 1.8);
		expect(archive?.nodeRadius ?? 0).toBeLessThan(11);
	});

	it('does not invent hierarchy rings for flat same-parent root notes', () => {
		const crowdedRecords = Array.from({ length: 900 }, (_, index) => ({
			path: `Note ${index}.md`,
			basename: `Note ${index}`,
			kind: 'note' as const,
		}));
		const m = buildWorldMap(crowdedRecords, {}, {}, DEFAULT_RADIAL_SETTINGS);
		const state = defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS);
		state.showLinkOverlay = false;
		state.nodeLimit = 1200;
		const graph = buildVisibleWorldGraph(m, state, DEFAULT_RADIAL_SETTINGS);
		const layout = layoutRadialGraph(graph, { ringSpacing: 960, nodeSpacing: 126, swirlStrength: 0 });
		const nodeRadii = [...layout.positions.entries()]
			.filter(([id]) => id !== graph.rootId)
			.map(([, point]) => point.radius);
		const depthOneRings = layout.rings.filter((ring) => ring.depth === 1);
		const minRadius = Math.min(...nodeRadii);
		const maxRadius = Math.max(...nodeRadii);

		expect(depthOneRings).toHaveLength(1);
		expect(maxRadius - minRadius).toBeLessThan((depthOneRings[0]?.radius ?? 1) * 0.5);
	});
});
