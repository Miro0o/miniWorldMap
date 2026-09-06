import { describe, expect, it } from 'vitest';
import { compactHierarchyBands } from '../src/layout/radial/compactBands';
import { ensureBandCapacity } from '../src/layout/radial/bandCapacity';
import { solveBandConstraints } from '../src/layout/radial/bandConstraints';
import { makePoint, setPointSector } from '../src/layout/radial/geometry';
import type { RadialLayout, RadialPoint } from '../src/layout/radial/types';
import type { VisibleWorldGraph, WorldFileRecord } from '../src/world/types';
import { completeGraph, edgesThroughNodes, hierarchyCrossings, overlappingNodes, sectorViolations } from './helpers/radialFixtures';

function crowdedTree(): VisibleWorldGraph {
	const records: WorldFileRecord[] = [];
	for (let topic = 0; topic < 12; topic++) for (let area = 0; area < 10; area++) for (let note = 0; note < 5; note++) {
		const basename = `Note ${note}`;
		records.push({ path: `Trunk/Topic ${topic}/Area ${area}/${basename}.md`, basename, kind: 'note' });
	}
	for (let branch = 0; branch < 5; branch++) {
		const parent = `Trunk/Topic 0/Area 0/Browser/Branch ${branch}`;
		records.push({ path: `${parent}.md`, basename: `Branch ${branch}`, kind: 'note' });
		for (let note = 0; note < 4; note++) records.push({ path: `${parent}/Part ${note}.md`, basename: `Part ${note}`, kind: 'note' });
	}
	records.push({ path: 'Trunk/Topic 0/Area 0/Browser/Standalone.md', basename: 'Standalone', kind: 'note' });
	return completeGraph(records);
}

function stretchedLayout(graph: VisibleWorldGraph, visualRadius: number): RadialLayout {
	const children = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		const group = children.get(edge.source) ?? [];
		group.push(edge.target);
		children.set(edge.source, group);
	}
	const weights = new Map<string, number>();
	const measure = (id: string): number => {
		const weight = Math.max(1, (children.get(id) ?? []).reduce((sum, child) => sum + measure(child), 0));
		weights.set(id, weight);
		return weight;
	};
	measure(graph.rootId);
	const positions = new Map<string, RadialPoint>();
	const place = (id: string, depth: number, start: number, end: number) => {
		// Reproduce a deep family trapped in a thin inherited sector while
		// the global band steps continue to grow.
		if (id.endsWith('/Browser')) {
			const center = (start + end) / 2, half = (end - start) * 0.015;
			start = center - half;
			end = center + half;
		}
		const point = makePoint(depth * 400_000, (start + end) / 2, depth, visualRadius, false);
		point.ringRadius = point.radius;
		point.ringBandMin = point.radius * 0.98;
		point.ringBandMax = point.radius * 1.02;
		setPointSector(point, start, end);
		positions.set(id, point);
		let cursor = start;
		for (const child of children.get(id) ?? []) {
			const next = cursor + (end - start) * weights.get(child)! / weights.get(id)!;
			place(child, depth + 1, cursor, next);
			cursor = next;
		}
	};
	place(graph.rootId, 0, -Math.PI / 2, Math.PI * 1.5);
	return { positions, rings: [], routes: new Map(), width: 6_000_000, height: 6_000_000,
		bounds: { minX: -3_000_000, minY: -3_000_000, maxX: 3_000_000, maxY: 3_000_000 },
		centerX: 0, centerY: 0, ringSpacing: 1160, nodeSpacing: 144 };
}

