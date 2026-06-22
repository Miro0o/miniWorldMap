import { describe, expect, it } from 'vitest';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { ROOT_ID } from '../src/world/types';
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
	const settings = { ...DEFAULT_RADIAL_SETTINGS, ...overrides };
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

	it('keeps large same-depth subtrees spread across their inherited fan', () => {
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

		expect(angleSpreadAround(big?.angle ?? 0, bigChildAngles)).toBeGreaterThan(3.4);
	});

	it('keeps deep hierarchy rings compact when arc space is available', () => {
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
		const averageGap = ((hierarchyRings[hierarchyRings.length - 1]?.radius ?? 0) - (hierarchyRings[0]?.radius ?? 0)) / Math.max(1, hierarchyRings.length - 1);

		expect(layout.ringSpacing).toBeLessThan(900);
		expect(averageGap).toBeLessThan(760);
	});

	it('lets delayed deep branches spend the wedge they carried outward', () => {
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

		expect(angleSpreadAround(parent?.angle ?? 0, leaves)).toBeGreaterThan(4.4);
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

		expect(angleSpreadAround(parent?.angle ?? 0, leaves)).toBeGreaterThan(3.6);
		expect(Math.max(...routeSteps)).toBeLessThan(1.15);
		expect(Math.max(...leafDeltas)).toBeLessThan(2.45);
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
