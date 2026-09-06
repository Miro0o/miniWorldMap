import { describe, expect, it, vi } from 'vitest';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import * as sectorConstraints from '../src/layout/radial/sectorConstraints';
import * as ringFanSpacing from '../src/layout/radial/ringFanSpacing';
import { shortestAngleDelta } from '../src/layout/radial/geometry';
import { siblingDistance } from '../src/layout/radial/siblingDistance';
import type { WorldFileRecord } from '../src/world/types';
import { completeGraph, edgesThroughNodes, generatedTreeRecords, hierarchyCrossings, mixedBranchRecords, overlappingNodes, sectorViolations } from './helpers/radialFixtures';

const options = { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 };

describe('radial layout quality', () => {
	it.each([0, 30, 100])('widens narrow forks and preserves the band profile during capacity expansion at spin %i', (swirlStrength) => {
		const graph = completeGraph(generatedTreeRecords(167, 350));
		const expansion = vi.spyOn(sectorConstraints, 'expandHierarchyFans').mockImplementationOnce(() => {});
		const localExpansion = vi.spyOn(ringFanSpacing, 'spreadRingSiblings').mockImplementationOnce(() => {});
		const before = layoutRadialGraph(graph, { ...options, swirlStrength });
		localExpansion.mockRestore();
		expansion.mockRestore();
		const after = layoutRadialGraph(graph, { ...options, swirlStrength });
		const scale = after.rings[0]!.radius / before.rings[0]!.radius;
		expect(after.rings.map(({ depth, count }) => ({ depth, count }))).toEqual(before.rings.map(({ depth, count }) => ({ depth, count })));
		for (let i = 0; i < after.rings.length; i++) expect(after.rings[i]!.radius).toBeCloseTo(before.rings[i]!.radius * scale, 6);
		for (const [id, point] of after.positions) {
			const previous = before.positions.get(id)!;
			expect(point.depth, id).toBe(previous.depth);
			for (const key of ['ringRadius', 'ringBandMin', 'ringBandMax'] as const) expect(point[key]!, id).toBeCloseTo(previous[key]! * scale, 6);
			expect(point.radius, id).toBeGreaterThanOrEqual(point.ringBandMin!);
			expect(point.radius, id).toBeLessThanOrEqual(point.ringBandMax!);
		}
		const parent = after.positions.get('F0/F2')!;
		const a = after.positions.get('F0/F2/N0.md')!;
		const b = after.positions.get('F0/F2/F1')!;
		const width = Math.abs(-(b.x - a.x) * Math.sin(parent.angle) + (b.y - a.y) * Math.cos(parent.angle));
		expect(width).toBeGreaterThan((a.radius - parent.radius) * 0.28);
		expect(hierarchyCrossings(graph, after)).toEqual([]);
		expect(overlappingNodes(after)).toEqual([]);
		expect(edgesThroughNodes(graph, after)).toEqual([]);
		expect(sectorViolations(graph, after)).toEqual([]);
	});

	it('keeps small forks visible throughout an uneven tree', () => {
		const graph = completeGraph(generatedTreeRecords(167, 350));
		const layout = layoutRadialGraph(graph, options);
		const distance = siblingDistance(layout.positions, options.nodeSpacing);
		const groups = new Map<string, string[]>();
		for (const edge of graph.hierarchyEdges) {
			if (edge.type !== 'hierarchy') continue;
			const children = groups.get(edge.source) ?? [];
			children.push(edge.target);
			groups.set(edge.source, children);
		}
		for (const [id, children] of groups) {
			const parent = layout.positions.get(id)!;
			if (children.length < 2 || parent.depth < 2) continue;
			const points = children.map((child) => layout.positions.get(child)!);
			const lateral = points.map((point) => -(point.x - parent.x) * Math.sin(parent.angle) + (point.y - parent.y) * Math.cos(parent.angle));
			const radialStep = points.reduce((sum, point) => sum + point.radius - parent.radius, 0) / points.length;
			const targetWidth = points.slice(1).reduce((sum, point, i) => sum + distance(points[i]!, point), 0);
			// A sparse group may contract to the common sibling distance. Its
			// required width must not keep growing with a long parent-child edge.
			expect(Math.max(...lateral) - Math.min(...lateral), id).toBeGreaterThan(Math.min(radialStep * 0.18, targetWidth * 0.9));
		}
	});

	it('removes the original crossing between a sibling note and another branch descendant', () => {
		const records: WorldFileRecord[] = [
			'F0/F0/N0.md', 'F0/F0/F1/F0/N0.md', 'F0/F0/N2.md', 'F0/F0/N3.md',
			'F0/F0/F4/N0.md', 'F0/F0/F4/F1', 'F0/F0/F4/F2',
		].map((path) => ({ path, basename: path.split('/').pop()!.replace(/\.md$/, ''), kind: path.endsWith('.md') ? 'note' : 'folder' }));
		const graph = completeGraph(records);
		expect(graph.nodes).toHaveLength(13);
		expect(hierarchyCrossings(graph, layoutRadialGraph(graph, options))).toEqual([]);
	});

	it.each([0, 30, 100])('keeps mixed sibling branches and single-child chains coherent at spin %i', (swirlStrength) => {
		const graph = completeGraph(mixedBranchRecords());
		const layout = layoutRadialGraph(graph, { ...options, swirlStrength });
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		const branch = layout.positions.get('Trunk/Hub/Branch A')!;
		const chain = layout.positions.get('Trunk/Hub/Branch A/Chain')!;
		expect(Math.abs(shortestAngleDelta(branch.angle, chain.angle))).toBeLessThan(0.2);
	});

	it.each([167, 230, 234, 324, 446, 500, 560])('leaves clearance in narrow subtrees (seed %i)', (seed) => {
		const graph = completeGraph(generatedTreeRecords(seed, 350));
		const layout = layoutRadialGraph(graph, options);
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
	});

	it('keeps a deep branch with side notes readable without exponential radius growth', () => {
		const records: WorldFileRecord[] = [];
		let parent = 'Comb';
		for (let depth = 0; depth < 60; depth++) {
			records.push({ path: `${parent}/Note.md`, basename: 'Note', kind: 'note' });
			parent += '/Next';
		}
		records.push({ path: `${parent}/End.md`, basename: 'End', kind: 'note' });
		const graph = completeGraph(records);
		const layout = layoutRadialGraph(graph, options);
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
		expect(Math.max(...[...layout.positions.values()].map((p) => p.radius))).toBeLessThan(layout.ringSpacing * 60 * 8);
	});

	it.each([0, 30, 100])('separates generated uneven trees at spin %i', (swirlStrength) => {
		for (let seed = 1; seed <= 60; seed++) {
			const records = generatedTreeRecords(seed);
			for (const root of ['', 'F0']) {
				const graph = completeGraph(records, root);
				const layout = layoutRadialGraph(graph, { ...options, swirlStrength });
				expect(hierarchyCrossings(graph, layout), `seed ${seed}, root ${root}`).toEqual([]);
				expect(overlappingNodes(layout), `seed ${seed}, root ${root}`).toEqual([]);
				expect(edgesThroughNodes(graph, layout), `seed ${seed}, root ${root}`).toEqual([]);
				expect(sectorViolations(graph, layout), `seed ${seed}, root ${root}`).toEqual([]);
			}
		}
	});

	it.each([[620, 72], [620, 360], [2800, 72], [2800, 360]])('handles spacing extremes %i / %i with linked hubs', (ringSpacing, nodeSpacing) => {
		for (const seed of [2, 7, 19, 40, 167, 230]) {
			const records = generatedTreeRecords(seed, 350);
			const notes = records.filter((record) => record.kind === 'note');
			const links = Object.fromEntries(notes.slice(1).map((note) => [note.path, 5]));
			const graph = completeGraph(records, '', { [notes[0]!.path]: links });
			const layout = layoutRadialGraph(graph, { ringSpacing, nodeSpacing, swirlStrength: 100 });
			expect(hierarchyCrossings(graph, layout), `seed ${seed}`).toEqual([]);
			expect(overlappingNodes(layout), `seed ${seed}`).toEqual([]);
			expect(edgesThroughNodes(graph, layout), `seed ${seed}`).toEqual([]);
			expect(sectorViolations(graph, layout), `seed ${seed}`).toEqual([]);
		}
	});

	it('reserves disjoint sectors for a wide ring and produces stable positions', () => {
		const records: WorldFileRecord[] = Array.from({ length: 900 }, (_, index) => ({ path: `Note ${index}.md`, basename: `Note ${index}`, kind: 'note' }));
		const graph = completeGraph(records);
		const layout = layoutRadialGraph(graph, options);
		expect(sectorViolations(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(layoutRadialGraph(completeGraph(records.slice().reverse()), options).positions).toEqual(layout.positions);
	});
});