describe('compact hierarchy bands', () => {
	it.each([6, 64, 'mixed'] as const)('opens mixed forks and keeps disjoint bands with node radius %s', (visualRadius) => {
		const graph = crowdedTree();
		const layout = stretchedLayout(graph, visualRadius === 'mixed' ? 6 : visualRadius);
		if (visualRadius === 'mixed') {
			let index = 0;
			for (const point of layout.positions.values()) if (index++ % 7 === 0) point.nodeRadius = 64;
		}
		const targets = new Map<number, number>();
		const before = new Map([...layout.positions].map(([id, point]) => [id, { ...point }]));
		expect(compactHierarchyBands(layout.positions, graph, targets, 1160, 144)).toBe(true);
		layout.readableZoom = ensureBandCapacity(layout.positions, graph, targets, 144).readableZoom;
		const bands = new Map<number, { min: number; max: number }>();
		for (const [id, point] of layout.positions) {
			expect(point.depth).toBe(before.get(id)!.depth);
			expect(point.nodeRadius).toBe(before.get(id)!.nodeRadius);
			expect(point.ringRadius).toBe(targets.get(point.depth));
			expect(point.radius).toBeGreaterThanOrEqual(point.ringBandMin!);
			expect(point.radius).toBeLessThanOrEqual(point.ringBandMax!);
			bands.set(point.depth, { min: point.ringBandMin!, max: point.ringBandMax! });
		}
		const ordered = [...bands].sort(([a], [b]) => a - b);
		for (let i = 1; i < ordered.length; i++) {
			expect(ordered[i]![1].min).toBeGreaterThan(ordered[i - 1]![1].max);
			const depth = ordered[i]![0];
			const step = targets.get(depth)! - targets.get(depth - 1)!;
			const previousStep = depth > 1 ? targets.get(depth - 1)! - targets.get(depth - 2)! : step;
			// Expansion eases in from the center; depths remain distinct and the
			// radial progression cannot introduce an abrupt, empty middle jump.
			expect(step).toBeGreaterThanOrEqual(previousStep - 1e-6);
			expect(step).toBeLessThanOrEqual(previousStep * 2.1);
		}
		// Merely disjoint ranges can still pile every depth onto one outer ring.
		// Later baselines must advance by a visible fraction of the dense radius,
		// with an empty interval left between the lanes of neighboring depths.
		for (const [depth, band] of ordered.filter(([depth]) => depth >= 4)) {
			const step = targets.get(depth)! - targets.get(depth - 1)!;
			expect(step).toBeGreaterThanOrEqual(targets.get(3)! * 0.08);
			expect(band.min - bands.get(depth - 1)!.max).toBeGreaterThanOrEqual(step * 0.18);
		}
		const terminalFamilies = Array.from({ length: 5 }, (_, branch) => layout.positions.get(`Trunk/Topic 0/Area 0/Browser/Branch ${branch}/Part 0.md`)!);
		const crowdedBand = [...layout.positions.values()].filter((p) => p.depth === 4);
		const laneWidth = crowdedBand[0]!.ringBandMax! - crowdedBand[0]!.ringBandMin!;
		expect(Math.max(...crowdedBand.map((p) => p.radius)) - Math.min(...crowdedBand.map((p) => p.radius)))
			.toBeGreaterThan(laneWidth * 0.25);
		for (let branch = 0; branch < 5; branch++) for (let part = 1; part < 4; part++) {
			expect(layout.positions.get(`Trunk/Topic 0/Area 0/Browser/Branch ${branch}/Part ${part}.md`)!.radius)
				.toBeCloseTo(terminalFamilies[branch]!.radius, 6);
		}
		const parentId = 'Trunk/Topic 0/Area 0/Browser';
		const children = graph.hierarchyEdges.filter((edge) => edge.source === parentId).map((edge) => edge.target);
		const aspect = (positions: Map<string, RadialPoint>) => {
			const parent = positions.get(parentId)!;
			const points = children.map((id) => positions.get(id)!);
			const lateral = points.map((p) => -(p.x - parent.x) * Math.sin(parent.angle) + (p.y - parent.y) * Math.cos(parent.angle));
			const length = points.reduce((sum, p) => sum + Math.hypot(p.x - parent.x, p.y - parent.y), 0) / points.length;
			return (Math.max(...lateral) - Math.min(...lateral)) / length;
		};
		expect(aspect(layout.positions)).toBeGreaterThan(0.35);
		expect(aspect(layout.positions)).toBeGreaterThan(aspect(before) * 2);
		const screenGap = (positions: Map<string, RadialPoint>, readableZoom = 0) => {
			const entries = [...positions].filter(([id]) => id.startsWith(parentId));
			const xs = entries.map(([, p]) => p.x), ys = entries.map(([, p]) => p.y);
			const zoom = Math.max(readableZoom, Math.min(1400 / (Math.max(...xs) - Math.min(...xs)), 900 / (Math.max(...ys) - Math.min(...ys))));
			// At overview zoom the existing renderer uses approximately 5 / 5.2
			// px note/folder glyphs here, or 14.2 / 16.3 px for maximum-size hubs.
			const diameter = (id: string) => graph.nodesById.get(id)!.type === 'folder'
				? positions.get(id)!.nodeRadius === 64 ? 16.35 : 5.5 : positions.get(id)!.nodeRadius === 64 ? 14.25 : 5;
			let gap = Infinity, clearance = Infinity;
			for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
				const [a, p] = entries[i]!, [b, q] = entries[j]!;
				const distance = Math.hypot(p.x - q.x, p.y - q.y) * zoom;
				gap = Math.min(gap, distance);
				clearance = Math.min(clearance, distance - (diameter(a) + diameter(b)) / 2);
			}
			return { gap, clearance };
		};
		// Initial framing uses the readability floor when a full fit would
		// overlap unchanged glyphs, including the larger linked hubs.
		expect(screenGap(before).gap).toBeLessThan(4.6);
		expect(screenGap(layout.positions, layout.readableZoom).clearance).toBeGreaterThan(0.2);
		const points = [...layout.positions.values()];
		let clearance = Infinity;
		for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
			const p = points[i]!, q = points[j]!;
			clearance = Math.min(clearance, Math.hypot(p.x - q.x, p.y - q.y) - (p.nodeRadius + q.nodeRadius) * 8 - 144 * 3.4);
		}
		expect(clearance).toBeGreaterThanOrEqual(-1e-6);
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
		expect(sectorViolations(graph, layout)).toEqual([]);
	});

	it('keeps a comfortable layout unchanged', () => {
		const graph = completeGraph([{ path: 'Note.md', basename: 'Note', kind: 'note' }]);
		const layout = stretchedLayout(graph, 6);
		for (const point of layout.positions.values()) {
			point.radius /= 400;
			point.x /= 400;
			point.y /= 400;
		}
		const before = [...layout.positions].map(([id, point]) => [id, { ...point }]);
		expect(compactHierarchyBands(layout.positions, graph, new Map(), 1160, 144)).toBe(false);
		expect([...layout.positions]).toEqual(before);
	});

	it('rebuilds crowded bands even when the result needs a larger outer radius', () => {
		const graph = crowdedTree();
		const layout = stretchedLayout(graph, 6);
		for (const point of layout.positions.values()) {
			point.radius /= 5; point.x /= 5; point.y /= 5;
		}
		const oldOuter = Math.max(...[...layout.positions.values()].map((point) => point.radius));
		expect(compactHierarchyBands(layout.positions, graph, new Map(), 1160, 144)).toBe(true);
		expect(Math.max(...[...layout.positions.values()].map((point) => point.radius))).toBeGreaterThan(oldOuter);
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
	});
});

