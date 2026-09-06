import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, normalizeAngle, shortestAngleDelta, unwrapAngleNear } from './geometry';
import { HierarchyClearance } from './hierarchyClearance';
import { innerSiblingSpacing } from './siblingSpacing';

interface Edge { a: number; b: number; limit: number }
const PRESERVED_DEPTH = 3;

interface Barrier { node: number; edge: Edge; side: number; gap: number; baseGap: number; weight: number; offset: number }

/** Relax angles against the edges crossing each node's actual radius. Radial
 * bands are immutable; adjacent branches can yield together when a fan opens.
 */
export function relaxHierarchyAngles(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, nodeGap: number): void {
	const ids = [...positions.keys()], points = [...positions.values()];
	const indices = new Map(ids.map((id, index) => [id, index]));
	const maxDepth = Math.max(1, ...points.filter((p) => !p.external).map((p) => p.depth));
	const angles = points.map((p) => p.angle);
	// Keep the established top-level allocation and swirl anchors in place.
	const mobility = points.map((p) => p.depth <= PRESERVED_DEPTH ? 0 : 1);
	const children = new Map<number, number[]>();
	const edges: Edge[] = [];
	for (const edge of graph.hierarchyEdges) {
		const a = indices.get(edge.source), b = indices.get(edge.target);
		if (edge.type !== 'hierarchy' || a === undefined || b === undefined) continue;
		edges.push({ a, b, limit: Math.max(Math.abs(shortestAngleDelta(angles[a]!, angles[b]!)), Math.acos(clamp(points[a]!.radius / Math.max(1, points[b]!.radius), 0, 1)) * 0.99) });
		const group = children.get(a) ?? [];
		group.push(b); children.set(a, group);
	}
	const families = [...children].filter(([a, group]) => points[a]!.depth >= 2 && group.length > 1).map(([a, group]) => {
		group.sort((x, y) => unwrapAngleNear(angles[x]!, angles[a]!) - unwrapAngleNear(angles[y]!, angles[a]!));
		const radius = Math.min(...group.map((i) => points[i]!.radius));
		// Count edges crossing this exact radius, including edges from other bands.
		const active = edges.filter((edge) => points[edge.a]!.radius < radius - 1e-6 && points[edge.b]!.radius >= radius - 1e-6).length;
		const boost = innerSiblingSpacing(points[group[0]!]!.depth, maxDepth);
		const gap = Math.max(nodeGap * 2 * boost / Math.max(1, radius), Math.min((radius - points[a]!.radius) * 0.65 / Math.max(1, radius), Math.PI * 1.4 * boost / Math.max(group.length, active), 1.4 / (group.length - 1)));
		const original = group.map((i) => unwrapAngleNear(angles[i]!, angles[a]!));
		const spread = original[original.length - 1]! - original[0]!;
		const minGap = Math.min(...original.slice(1).map((v, i) => v - original[i]!));
		const activeFan = minGap < gap * (boost > 1 ? 0.9 : 0.25) && spread * radius < (radius - points[a]!.radius) * (boost > 1 ? 1 : 0.25);
		const minimumOffsets = [0];
		for (let i = 1; i < group.length; i++) {
			const left = points[group[i - 1]!]!, right = points[group[i]!]!;
			minimumOffsets.push(minimumOffsets[i - 1]! + Math.max(gap * 0.5, (left.nodeRadius + right.nodeRadius + 10) / Math.max(1, Math.min(left.radius, right.radius))));
		}
		return { a, group, gap, original, activeFan, minimumOffsets, offset: (unwrapAngleNear(angles[group[0]!]!, angles[a]!) + unwrapAngleNear(angles[group[group.length - 1]!]!, angles[a]!)) / 2 - angles[a]! };
	});
	if (!families.some((family) => family.activeFan)) return;
	const barriers: Barrier[] = [];
	const coordinates = points.map((p) => ({ x: Math.cos(p.angle) * p.radius, y: Math.sin(p.angle) * p.radius }));
	for (let node = 0; node < points.length; node++) {
		const point = points[node]!;
		if (point.radius < 1) continue;
		let left: { edge: Edge; delta: number } | undefined, right: typeof left;
		for (const edge of edges) {
			if (edge.a === node || edge.b === node || points[edge.a]!.radius > point.radius + 1e-6 || points[edge.b]!.radius < point.radius - 1e-6) continue;
			const crossing = atRadius(coordinates[edge.a]!, coordinates[edge.b]!, point.radius);
			const delta = shortestAngleDelta(point.angle, Math.atan2(crossing.y, crossing.x));
			if (delta < 0 && (!left || delta > left.delta)) left = { edge, delta };
			if (delta >= 0 && (!right || delta < right.delta)) right = { edge, delta };
		}
		for (const near of [left, right]) if (near) {
			const extra = Math.max(points[near.edge.a]!.nodeRadius, points[near.edge.b]!.nodeRadius);
			barriers.push({ node, edge: near.edge, side: near.delta < 0 ? 1 : -1, gap: (point.nodeRadius + extra + 8) / point.radius, baseGap: (point.nodeRadius + extra + 8) / point.radius, weight: 0, offset: 0 });
		}
	}
	// Validate each anchored subtree separately so a crowded, unrelated branch
	// cannot cancel improvements elsewhere in the map.
	const owners = new Map<number, number>();
	const parentOf = new Map(edges.map((edge) => [edge.b, edge.a]));
	const components = new Map<number, number[]>();
	for (const i of points.map((_, i) => i).sort((a, b) => points[a]!.depth - points[b]!.depth)) {
		const parent = parentOf.get(i);
		const owner = points[i]!.depth <= PRESERVED_DEPTH || parent === undefined ? i : owners.get(parent)!;
		owners.set(i, owner);
		if (points[i]!.depth < PRESERVED_DEPTH) continue;
		const component = components.get(owner) ?? [];
		component.push(i); components.set(owner, component);
	}
	const clearance = new HierarchyClearance(positions, graph);
	for (let pass = 0; pass < 4; pass++) {
		const before = angles.slice();
		for (let i = 0; i < points.length; i++) coordinates[i] = { x: Math.cos(angles[i]!) * points[i]!.radius, y: Math.sin(angles[i]!) * points[i]!.radius };
		for (const barrier of barriers) {
			const { a, b } = barrier.edge;
			const start = coordinates[a]!, end = coordinates[b]!;
			const q = atRadius(start, end, points[barrier.node]!.radius);
			// Differentiate the chord / circle intersection with respect to its
			// endpoint angles. Tangential edges require extra angular clearance.
			const denominator = q.x * (end.x - start.x) + q.y * (end.y - start.y);
			barrier.gap = barrier.baseGap / Math.max(0.06, denominator / Math.max(1, points[barrier.node]!.radius * Math.hypot(end.x - start.x, end.y - start.y)));
			barrier.weight = clamp((end.x * (q.x - start.x) + end.y * (q.y - start.y)) / Math.max(1e-9, denominator), 0, 1);
			const linear = angles[barrier.node]! - (1 - barrier.weight) * angles[a]! - barrier.weight * angles[b]!;
			barrier.offset = shortestAngleDelta(Math.atan2(q.y, q.x), angles[barrier.node]!) - linear;
		}
		// First open narrow fans; then settle the ordering and clearance constraints.
		for (let iteration = 0; iteration < 200; iteration++) {
			if (iteration < 100) for (const family of families) {
				if (!family.activeFan || !mobility[family.group[0]!]!) continue;
				const center = (unwrapAngleNear(angles[family.group[0]!]!, angles[family.a]!) + unwrapAngleNear(angles[family.group[family.group.length - 1]!]!, angles[family.a]!)) / 2;
				angles[family.a] = angles[family.a]! + (center - family.offset - angles[family.a]!) * 0.05 * mobility[family.a]!;
			}
			if (iteration < 100) for (const family of families) for (let i = 1; i < family.group.length; i++) {
				if (!family.activeFan || !mobility[family.group[0]!]!) continue;
				const a = family.group[i - 1]!, b = family.group[i]!;
				const gap = unwrapAngleNear(angles[b]!, angles[a]!) - angles[a]!;
				if (gap >= family.gap) continue;
				const shift = (family.gap - gap) * 0.12;
				angles[a] = angles[a]! - shift * mobility[a]!; angles[b] = angles[b]! + shift * mobility[b]!;
			}
			for (let sweep = 0; sweep < 3; sweep++) {
				for (const barrier of barriers) {
					const { a, b } = barrier.edge, n = barrier.node, w = barrier.weight, sign = barrier.side;
					const value = sign * (angles[n]! - (1 - w) * angles[a]! - w * angles[b]! + barrier.offset);
					if (value >= barrier.gap) continue;
					const scale = mobility[n]! + (1 - w) ** 2 * mobility[a]! + w ** 2 * mobility[b]!;
					if (scale < 1e-9) continue;
					const shift = (barrier.gap - value) / scale;
					angles[n] = angles[n]! + sign * shift * mobility[n]!;
					angles[a] = angles[a]! - sign * shift * (1 - w) * mobility[a]!;
					angles[b] = angles[b]! - sign * shift * w * mobility[b]!;
				}
				for (const family of families) {
					if (!mobility[family.group[0]!]!) continue;
					const values = family.group.map((i) => unwrapAngleNear(angles[i]!, angles[family.a]!));
					if (!family.activeFan) {
						const shift = values.reduce((sum, value, i) => sum + value - family.original[i]!, 0) / values.length;
						for (let i = 0; i < values.length; i++) {
							const id = family.group[i]!;
							angles[id] = angles[id]! + family.original[i]! + shift - values[i]!;
						}
						continue;
					}
					const offsets = family.minimumOffsets;
					const blocks: { start: number; end: number; sum: number; count: number }[] = [];
					for (let i = 0; i < values.length; i++) {
						blocks.push({ start: i, end: i, sum: values[i]! - offsets[i]!, count: 1 });
						while (blocks.length > 1) {
							const b = blocks[blocks.length - 1]!, a = blocks[blocks.length - 2]!;
							if (a.sum / a.count <= b.sum / b.count) break;
							a.end = b.end; a.sum += b.sum; a.count += b.count; blocks.pop();
						}
					}
					for (const block of blocks) for (let i = block.start; i <= block.end; i++) {
						const id = family.group[i]!;
						angles[id] = angles[id]! + block.sum / block.count + offsets[i]! - values[i]!;
					}
				}
				for (const edge of edges) {
					if (points[edge.a]!.depth < 2 || mobility[edge.a]! + mobility[edge.b]! === 0) continue;
					const delta = shortestAngleDelta(angles[edge.a]!, angles[edge.b]!);
					const shift = (delta - clamp(delta, -edge.limit, edge.limit)) / (mobility[edge.a]! + mobility[edge.b]!);
					angles[edge.a] = angles[edge.a]! + shift * mobility[edge.a]!; angles[edge.b] = angles[edge.b]! - shift * mobility[edge.b]!;
				}
			}
		}
		const desired = angles.slice();
		for (let i = 0; i < angles.length; i++) angles[i] = before[i]!;
		let accepted = false;
		for (const component of components.values()) {
			if (component.every((i) => Math.abs(desired[i]! - before[i]!) < 1e-9)) continue;
			for (const strength of [1, 0.5, 0.25, 0.125, 0.0625]) {
				const proposed = new Map<string, RadialPoint>();
				for (const i of component) {
					const point = points[i]!, delta = (desired[i]! - before[i]!) * strength;
					const angle = before[i]! + delta;
					proposed.set(ids[i]!, { ...point, angle: normalizeAngle(angle), x: Math.cos(angle) * point.radius, y: Math.sin(angle) * point.radius,
						sectorStart: point.sectorStart! + delta, sectorEnd: point.sectorEnd! + delta });
				}
				if (clearance.accept(proposed)) {
					for (const i of component) angles[i] = before[i]! + (desired[i]! - before[i]!) * strength;
					accepted = true; break;
				}
			}
		}
		if (!accepted) break;
	}
}

function atRadius(a: { x: number; y: number }, b: { x: number; y: number }, radius: number): { x: number; y: number } {
	const dx = b.x - a.x, dy = b.y - a.y;
	const length = dx * dx + dy * dy, dot = a.x * dx + a.y * dy;
	const along = clamp((-dot + Math.sqrt(Math.max(0, dot * dot + length * (radius * radius - a.x * a.x - a.y * a.y)))) / Math.max(1e-9, length), 0, 1);
	return { x: a.x + dx * along, y: a.y + dy * along };
}
