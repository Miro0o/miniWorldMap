import { describe, expect, it } from 'vitest';
import { spreadBandSiblings } from '../src/layout/radial/bandSiblingSpacing';
import { makePoint, setPointSector, unwrapAngleNear } from '../src/layout/radial/geometry';
import type { RadialLayout, RadialPoint } from '../src/layout/radial/types';
import { siblingDistance } from '../src/layout/radial/siblingDistance';
import { completeGraph, edgesThroughNodes, hierarchyCrossings, overlappingNodes } from './helpers/radialFixtures';

describe('sibling spacing inside existing annular ranges', () => {
	it.each([0, Math.PI * 1.99])('equalizes distances across radii and family sizes, including across the seam (%f)', (turn) => {
		const outer = 'Outer/A/B/C/D/E/F';
		const graph = completeGraph(['Inner', outer].flatMap((parent) => Array.from({ length: parent === 'Inner' ? 4 : 9 }, (_, i) => ({
			path: `${parent}/Note ${i}.md`, basename: `Note ${i}`, kind: 'note' as const,
		}))));
		const positions = new Map(graph.nodes.map((node) => {
			const inner = node.id.startsWith('Inner'), match = node.id.match(/Note (\d+)/);
			const angle = turn + (inner ? -0.5 : 0.5) + (match ? (Number(match[1]) - 1.5) * (inner ? 0.001 : 0.06) : 0);
			const point = makePoint(node.depth * 10000, angle, node.depth, 6, false);
			point.ringRadius = point.ringBandMin = point.ringBandMax = point.radius;
			setPointSector(point, angle - 0.0001, angle + 0.0001);
			return [node.id, point];
		}));
		const snapshots = [...positions].map(([id, point]) => [id, point.radius, point.nodeRadius]);
		spreadBandSiblings(positions, graph, 144);
		const angles: number[] = [];
		for (const parent of ['Inner', outer]) {
			const points = Array.from({ length: parent === 'Inner' ? 4 : 9 }, (_, i) => positions.get(`${parent}/Note ${i}.md`)!);
			for (let i = 1; i < points.length; i++) {
				const a = points[i - 1]!, b = points[i]!;
				expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(1200, 6);
			}
			angles.push(unwrapAngleNear(points[1]!.angle, points[0]!.angle) - points[0]!.angle);
		}
		expect(angles[0]!).toBeGreaterThan(angles[1]! * 3.9);
		expect([...positions].map(([id, point]) => [id, point.radius, point.nodeRadius])).toEqual(snapshots);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it('opens an upper family without leaving its child fans skewed behind it', () => {
		const records = Array.from({ length: 4 }, (_, group) => Array.from({ length: 2 }, (_, leaf) => ({
			path: `Atlas/Hub/Group ${group}/Leaf ${leaf}.md`, basename: `Leaf ${leaf}`, kind: 'note' as const,
		}))).flat();
		const graph = completeGraph(records);
		const positions = new Map(graph.nodes.map((node) => {
			const group = node.id.match(/Group (\d+)/), leaf = node.id.match(/Leaf (\d+)/);
			const angle = group ? (Number(group[1]) - 1.5) * 0.02 + (leaf ? (Number(leaf[1]) - 0.5) * 0.002 : 0) : 0;
			const p = makePoint(node.depth * 10000, angle, node.depth, 6, false);
			p.ringRadius = p.radius; p.ringBandMin = p.radius - (node.depth >= 3 ? 4000 : 0); p.ringBandMax = p.radius + (node.depth >= 3 ? 4000 : 0);
			setPointSector(p, angle - 0.0005, angle + 0.0005);
			return [node.id, p];
		}));
		const parents = Array.from({ length: 4 }, (_, group) => positions.get(`Atlas/Hub/Group ${group}`)!);
		const before = minimumDistance(parents);
		spreadBandSiblings(positions, graph, 144);
		expect(minimumDistance(parents)).toBeGreaterThan(before * 2);
		for (let group = 0; group < 4; group++) {
			const parent = parents[group]!;
			const angles = [0, 1].map((leaf) => unwrapAngleNear(positions.get(`Atlas/Hub/Group ${group}/Leaf ${leaf}.md`)!.angle, parent.angle));
			expect(Math.abs((angles[0]! + angles[1]!) / 2 - parent.angle)).toBeLessThan(0.012);
		}
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it('opens a mixed folder/note fan even on a fixed outer band', () => {
		const graph = completeGraph(Array.from({ length: 6 }, (_, i) => ({
			path: `A/Item ${i}${i % 2 ? '.md' : ''}`, basename: `Item ${i}`, kind: i % 2 ? 'note' as const : 'folder' as const,
		})));
		const positions = new Map(graph.nodes.map((node, i) => {
			const point = makePoint(node.depth * 10000, node.depth === 2 ? i * 0.0001 : 0, node.depth, node.type === 'folder' ? 20 : 4, false);
			setPointSector(point, point.angle - 0.0001, point.angle + 0.0001);
			point.ringBandMin = point.ringBandMax = point.ringRadius = point.radius;
			return [node.id, point];
		}));
		spreadBandSiblings(positions, graph, 144);
		const siblings = [...positions.values()].filter((p) => p.depth === 2).sort((a, b) => unwrapAngleNear(a.angle, 0) - unwrapAngleNear(b.angle, 0));
		const target = siblingDistance(positions, 144);
		for (let i = 1; i < siblings.length; i++) {
			const a = siblings[i - 1]!, b = siblings[i]!;
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeCloseTo(target(a, b), 6);
		}
		for (const point of positions.values()) expect(point.radius).toBe(point.depth * 10000);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
	});

	it.each([0, Math.PI * 1.99])('keeps siblings on a shared radius and staggers neighboring families at angle %f', (turn) => {
		const hub = 'Atlas/Topics/Middle/Hub';
		const paths = ['Atlas/Topics/Left/End.md', 'Atlas/Topics/Right/End.md'];
		for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) paths.push(`${hub}/Group ${i}/File ${j}.md`);
		const graph = completeGraph(paths.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const positions = new Map(graph.nodes.map((node) => {
			let radius = node.depth * 10000;
			let angle = node.id.includes('/Left') ? -0.05 : node.id.includes('/Right') ? 0.05 : 0;
			let min = radius, max = radius;
			if (node.id === hub) radius = min = max = 65000;
			const group = node.id.match(/Group (\d+)/);
			if (group) {
				angle = (Number(group[1]) - 2.5) * 0.006;
				radius = 142000; min = 122000; max = 200000;
				const file = node.id.match(/File (\d+)/);
				if (file) { angle += (Number(file[1]) - 2.5) * 0.0005; radius = 390000; min = 254000; max = 440000; }
			}
			if (node.id.endsWith('/End.md')) radius = min = max = 800000;
			const point = makePoint(radius, angle + turn, node.depth, 6, false);
			setPointSector(point, angle + turn - 0.0001, angle + turn + 0.0001);
			point.ringRadius = (min + max) / 2;
			point.ringBandMin = min; point.ringBandMax = max;
			return [node.id, point];
		}));
		const before = new Map([...positions].map(([id, p]) => [id, { ...p }]));
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		spreadBandSiblings(positions, graph, 144);
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			expect([point.depth, point.ringRadius, point.ringBandMin, point.ringBandMax])
				.toEqual([old.depth, old.ringRadius, old.ringBandMin, old.ringBandMax]);
			expect(point.radius).toBeGreaterThanOrEqual(old.ringBandMin!);
			expect(point.radius).toBeLessThanOrEqual(old.ringBandMax!);
			if (point.depth <= 1) expect(point).toEqual(old);
		}
		for (const id of ['Atlas/Topics', hub, ...Array.from({ length: 6 }, (_, i) => `${hub}/Group ${i}`)]) {
			const nodes = graph.nodes.filter((n) => n.parentId === id);
			const current = nodes.map((n) => positions.get(n.id)!);
			expect(Math.max(...current.map((p) => p.radius)) - Math.min(...current.map((p) => p.radius)), id).toBeLessThan(1e-6);
			if (id === hub) {
				expect(minimumDistance(current), id).toBeGreaterThan(minimumDistance(nodes.map((n) => before.get(n.id)!)));
				expect(minimumDistance(current), id).toBeCloseTo(1200, 6);
			}
			if (id === 'Atlas/Topics') {
				// A sparse group contracts to the common distance instead of being
				// forced wider merely because its parent is far inside its band.
				expect(minimumDistance(current), id).toBeCloseTo(1200, 6);
			}
			const center = before.get(id)!.angle;
			const order = (points: Map<string, RadialPoint>) => nodes.slice().sort((a, b) => unwrapAngleNear(points.get(a.id)!.angle, center) - unwrapAngleNear(points.get(b.id)!.angle, center)).map((n) => n.id);
			expect(order(positions)).toEqual(order(before));
		}
		const lanes = new Set(Array.from({ length: 6 }, (_, i) => Math.round(positions.get(`${hub}/Group ${i}/File 0.md`)!.radius)));
		expect(lanes.size).toBeGreaterThanOrEqual(3);
		for (const edge of graph.hierarchyEdges) expect(positions.get(edge.target)!.radius).toBeGreaterThan(positions.get(edge.source)!.radius);
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});
});

function minimumDistance(points: RadialPoint[]): number {
	let distance = Infinity;
	for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) distance = Math.min(distance, Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y));
	return distance;
}
