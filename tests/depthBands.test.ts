import { describe, expect, it } from 'vitest';
import { separateDepthBands } from '../src/layout/radial/depthBands';
import { spreadBandSiblings } from '../src/layout/radial/bandSiblingSpacing';
import { makePoint, setPointSector } from '../src/layout/radial/geometry';
import type { RadialLayout } from '../src/layout/radial/types';
import { completeGraph, edgesThroughNodes, hierarchyCrossings, overlappingNodes } from './helpers/radialFixtures';

describe('separate placement bands for adjacent depths', () => {
	it.each([0, Math.PI * 1.99])('keeps staggered families in distinct depth bands across angle %f', (turn) => {
		const hub = 'Atlas/Topics/Middle/Hub';
		const paths: string[] = [];
		for (let group = 0; group < 6; group++) {
			for (let file = 0; file < 6; file++) paths.push(`${hub}/Group ${group}/File ${file}.md`);
			paths.push(`${hub}/Group ${group}/Chain/End.md`);
		}
		const graph = completeGraph(paths.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const targets = new Map([[0, 0], [1, 10000], [2, 20000], [3, 30000], [4, 65000], [5, 180000], [6, 280000], [7, 400000]]);
		const ranges = new Map([[5, [100000, 260000]], [6, [180000, 380000]], [7, [300000, 500000]]]);
		const positions = new Map(graph.nodes.map((node) => {
			const baseline = targets.get(node.depth)!;
			const [min, max] = ranges.get(node.depth) ?? [baseline, baseline];
			const group = Number(node.id.match(/Group (\d+)/)?.[1] ?? 0);
			const file = Number(node.id.match(/File (\d+)/)?.[1] ?? 6);
			const angle = turn + (node.depth >= 5 ? (group - 2.5) * 0.012 : 0) + (node.depth >= 6 ? (file - 3) * 0.001 : 0);
			const radius = node.depth >= 5 ? baseline + (group % 2 ? 0.6 : -0.6) * (max! - min!) / 2 : baseline;
			const point = makePoint(radius, angle, node.depth, 6, false);
			setPointSector(point, angle - 0.0001, angle + 0.0001);
			point.ringRadius = baseline; point.ringBandMin = min; point.ringBandMax = max;
			return [node.id, point];
		}));
		const original = new Map([...positions].map(([id, point]) => [id, { ...point }]));
		const originalTargets = new Map(targets);
		const bands = separateDepthBands(positions, targets);
		spreadBandSiblings(positions, graph, 144, bands);
		expect(targets).toEqual(originalTargets);
		for (const [id, point] of positions) {
			const before = original.get(id)!;
			expect([point.depth, point.ringRadius, point.ringBandMin, point.ringBandMax])
				.toEqual([before.depth, before.ringRadius, before.ringBandMin, before.ringBandMax]);
			expect(point.radius).toBeGreaterThanOrEqual(before.ringBandMin!);
			expect(point.radius).toBeLessThanOrEqual(before.ringBandMax!);
			if (point.depth < 5) expect(point).toEqual(before);
		}
		const radiiAt = (depth: number) => [...positions.values()].filter((p) => p.depth === depth).map((p) => p.radius);
		for (const depth of [5, 6]) {
			// Check entire neighboring levels, including unrelated parents and
			// single-child chains, rather than only child.radius > parent.radius.
			expect(Math.min(...radiiAt(depth + 1)) - Math.max(...radiiAt(depth)))
				.toBeGreaterThanOrEqual((targets.get(depth + 1)! - targets.get(depth)!) * 0.35);
		}
		for (const parent of [hub, ...Array.from({ length: 6 }, (_, i) => `${hub}/Group ${i}`)]) {
			const radii = graph.nodes.filter((node) => node.parentId === parent).map((node) => positions.get(node.id)!.radius);
			expect(Math.max(...radii) - Math.min(...radii), parent).toBeLessThan(1e-6);
		}
		expect(new Set(radiiAt(6)).size).toBeGreaterThan(1);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it('opens a visible gap even when neighboring ranges do not overlap', () => {
		const targets = new Map([[5, 100000], [6, 200000], [7, 300000]]);
		const positions = new Map([...targets].flatMap(([depth, radius]) => [-1, 0, 1].map((offset) => {
			const point = makePoint(radius + offset * 45000, 0, depth, 6, false);
			point.ringRadius = radius; point.ringBandMin = radius - 45000; point.ringBandMax = radius + 45000;
			return [`${depth}/${offset}`, point] as const;
		})));
		separateDepthBands(positions, targets);
		for (const depth of [5, 6]) {
			expect(positions.get(`${depth + 1}/-1`)!.radius - positions.get(`${depth}/1`)!.radius).toBeGreaterThan(30000);
		}
		for (const [depth, radius] of targets) {
			expect(positions.get(`${depth}/0`)!.radius).toBe(radius);
			expect(positions.get(`${depth}/1`)!.radius - positions.get(`${depth}/-1`)!.radius).toBeGreaterThan(50000);
			for (const offset of [-1, 0, 1]) {
				const point = positions.get(`${depth}/${offset}`)!;
				expect(point.ringRadius).toBe(radius);
				expect(point.ringBandMin).toBe(radius - 45000);
				expect(point.ringBandMax).toBe(radius + 45000);
			}
		}
	});
});
