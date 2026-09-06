import { DEFAULT_RADIAL_SETTINGS } from '../../src/settings';
import { buildWorldMap } from '../../src/world/buildWorldMap';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../../src/world/visibleGraph';
import type { LinkTable, VisibleWorldGraph, WorldFileRecord } from '../../src/world/types';
import type { RadialLayout } from '../../src/layout/radial/layoutRadial';
import { unwrapAngleNear } from '../../src/layout/radial/geometry';

export function crowdedArchiveRecords(): { records: WorldFileRecord[]; hub: string } {
	const records: WorldFileRecord[] = [];
	let path = 'Archive';
	for (let depth = 0; depth < 8; depth++) {
		for (let group = 0; group < 8; group++) for (let leaf = 0; leaf < 12; leaf++) {
			records.push({ path: `${path}/Topic ${group}/Note ${leaf}.md`, basename: `Note ${leaf}`, kind: 'note' });
		}
		path += '/Next';
	}
	const hub = `${path}/Projects`;
	for (let project = 0; project < 6; project++) {
		records.push({ path: `${hub}/Project ${project}.md`, basename: `Project ${project}`, kind: 'note' });
		for (let note = 0; note < 4; note++) {
			records.push({ path: `${hub}/Project ${project}/Part ${note}.md`, basename: `Part ${note}`, kind: 'note' });
		}
	}
	return { records, hub };
}

export function mixedBranchRecords(): WorldFileRecord[] {
	return [
		'Trunk/Hub/Note A.md',
		'Trunk/Hub/Branch A/Chain/End.md',
		'Trunk/Hub/Note B.md',
		'Trunk/Hub/Note C.md',
		'Trunk/Hub/Branch B/Note.md',
		'Trunk/Hub/Branch B/Empty A',
		'Trunk/Hub/Branch B/Empty B',
	].map((path) => ({ path, basename: path.split('/').pop()!.replace(/\.md$/, ''), kind: path.endsWith('.md') ? 'note' : 'folder' }));
}

export function generatedTreeRecords(seed: number, limit = 160): WorldFileRecord[] {
	const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
	const records: WorldFileRecord[] = [];
	const visit = (parent: string, depth: number) => {
		const count = depth === 0 ? 2 + Math.floor(random() * 5) : 1 + Math.floor(random() * (depth < 3 ? 7 : 4));
		for (let i = 0; i < count && records.length < limit; i++) {
			const kind = depth < 4 && (depth < 1 || random() < 0.48) ? 'folder' : 'note';
			const basename = `${kind === 'folder' ? 'F' : 'N'}${i}`;
			const path = `${parent ? parent + '/' : ''}${basename}${kind === 'note' ? '.md' : ''}`;
			records.push({ path, basename, kind });
			if (kind === 'folder') visit(path, depth + 1);
		}
	};
	visit('', 0);
	return records;
}

export function completeGraph(records: WorldFileRecord[], rootPath = '', resolved: LinkTable = {}): VisibleWorldGraph {
	return buildVisibleWorldGraph(buildWorldMap(records, resolved, {}, DEFAULT_RADIAL_SETTINGS), {
		...defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS),
		rootPath,
		showCompleteRoot: true,
		showLinkOverlay: Object.keys(resolved).length > 0,
		nodeLimit: 20_000,
	}, DEFAULT_RADIAL_SETTINGS);
}

type Point = { x: number; y: number };
function cross(a: Point, b: Point, c: Point): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function hierarchyCrossings(graph: VisibleWorldGraph, layout: RadialLayout): string[] {
	const edges = graph.hierarchyEdges.filter((e) => e.type === 'hierarchy' && layout.positions.has(e.source) && layout.positions.has(e.target));
	const crossings: string[] = [];
	for (let i = 0; i < edges.length; i++) {
		const a = edges[i]!;
		const p = layout.positions.get(a.source)!;
		const q = layout.positions.get(a.target)!;
		for (let j = i + 1; j < edges.length; j++) {
			const b = edges[j]!;
			if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue;
			const r = layout.positions.get(b.source)!;
			const s = layout.positions.get(b.target)!;
			if (cross(p, q, r) * cross(p, q, s) < -1e-6 && cross(r, s, p) * cross(r, s, q) < -1e-6) {
				crossings.push(`${a.source} -> ${a.target} x ${b.source} -> ${b.target}`);
			}
		}
	}
	return crossings;
}

export function overlappingNodes(layout: RadialLayout): string[] {
	const entries = [...layout.positions];
	const overlaps: string[] = [];
	for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
		const [a, p] = entries[i]!;
		const [b, q] = entries[j]!;
		if (Math.hypot(p.x - q.x, p.y - q.y) < p.nodeRadius + q.nodeRadius + 4) overlaps.push(`${a} x ${b}`);
	}
	return overlaps;
}

export function edgesThroughNodes(graph: VisibleWorldGraph, layout: RadialLayout): string[] {
	const hits: string[] = [];
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy') continue;
		const a = layout.positions.get(edge.source)!;
		const b = layout.positions.get(edge.target)!;
		const dx = b.x - a.x, dy = b.y - a.y;
		const lengthSquared = dx * dx + dy * dy;
		for (const [id, point] of layout.positions) {
			if (id === edge.source || id === edge.target) continue;
			const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
			if (Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) < point.nodeRadius + 2) {
				hits.push(`${edge.source} -> ${edge.target} through ${id}`);
			}
		}
	}
	return hits;
}

export function sectorViolations(graph: VisibleWorldGraph, layout: RadialLayout): string[] {
	const violations: string[] = [];
	for (const [id, point] of layout.positions) {
		const angle = unwrapAngleNear(point.angle, (point.sectorStart! + point.sectorEnd!) / 2);
		if (angle < point.sectorStart! - 1e-8 || angle > point.sectorEnd! + 1e-8) violations.push(`outside own sector: ${id}`);
	}

	const groups = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy') continue;
		const parent = layout.positions.get(edge.source)!;
		const child = layout.positions.get(edge.target)!;
		if (child.sectorStart! < (parent.childSectorStart ?? parent.sectorStart!) - 1e-8 || child.sectorEnd! > (parent.childSectorEnd ?? parent.sectorEnd!) + 1e-8) {
			violations.push(`outside parent: ${edge.target}`);
		}
		const group = groups.get(edge.source) ?? [];
		group.push(edge.target);
		groups.set(edge.source, group);
	}
	for (const group of groups.values()) {
		group.sort((a, b) => layout.positions.get(a)!.sectorStart! - layout.positions.get(b)!.sectorStart!);
		for (let i = 1; i < group.length; i++) {
			if (layout.positions.get(group[i - 1]!)!.sectorEnd! > layout.positions.get(group[i]!)!.sectorStart! + 1e-8) {
				violations.push(`overlapping sectors: ${group[i - 1]} / ${group[i]}`);
			}
		}
	}
	return violations;
}
