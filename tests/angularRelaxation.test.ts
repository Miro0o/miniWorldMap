import { describe, expect, it } from 'vitest';
import { relaxHierarchyAngles } from '../src/layout/radial/angularRelaxation';
import { makePoint, setPointSector, shortestAngleDelta } from '../src/layout/radial/geometry';
import type { RadialLayout } from '../src/layout/radial/types';
import { completeGraph, edgesThroughNodes, hierarchyCrossings, overlappingNodes } from './helpers/radialFixtures';

describe('angular clearance across radial bands', () => {
	it.each([0, Math.PI * 1.9])('opens a late fork between long neighboring edges at angle %f', (turn) => {
		const hub = 'Atlas/Topics/Middle/Hub';
		const paths = ['Atlas/Topics/Left/End.md', 'Atlas/Topics/Right/End.md'];
		for (let i = 0; i < 6; i++) {
			paths.push(`${hub}/Brief ${i}.md`);
			for (let j = 0; j < 3; j++) paths.push(`${hub}/Project ${i}/Part ${j}.md`);
		}
		const graph = completeGraph(paths.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const children = graph.nodes.filter((node) => node.parentId === hub);
		const childAngles = new Map(children.map((node, i) => [node.id, (i - (children.length - 1) / 2) * 0.0002]));
		const positions = new Map(graph.nodes.map((node) => {
			let radius = node.depth * 150000;
			let angle = node.id.includes('/Left') ? -0.02 : node.id.includes('/Right') ? 0.02 : 0;
			if (node.id === hub) radius = 1000000;
			if (childAngles.has(node.id)) { radius = 1400000; angle = childAngles.get(node.id)!; }
			if (childAngles.has(node.parentId ?? '')) {
				radius = 1650000;
				angle = childAngles.get(node.parentId!)! + (Number(node.title.match(/\d+/)?.[0]) - 1) * 0.00002;
			}
			if (node.id.endsWith('/End.md')) { radius = 1700000; angle *= 0.7; }
			const point = makePoint(radius, angle + turn, node.depth, 6, false);
			setPointSector(point, angle + turn - 0.00005, angle + turn + 0.00005);
			point.ringRadius = node.depth * 220000;
			point.ringBandMin = Math.min(radius, point.ringRadius * 0.8);
			point.ringBandMax = Math.max(radius, point.ringRadius * 1.2);
			return [node.id, point];
		}));
		const before = new Map([...positions].map(([id, p]) => [id, { ...p }]));
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		relaxHierarchyAngles(positions, graph, 144);
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			expect([point.radius, point.ringRadius, point.ringBandMin, point.ringBandMax])
				.toEqual([old.radius, old.ringRadius, old.ringBandMin, old.ringBandMax]);
			if (point.depth <= 3) expect(shortestAngleDelta(point.angle, old.angle)).toBeCloseTo(0, 12);
		}
		for (const id of [hub, `${hub}/Project 0`]) {
			const points = graph.nodes.filter((node) => node.parentId === id).map((node) => positions.get(node.id)!);
			let gap = Infinity;
			for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
				gap = Math.min(gap, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y));
			}
			expect(gap, id).toBeGreaterThan(15000);
		}
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});
});
