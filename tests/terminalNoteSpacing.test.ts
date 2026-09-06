import { describe, expect, it } from 'vitest';
import { layoutRadialGraph } from '../src/layout/radial/layoutRadial';
import { makePoint, setPointSector, unwrapAngleNear } from '../src/layout/radial/geometry';
import { spreadRootNotes } from '../src/layout/radial/terminalNoteSpacing';
import { syncFamilySectors } from '../src/layout/radial/ringFanSpacing';
import type { RadialLayout } from '../src/layout/radial/types';
import type { WorldFileRecord } from '../src/world/types';
import { completeGraph, edgesThroughNodes, hierarchyCrossings, overlappingNodes, sectorViolations } from './helpers/radialFixtures';

describe('angular room for shallow terminal notes', () => {
	it.each([['', 0, false], ['Atlas', Math.PI * 1.99, false], ['', 0, true]] as const)('uses root arc gaps for root %s at %f, seam run: %s', (rootPath, turn, seam) => {
		const prefix = rootPath ? `${rootPath}/` : '';
		const paths = ['Left/Leaf.md', 'Right/Leaf.md', ...Array.from({ length: 4 }, (_, i) => `Note ${i}.md`)];
		const graph = completeGraph(paths.map((path) => ({ path: prefix + path, basename: path.split('/').pop()!, kind: 'note' as const })), rootPath);
		const rootDepth = graph.nodesById.get(graph.rootId)!.depth;
		const children = new Map<string, string[]>();
		for (const edge of graph.hierarchyEdges) children.set(edge.source, [...children.get(edge.source) ?? [], edge.target]);
		const positions = new Map(graph.nodes.map((node) => {
			const local = node.id.slice(prefix.length), depth = node.depth - rootDepth;
			const index = Number(local.match(/Note (\d)/)?.[1] ?? 0);
			const noteAngle = seam ? [-3.1, -3.09, 3.09, 3.1][index]! : index * 0.01;
			const angle = turn + (local.startsWith('Left') ? (seam ? -2 : -0.8) : local.startsWith('Right') ? (seam ? 2 : 0.8) : noteAngle);
			const point = makePoint(depth * 10000, angle, depth, 6, false);
			point.ringRadius = point.radius; point.ringBandMin = point.radius - 500; point.ringBandMax = point.radius + 500;
			setPointSector(point, angle - 0.001, angle + 0.001);
			return [node.id, point];
		}));
		setPointSector(positions.get(graph.rootId)!, turn - Math.PI, turn + Math.PI);
		syncFamilySectors(positions, children);
		const before = new Map([...positions].map(([id, point]) => [id, { ...point }]));
		spreadRootNotes(positions, graph);
		for (const [id, point] of positions) {
			const old = before.get(id)!;
			if (!id.slice(prefix.length).startsWith('Note ')) expect(point).toEqual(old);
			expect([point.radius, point.ringRadius, point.ringBandMin, point.ringBandMax]).toEqual([old.radius, old.ringRadius, old.ringBandMin, old.ringBandMax]);
		}
		for (let i = 0; i < 4; i++) {
			const expected = seam ? (i < 2 ? -Math.PI + (i + 1) * (Math.PI - 2) / 3 : 2 + (i - 1) * (Math.PI - 2) / 3) : -0.8 + (i + 1) * 1.6 / 5;
			expect(unwrapAngleNear(positions.get(`${prefix}Note ${i}.md`)!.angle, turn) - turn).toBeCloseTo(expected, 8);
		}
		syncFamilySectors(positions, children);
		const layout = { positions } as RadialLayout;
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
		expect(sectorViolations(graph, layout)).toEqual([]);
	});

	it.each([0, 30, 100])('keeps notes readable beside large continuing subtrees at spin %i', (swirlStrength) => {
		const hub = 'Atlas/Topics/Hub';
		const records: WorldFileRecord[] = [];
		for (let note = 0; note < 8; note++) records.push({ path: `${hub}/Note ${note}.md`, basename: `Note ${note}`, kind: 'note' });
		for (let branch = 0; branch < 3; branch++) for (let note = 0; note < 30; note++) {
			records.push({ path: `${hub}/Branch ${branch}/Next/Next/Next/Next/Next/Next/File ${note}.md`, basename: `File ${note}`, kind: 'note' });
		}
		const graph = completeGraph(records);
		const layout = layoutRadialGraph(graph, { ringSpacing: 1160, nodeSpacing: 144, swirlStrength });
		const parent = layout.positions.get(hub)!;
		const siblings = graph.nodes.filter((n) => n.parentId === hub).map((node) => ({ node, point: layout.positions.get(node.id)! }))
			.sort((a, b) => unwrapAngleNear(a.point.angle, parent.angle) - unwrapAngleNear(b.point.angle, parent.angle));
		const angles = siblings.map(({ point }) => unwrapAngleNear(point.angle, parent.angle));
		const averageGap = (angles[angles.length - 1]! - angles[0]!) / (angles.length - 1);
		for (let i = 0; i < siblings.length; i++) {
			if (siblings[i]!.node.type !== 'note') continue;
			// Having no descendants must not reduce a note to a tiny angular
			// slot alongside folders with dozens of deep descendants.
			if (i > 0) expect(angles[i]! - angles[i - 1]!).toBeGreaterThan(averageGap * 0.6);
			if (i + 1 < angles.length) expect(angles[i + 1]! - angles[i]!).toBeGreaterThan(averageGap * 0.6);
		}
		const radii = siblings.map(({ point }) => point.radius);
		expect(Math.max(...radii) - Math.min(...radii)).toBeLessThan(1e-6);
		expect(hierarchyCrossings(graph, layout)).toEqual([]);
		expect(overlappingNodes(layout)).toEqual([]);
		expect(edgesThroughNodes(graph, layout)).toEqual([]);
		expect(sectorViolations(graph, layout)).toEqual([]);
	});
});
