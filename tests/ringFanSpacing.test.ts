import { describe, expect, it } from 'vitest';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import { makePoint, setPointSector, unwrapAngleNear } from '../src/layout/radial/geometry';
import { HierarchyClearance } from '../src/layout/radial/hierarchyClearance';
import { spreadRingSiblings } from '../src/layout/radial/ringFanSpacing';
import { completeGraph, crowdedArchiveRecords, edgesThroughNodes, hierarchyCrossings, overlappingNodes, sectorViolations } from './helpers/radialFixtures';

describe('deep sibling spacing', () => {
	it.each([0, 30, 100])('opens late forks and same-name notes in a crowded archive at spin %i', (swirlStrength) => {
		const { records, hub } = crowdedArchiveRecords();
		const graph = completeGraph(records);
		const layout = layoutRadialGraph(graph, { ringSpacing: 1160, nodeSpacing: 144, swirlStrength });
		for (const id of [hub, `${hub}/Project 0`]) {
			const parent = layout.positions.get(id)!;
			const children = graph.nodes.filter((node) => node.parentId === id).map((node) => layout.positions.get(node.id)!);
			const step = children[0]!.radius - parent.radius;
			let minGap = Infinity;
			for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
				minGap = Math.min(minGap, Math.hypot(children[i]!.x - children[j]!.x, children[i]!.y - children[j]!.y));
			}
			expect(minGap / step, id).toBeGreaterThan(id === hub ? 0.035 : 0.065);
		}
		// Capacity expansion may scale the complete map. Preserve the original
		// relative progression and full band ranges, including radial lanes.
		const originalRadii = [
			1066.025521, 2272.859088, 5672.542347, 9138.179888, 12671.051231, 16297.541459,
			20104.144066, 24218.173044, 28789.929397, 33878.224332, 39687.921265, 46215.426767,
		];
		const scale = layout.rings[0]!.radius / originalRadii[0]!;
		expect(layout.rings).toHaveLength(originalRadii.length);
		for (let i = 0; i < originalRadii.length; i++) expect(layout.rings[i]!.radius / scale).toBeCloseTo(originalRadii[i]!, 4);
		const hubPoint = layout.positions.get(hub)!;
		expect(hubPoint.radius).toBeGreaterThanOrEqual(hubPoint.ringBandMin!);
		expect(hubPoint.radius).toBeLessThanOrEqual(hubPoint.ringBandMax!);
		expect(hubPoint.ringBandMin! / scale).toBeCloseTo(32216.78930545113, 4);
		expect(hubPoint.ringBandMax! / scale).toBeCloseTo(35539.659359520825, 4);
		const radii = layout.rings.map((ring) => ring.radius);
		expect(radii).toEqual(radii.slice().sort((a, b) => a - b));
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
		expect(sectorViolations(graph, layout)).toEqual([]);
	});
});

describe('subtree clearance', () => {
	const point = (x: number, y: number) => makePoint(Math.hypot(x, y), Math.atan2(y, x), 1, 4, false);
	function fixture() {
		const graph = completeGraph(['A/Child.md', 'B/Child.md'].map((path) => ({ path, basename: 'Child', kind: 'note' as const })));
		const positions = new Map([
			['', point(0, 0)], ['A', point(0, 100)], ['A/Child.md', point(0, 200)],
			['B', point(100, 100)], ['B/Child.md', point(100, 200)],
		]);
		return { positions, clearance: new HierarchyClearance(positions, graph) };
	}

	it('rejects a node moving onto an unrelated hierarchy edge without mutating the layout', () => {
		const { positions, clearance } = fixture();
		const before = { ...positions.get('A/Child.md')! };
		expect(clearance.accept(new Map([['A/Child.md', point(100, 150)]]))).toBe(false);
		expect(positions.get('A/Child.md')).toEqual(before);
	});

	it('checks an accepted edge at its new position before the base index is rebuilt', () => {
		const { positions, clearance } = fixture();
		expect(clearance.accept(new Map([['A/Child.md', point(-100, 200)]]))).toBe(true);
		expect(clearance.accept(new Map([['B/Child.md', point(-50, 150)]]))).toBe(false);
		expect(positions.get('B/Child.md')!.x).toBeCloseTo(100);
	});

	it('rechecks remembered collisions after endpoints move or branch protection changes', () => {
		const graph = completeGraph(['A/Child.md', 'B/Child.md'].map((path) => ({ path, basename: 'Child', kind: 'note' as const })));
		const positions = fixture().positions;
		const reference = structuredClone(positions);
		const clearance = new HierarchyClearance(positions, graph, 4, 1, undefined, () => 60);
		const ids = ['A', 'A/Child.md', 'B', 'B/Child.md'];
		let seed = 17;
		const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
		let accepted = 0, rejected = 0;
		for (let i = 0; i < 200; i++) {
			const proposal = new Map([[ids[i % ids.length]!, point(random() * 400 - 200, random() * 400)]]);
			if (i % 3 === 0) proposal.set(ids[(i + 1) % ids.length]!, point(random() * 400 - 200, random() * 400));
			const protectBranches = i % 2 === 0;
			const expected = new HierarchyClearance(reference, graph, 4, 1, undefined, () => 60).accept(structuredClone(proposal), protectBranches);
			expect(clearance.accept(proposal, protectBranches)).toBe(expected);
			expect(positions).toEqual(reference);
			if (expected) accepted++; else rejected++;
		}
		expect(accepted).toBeGreaterThan(10);
		expect(rejected).toBeGreaterThan(10);
	});

	it('resolves endpoint overlap when a neighboring branch blocks a comfortable fan', () => {
		const graph = completeGraph(['A/One.md', 'A/Two.md', 'B/Child.md'].map((path) => ({ path, basename: 'Note', kind: 'note' as const })));
		const polar = (radius: number, angle: number, depth: number) => {
			const p = makePoint(radius, angle, depth, 4, false);
			setPointSector(p, angle - 0.0002, angle + 0.0002);
			return p;
		};
		const root = polar(0, 0, 0);
		setPointSector(root, -Math.PI, Math.PI);
		const positions = new Map([
			['', root], ['A', polar(10000, 0, 2)], ['B', polar(10000, 0.0015, 2)],
			['A/One.md', polar(20000, -0.0001, 3)], ['A/Two.md', polar(20000, 0.0001, 3)],
			['B/Child.md', polar(20000, 0.0015, 3)],
		]);
		spreadRingSiblings(positions, graph, 144);
		const a = positions.get('A/One.md')!, b = positions.get('A/Two.md')!;
		expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(12);
		expect(a.radius).toBe(20000);
		expect(b.radius).toBe(20000);
		const center = positions.get('A')!.angle;
		expect(unwrapAngleNear(b.angle, center)).toBeLessThan(unwrapAngleNear(positions.get('B/Child.md')!.angle, center));
	});
});
