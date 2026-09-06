import { describe, expect, it } from 'vitest';
import { ensureBandCapacity } from '../src/layout/radial/bandCapacity';
import { makePoint, setPointSector } from '../src/layout/radial/geometry';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import { siblingDistance } from '../src/layout/radial/siblingDistance';
import type { RadialLayout } from '../src/layout/radial/types';
import { completeGraph, hierarchyCrossings, edgesThroughNodes, generatedTreeRecords } from './helpers/radialFixtures';

describe('capacity shared by every hierarchy root', () => {
	it('expands all bands without changing tree angles, glyphs, or the spacing reference', () => {
		const graph = completeGraph(['A', 'B', 'C'].flatMap((branch) => Array.from({ length: 4 }, (_, i) => ({ path: `Root/${branch}/Note ${i}.md`, basename: `Note ${i}`, kind: 'note' as const }))), 'Root');
		const positions = new Map(graph.nodes.map((node) => {
			const branch = node.id.match(/Root\/([ABC])/), leaf = node.id.match(/Note (\d+)/);
			const angle = branch ? ('ABC'.indexOf(branch[1]!) - 1) * 0.5 + (leaf ? (Number(leaf[1]) - 1.5) * 0.002 : 0) : 0;
			const point = makePoint((node.depth - graph.nodesById.get(graph.rootId)!.depth) * 10000, angle, node.depth - graph.nodesById.get(graph.rootId)!.depth, node.type === 'folder' ? 32 : 6, false);
			point.ringRadius = point.radius; point.ringBandMin = point.radius * 0.9; point.ringBandMax = point.radius * 1.1;
			setPointSector(point, angle - 0.0001, angle + 0.0001);
			return [node.id, point];
		}));
		const before = new Map([...positions].map(([id, point]) => [id, { ...point }]));
		const distance = siblingDistance(positions, 144), targets = new Map([[0, 0], [1, 10000], [2, 20000]]);
		const result = ensureBandCapacity(positions, graph, targets, 144);
		expect(result.scale).toBeGreaterThan(10);
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			expect(point.radius).toBeCloseTo(old.radius * result.scale, 6);
			expect(point.ringRadius).toBe(targets.get(point.depth));
			expect([point.depth, point.angle, point.nodeRadius, point.sectorStart, point.sectorEnd]).toEqual([old.depth, old.angle, old.nodeRadius, old.sectorStart, old.sectorEnd]);
		}
		const points = [...positions.values()];
		for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
			const a = points[i]!, b = points[j]!;
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(distance(a, b));
		}
		const nextDistance = siblingDistance(positions, 144);
		expect(nextDistance(points[1]!, points[2]!)).toBe(distance(points[1]!, points[2]!));
		expect(ensureBandCapacity(positions, graph, targets, 144).scale).toBe(1);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it.each(['', 'F0', 'F0/F2'])('enforces the same minimum and readable framing after selecting root %s', (root) => {
		const graph = completeGraph(generatedTreeRecords(167, 350), root);
		expect(graph.rootId).toBe(root);
		const layout = layoutRadialGraph(graph, { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 });
		const points = [...layout.positions.values()].filter((point) => !point.external);
		const distance = siblingDistance(layout.positions, 144);
		for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
			const a = points[i]!, b = points[j]!, actual = Math.hypot(a.x - b.x, a.y - b.y);
			expect(actual).toBeGreaterThanOrEqual(distance(a, b) - 1e-6);
			// At the recommended initial zoom, even the smallest glyphs retain
			// a visible gap. Zooming out remains an explicit user operation.
			expect(actual * layout.readableZoom!).toBeGreaterThanOrEqual(14 - 1e-6);
		}
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});
});
