import { describe, expect, it } from 'vitest';
import { separateNearbyNodes } from '../src/layout/radial/nodeSpacing';
import { syncFamilySectors } from '../src/layout/radial/ringFanSpacing';
import { siblingDistance } from '../src/layout/radial/siblingDistance';
import { makePoint, setPointSector, unwrapAngleNear } from '../src/layout/radial/geometry';
import type { RadialLayout } from '../src/layout/radial/types';
import { completeGraph, edgesThroughNodes, hierarchyCrossings, overlappingNodes, sectorViolations } from './helpers/radialFixtures';

function polar(radius: number, angle: number, depth: number, size: number) {
	const point = makePoint(radius, angle, depth, size, false);
	setPointSector(point, angle - 0.001, angle + 0.001);
	point.ringRadius = depth * 5000;
	point.ringBandMin = point.ringRadius - 500; point.ringBandMax = point.ringRadius + 500;
	return point;
}

describe('node clearance across sibling groups', () => {
	it.each([0, Math.PI * 1.99])('separates a cluster of vault-root notes without moving its neighboring folders at %f', (turn) => {
		const paths = ['Left/Leaf.md', 'Right/Leaf.md', ...Array.from({ length: 4 }, (_, i) => `Note ${i}.md`)];
		const graph = completeGraph(paths.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const positions = new Map(graph.nodes.map((node) => {
			const angle = node.id.startsWith('Left') ? -0.8 : node.id.startsWith('Right') ? 0.8 : Number(node.id.match(/Note (\d)/)?.[1] ?? 0) * 0.0001;
			return [node.id, polar(node.depth * 10000, turn + angle, node.depth, node.type === 'folder' ? 20 : 4)];
		}));
		setPointSector(positions.get(graph.rootId)!, turn - Math.PI, turn + Math.PI);
		const before = new Map([...positions].map(([id, point]) => [id, { ...point }]));
		const distance = siblingDistance(positions, 144);
		separateNearbyNodes(positions, graph, 144);
		for (let i = 1; i < 4; i++) {
			const a = positions.get(`Note ${i - 1}.md`)!, b = positions.get(`Note ${i}.md`)!;
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(distance(a, b) * 0.999);
			expect(unwrapAngleNear(a.angle, turn)).toBeLessThan(unwrapAngleNear(b.angle, turn));
		}
		for (const [id, point] of positions) {
			if (!id.startsWith('Note ')) expect(point).toEqual(before.get(id));
			expect(point.radius).toBe(before.get(id)!.radius);
		}
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it.each([0, Math.PI * 1.99])('opens a first-ring note/folder gap while retaining the forest and ring allocation at %f', (turn) => {
		const graph = completeGraph(['Software/Leaf.md', 'Welcome.md', 'Neighbor.md']
			.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const positions = new Map([
			[graph.rootId, polar(0, turn, 0, 6)],
			['Software', polar(10000, turn, 1, 20)],
			['Software/Leaf.md', polar(20000, turn - 0.03, 2, 4)],
			['Welcome.md', polar(10000, turn + 0.001, 1, 4)],
			['Neighbor.md', polar(10000, turn + 0.8, 1, 4)],
		]);
		setPointSector(positions.get(graph.rootId)!, turn - Math.PI, turn + Math.PI);
		const children = new Map<string, string[]>();
		for (const edge of graph.hierarchyEdges) children.set(edge.source, [...children.get(edge.source) ?? [], edge.target]);
		syncFamilySectors(positions, children);
		const before = new Map([...positions].map(([id, point]) => [id, { ...point }]));
		const distance = siblingDistance(positions, 144);
		separateNearbyNodes(positions, graph, 144);
		syncFamilySectors(positions, children);
		const folder = positions.get('Software')!, note = positions.get('Welcome.md')!;
		expect(Math.hypot(folder.x - note.x, folder.y - note.y)).toBeGreaterThanOrEqual(distance(folder, note) - 1e-6);
		expect(unwrapAngleNear(folder.angle, turn)).toBeLessThan(unwrapAngleNear(note.angle, turn));
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			expect([point.radius, point.depth, point.ringRadius, point.ringBandMin, point.ringBandMax])
				.toEqual([old.radius, old.depth, old.ringRadius, old.ringBandMin, old.ringBandMax]);
			if (id === graph.rootId || id === 'Software/Leaf.md' || id === 'Neighbor.md') {
				expect([point.x, point.y, point.angle]).toEqual([old.x, old.y, old.angle]);
				expect(unwrapAngleNear(point.sectorStart!, old.sectorStart!)).toBeCloseTo(old.sectorStart!, 8);
				expect(unwrapAngleNear(point.sectorEnd!, old.sectorEnd!)).toBeCloseTo(old.sectorEnd!, 8);
			}
		}
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
		expect(sectorViolations(graph, layout)).toEqual([]);
	});

	it('lets a terminal note yield when both outgoing sides pin the neighboring folder', () => {
		const graph = completeGraph(['Software/Left.md', 'Software/Right.md', 'Welcome.md']
			.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const positions = new Map([
			[graph.rootId, polar(0, 0, 0, 6)], ['Software', polar(10000, 0, 1, 20)],
			['Software/Left.md', polar(10000 / Math.cos(0.6), -0.6, 2, 4)],
			['Software/Right.md', polar(10000 / Math.cos(0.6), 0.6, 2, 4)],
			['Welcome.md', polar(10000, 0.04, 1, 4)],
		]);
		setPointSector(positions.get(graph.rootId)!, -Math.PI, Math.PI);
		const before = new Map([...positions].map(([id, point]) => [id, { ...point }]));
		const distance = siblingDistance(positions, 144);
		separateNearbyNodes(positions, graph, 144);
		const folder = positions.get('Software')!, note = positions.get('Welcome.md')!;
		expect(Math.hypot(folder.x - note.x, folder.y - note.y)).toBeGreaterThanOrEqual(distance(folder, note) - 1e-6);
		for (const [id, point] of positions) if (id !== 'Welcome.md') expect(point).toEqual(before.get(id));
		expect(note.radius).toBe(before.get('Welcome.md')!.radius);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it.each([false, true])('preserves an angular share for deep siblings, mixed kinds: %s', (mixed) => {
		const parent = 'A/B/C/D';
		const records = Array.from({ length: 4 }, (_, i) => ({
			path: `${parent}/Item ${i}${mixed && i % 2 ? '' : '.md'}`, basename: `Item ${i}`, kind: mixed && i % 2 ? 'folder' as const : 'note' as const,
		}));
		const graph = completeGraph(records);
		const angles = new Map(records.map((record, i) => [record.path, [-0.15, -0.149, 0.149, 0.15][i]!]));
		const positions = new Map(graph.nodes.map((node) => [node.id, polar(node.depth * 10000, angles.get(node.id) ?? 0, node.depth, node.type === 'folder' ? 20 : 4)]));
		separateNearbyNodes(positions, graph, 144);
		const siblings = records.map((record) => positions.get(record.path)!);
		for (let i = 1; i < siblings.length; i++) {
			expect(unwrapAngleNear(siblings[i]!.angle, 0) - unwrapAngleNear(siblings[i - 1]!.angle, 0)).toBeGreaterThan(0.069);
		}
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it('gives a small continuing folder an angular share beside a large subtree', () => {
		const graph = completeGraph([
			{ path: 'A/Empty', basename: 'Empty', kind: 'folder' as const },
			...['A/Note.md', 'A/Small/End.md', 'A/Large/Next/Next/Next/Next/Next/End.md']
				.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })),
		]);
		const positions = new Map(graph.nodes.map((node) => {
			const angle = node.id === 'A/Empty' ? -0.1 : node.id === 'A/Note.md' ? -0.001 :
				node.id.startsWith('A/Large') ? 0.12 : node.id === 'A/Small/End.md' ? 0.02 : 0;
			return [node.id, polar(node.depth * 10000, angle, node.depth, node.type === 'folder' ? 20 : 4)];
		}));
		const before = new Map([...positions].map(([id, p]) => [id, { ...p }]));
		separateNearbyNodes(positions, graph, 144);
		const small = positions.get('A/Small')!, note = positions.get('A/Note.md')!;
		// This requires meaningful angular room, well beyond physical collision
		// avoidance, without granting the small folder a larger descendant wedge.
		expect(unwrapAngleNear(small.angle, 0) - unwrapAngleNear(note.angle, 0)).toBeGreaterThan(0.03);
		for (const id of ['A/Large', 'A/Large/Next', 'A/Small/End.md']) expect(positions.get(id)).toEqual(before.get(id));
		for (const [id, point] of positions) expect(point.radius).toBe(before.get(id)!.radius);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it.each([0, 2 * Math.PI - 0.001])('separates a boundary note from a continuing folder across the seam at %f', (turn) => {
		const graph = completeGraph(['A/Inside.md', 'A/Edge.md', 'B/Edge/End.md', 'B/Inside.md']
			.map((path) => ({ path, basename: path.split('/').pop()!, kind: 'note' as const })));
		const positions = new Map([
			['', polar(0, turn, 0, 6)], ['A', polar(5000, turn - 0.06, 1, 12)], ['B', polar(5000, turn + 0.06, 1, 12)],
			['A/Inside.md', polar(10000, turn - 0.08, 2, 4)], ['A/Edge.md', polar(10000, turn - 0.0003, 2, 4)],
			['B/Edge', polar(10060, turn + 0.0003, 2, 20)], ['B/Inside.md', polar(10060, turn + 0.08, 2, 4)],
			['B/Edge/End.md', polar(15000, turn + 0.03, 3, 4)],
		]);
		const before = new Map([...positions].map(([id, p]) => [id, { ...p }]));
		const layout = { positions } as RadialLayout;
		separateNearbyNodes(positions, graph, 144);
		const a = positions.get('A/Edge.md')!, b = positions.get('B/Edge')!;
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(239.99);
		// A boundary must open without stealing a previously readable gap
		// inside either family, which otherwise creates new zoom-out overlaps.
		for (const [left, right] of [['A/Inside.md', 'A/Edge.md'], ['B/Edge', 'B/Inside.md']]) {
			const oldA = before.get(left!)!, oldB = before.get(right!)!;
			const nextA = positions.get(left!)!, nextB = positions.get(right!)!;
			expect(Math.hypot(nextA.x - nextB.x, nextA.y - nextB.y))
				.toBeGreaterThanOrEqual(Math.hypot(oldA.x - oldB.x, oldA.y - oldB.y) - 1e-6);
		}
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			expect([point.radius, point.depth, point.ringRadius, point.ringBandMin, point.ringBandMax])
				.toEqual([old.radius, old.depth, old.ringRadius, old.ringBandMin, old.ringBandMax]);
			if (point.depth <= 1) expect(point).toEqual(old);
		}
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it('opens a coincident mixed run together without reversing its sibling order', () => {
		const graph = completeGraph(Array.from({ length: 6 }, (_, i) => ({
			path: `A/Item ${i}${i % 2 ? '.md' : ''}`, basename: `Item ${i}`, kind: i % 2 ? 'note' as const : 'folder' as const,
		})));
		const positions = new Map(graph.nodes.map((node) => [node.id, polar(node.depth * 5000, 0, node.depth, node.type === 'folder' ? 20 : 4)]));
		const order = graph.hierarchyEdges.filter((edge) => edge.source === 'A').map((edge) => edge.target);
		separateNearbyNodes(positions, graph, 144);
		expect(order.slice().sort((a, b) => unwrapAngleNear(positions.get(a)!.angle, 0) - unwrapAngleNear(positions.get(b)!.angle, 0))).toEqual(order);
		for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
			const a = positions.get(order[i]!)!, b = positions.get(order[j]!)!;
			expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.nodeRadius + b.nodeRadius + 210);
			expect(a.radius).toBe(10000);
		}
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});
});
