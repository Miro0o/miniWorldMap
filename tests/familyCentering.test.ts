import { describe, expect, it } from 'vitest';
import { centerHierarchyFamilies } from '../src/layout/radial/familyCentering';
import { HierarchyClearance } from '../src/layout/radial/hierarchyClearance';
import { makePoint, setPointSector, shortestAngleDelta, unwrapAngleNear } from '../src/layout/radial/geometry';
import type { RadialLayout, RadialPoint } from '../src/layout/radial/types';
import { completeGraph, edgesThroughNodes, hierarchyCrossings } from './helpers/radialFixtures';

describe('centering child forests', () => {
	it.each([[0, 0.4], [Math.PI * 1.99, 0.4], [0, 0.1]])('settles a first-ring folder into its free arc at %f with sector limit %f', (turn, limit) => {
		const graph = completeGraph(['Software Engineering/Left/Leaf.md', 'Software Engineering/Right/Leaf.md', 'Neighbor/Leaf.md']
			.map((path) => ({ path, basename: 'Leaf', kind: 'note' as const })));
		const children = new Map<string, string[]>();
		for (const edge of graph.hierarchyEdges) children.set(edge.source, [...children.get(edge.source) ?? [], edge.target]);
		const positions = new Map(graph.nodes.map((node) => {
			const angle = turn + (node.id.startsWith('Neighbor') ? -0.8 : node.depth < 2 ? 0 : node.id.includes('/Left') ? 0.18 : 0.26);
			const point = makePoint(node.depth * 10000, angle, node.depth, 6, false);
			point.ringRadius = point.radius; point.ringBandMin = point.radius - 1000; point.ringBandMax = point.radius + 1000;
			setPointSector(point, angle - 0.01, angle + 0.01);
			return [node.id, point];
		}));
		setPointSector(positions.get(graph.rootId)!, turn - Math.PI, turn + Math.PI);
		positions.get(graph.rootId)!.angle = turn + Math.PI;
		setPointSector(positions.get('Software Engineering')!, turn - 0.1, turn + limit);
		const before = new Map([...positions].map(([id, p]) => [id, { ...p }]));
		centerHierarchyFamilies(positions, children, new HierarchyClearance(positions, graph, 4, 1, undefined, () => 100));
		const parent = positions.get('Software Engineering')!;
		expect(shortestAngleDelta(turn, parent.angle)).toBeCloseTo(Math.min(0.22, limit), 8);
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			if (id !== 'Software Engineering') expect(point).toEqual(old);
			expect([point.radius, point.ringRadius, point.ringBandMin, point.ringBandMax, point.sectorStart, point.sectorEnd])
				.toEqual([old.radius, old.ringRadius, old.ringBandMin, old.ringBandMax, old.sectorStart, old.sectorEnd]);
		}
		expect(hierarchyCrossings(graph, { positions } as RadialLayout)).toEqual([]);
		expect(edgesThroughNodes(graph, { positions } as RadialLayout)).toEqual([]);
	});

	it.each([0, Math.PI * 1.99])('uses free space to align a skewed family and its descendants at angle %f', (turn) => {
		const graph = completeGraph(['Left', 'Right'].map((side) => ({ path: `A/Hub/${side}/Leaf.md`, basename: 'Leaf', kind: 'note' as const })));
		const children = new Map<string, string[]>();
		for (const edge of graph.hierarchyEdges) children.set(edge.source, [...children.get(edge.source) ?? [], edge.target]);
		const positions = new Map(graph.nodes.map((node) => {
			const angle = turn + (node.depth < 3 ? 0 : 0.22 + (node.id.includes('/Left') ? -0.04 : 0.04));
			const p = makePoint(node.depth * 10000, angle, node.depth, 6, false);
			p.ringRadius = p.radius; p.ringBandMin = p.radius - 1000; p.ringBandMax = p.radius + 1000;
			setPointSector(p, angle - 0.01, angle + 0.01);
			return [node.id, p];
		}));
		const before = new Map([...positions].map(([id, p]) => [id, { ...p }]));
		centerHierarchyFamilies(positions, children, new HierarchyClearance(positions, graph, 4, 1, undefined, () => 100));
		const hub = positions.get('A/Hub')!;
		const left = positions.get('A/Hub/Left')!, right = positions.get('A/Hub/Right')!;
		expect((unwrapAngleNear(left.angle, hub.angle) + unwrapAngleNear(right.angle, hub.angle)) / 2).toBeCloseTo(hub.angle, 8);
		for (const side of ['Left', 'Right']) {
			const parent = positions.get(`A/Hub/${side}`)!, child = positions.get(`A/Hub/${side}/Leaf.md`)!;
			expect(shortestAngleDelta(parent.angle, child.angle)).toBeCloseTo(0, 8);
		}
		for (const [id, p] of positions) {
			const old = before.get(id)!;
			expect([p.radius, p.ringRadius, p.ringBandMin, p.ringBandMax, p.nodeRadius]).toEqual([old.radius, old.ringRadius, old.ringBandMin, old.ringBandMax, old.nodeRadius]);
		}
		expect(hierarchyCrossings(graph, { positions } as RadialLayout)).toEqual([]);
		expect(edgesThroughNodes(graph, { positions } as RadialLayout)).toEqual([]);
	});
});

describe('clearance between unrelated tree paths', () => {
	const fixture = (height: number) => {
		const original = completeGraph(['A', 'B'].map((id) => ({ path: `${id}/Leaf.md`, basename: 'Leaf', kind: 'note' as const })));
		const graph = { ...original, hierarchyEdges: original.hierarchyEdges.filter((edge) => edge.source === 'A' || edge.source === 'B') };
		const point = (x: number, y: number): RadialPoint => ({ ...makePoint(Math.hypot(x, y), Math.atan2(y, x), 2, 1, false), x, y });
		const positions = new Map([[graph.rootId, point(-1000, -1000)], ['A', point(100, 0)], ['A/Leaf.md', point(300, 0)], ['B', point(0, height)], ['B/Leaf.md', point(400, height)]]);
		const move = (y: number) => new Map([['B', point(0, y)], ['B/Leaf.md', point(400, y)]]);
		return { graph, positions, move };
	};

	it('rejects close parallel paths even when edges and endpoints do not overlap', () => {
		const { graph, positions, move } = fixture(80);
		const candidate = move(20);
		expect(hierarchyCrossings(graph, { positions: new Map([...positions, ...candidate]) } as RadialLayout)).toEqual([]);
		const snapshot = [...positions].map(([id, p]) => [id, { ...p }]);
		expect(new HierarchyClearance(positions, graph, 4, 1, undefined, () => 60).accept(candidate)).toBe(false);
		expect([...positions]).toEqual(snapshot);
		expect(new HierarchyClearance(positions, graph).accept(candidate)).toBe(true);
	});

	it('allows an existing narrow gap to improve without allowing it to get tighter', () => {
		const { graph, positions, move } = fixture(20);
		const clearance = new HierarchyClearance(positions, graph, 4, 1, undefined, () => 60);
		expect(clearance.accept(move(16))).toBe(false);
		expect(clearance.accept(move(24))).toBe(true);
		expect(clearance.accept(move(40))).toBe(true);
	});
});