describe('band angle constraints', () => {
	it('centers a family while neighboring descendants yield within their spacing bounds', () => {
		const constraints = [
			{ a: 0, b: 1, base: -0.7, extra: 0 }, { a: 1, b: 0, base: -0.7, extra: 0 },
			{ a: 0, b: 2, base: -0.7, extra: 0 }, { a: 2, b: 0, base: -0.7, extra: 0 },
			{ a: 1, b: 2, base: 0.2, extra: 0 },
			{ a: 2, b: 3, base: 1.4, extra: 0 }, { a: 3, b: 2, base: -1.6, extra: 0 },
		];
		const before = solveBandConstraints(4, constraints, 4)!;
		const after = solveBandConstraints(4, constraints, 4, [{ parent: 0, first: 1, last: 2 }])!;
		const offset = (angles: number[]) => Math.abs(angles[0]! - (angles[1]! + angles[2]!) / 2);
		expect(offset(before)).toBeGreaterThan(0.2);
		expect(offset(after)).toBeLessThan(offset(before) * 0.5);
		for (const { a, b, base } of constraints) expect(after[b]! - after[a]!).toBeGreaterThanOrEqual(base - 1e-8);
	});

	it('preserves the opening of a small fork when a longer fan can yield', () => {
		const angles = solveBandConstraints(3, [
			{ a: 0, b: 1, base: 1, extra: 1, priority: 4 },
			{ a: 1, b: 2, base: 1, extra: 1, priority: 1 },
			{ a: 2, b: 0, base: -3, extra: 0 },
		], 12)!;
		expect(angles[1]! - angles[0]!).toBeGreaterThan(angles[2]! - angles[1]! + 0.3);
	});

	it('reduces a crowded fork without squeezing an unrelated family', () => {
		const angles = solveBandConstraints(4, [
			{ a: 0, b: 1, base: 1, extra: 2 }, { a: 1, b: 0, base: -2, extra: 0 },
			{ a: 2, b: 3, base: 1, extra: 3 },
		], 12)!;
		expect(angles[1]! - angles[0]!).toBeGreaterThanOrEqual(1);
		expect(angles[1]! - angles[0]!).toBeLessThanOrEqual(2 + 1e-8);
		expect(angles[3]! - angles[2]!).toBeGreaterThanOrEqual(4 - 1e-8);
	});

	it('rejects impossible physical spacing instead of returning overlapping nodes', () => {
		expect(solveBandConstraints(2, [
			{ a: 0, b: 1, base: 3, extra: 1 }, { a: 1, b: 0, base: -2, extra: 0 },
		], 12)).toBeNull();
		expect(solveBandConstraints(2, [{ a: 0, b: 1, base: 15, extra: 0 }], 12)).toBeNull();
	});
});
