import { SpatialIndex } from '../../render/SpatialIndex';
import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, normalizeAngle, shortestAngleDelta, unwrapAngleNear } from './geometry';
import { HierarchyClearance } from './hierarchyClearance';
import { siblingDistance } from './siblingDistance';

interface Entry { id: string; point: RadialPoint }
interface Pair { a: Entry; b: Entry; sign: number; required: number; missing: number }

/** Give neighboring glyphs breathing room, including the edges of different
 * families. Only angles change: shared family radii and depth bands are fixed.
 * The exact geometry check also protects every incident hierarchy edge. */
export function separateNearbyNodes(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, nodeGap: number): void {
	const entries = [...positions].filter(([, p]) => !p.external).map(([id, point]) => ({ id, point }));
	const gap = Math.max(24, nodeGap * 2.5);
	const ringDistance = siblingDistance(positions, nodeGap);
	const pairDistance = (a: RadialPoint, b: RadialPoint) => a.depth === 1
		? ringDistance(a, b) : a.nodeRadius + b.nodeRadius + gap;
	const searchGap = Math.max(gap, ...entries.filter(({ point }) => point.depth === 1).map(({ point }) => ringDistance(point, point)));
	const entryById = new Map(entries.map((entry) => [entry.id, entry]));
	// Keep a wider buffer when borrowing room from neighboring nodes. The
	// spacing target below opens cramped pairs; it must not become permission
	// to squeeze a previously readable pair down to that same small target.
	const clearance = new HierarchyClearance(positions, graph, Math.max(gap, nodeGap * 8));
	const children = new Map<string, string[]>(), parents = new Map<string, string>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target); children.set(edge.source, group); parents.set(edge.target, edge.source);
	}
	const neighbors = new Map<string, { left?: string; right?: string; leftGap: number; rightGap: number }>();
	const siblingRanks = new Map<string, number>();
	const spanLimits = new Map<string, number>();
	const siblingPairs: { a: Entry; b: Entry; angle: number }[] = [];
	const familyAngle = (point: RadialPoint) => point.depth === 0 && point.sectorStart !== undefined && point.sectorEnd !== undefined
		? (point.sectorStart + point.sectorEnd) / 2 : point.angle;
	for (const [id, ids] of children) {
		const parent = positions.get(id)!, center = familyAngle(parent);
		ids.sort((a, b) => unwrapAngleNear(positions.get(a)!.angle, center) - unwrapAngleNear(positions.get(b)!.angle, center));
		const angles = ids.map((child) => unwrapAngleNear(positions.get(child)!.angle, center));
		if (positions.get(id)!.depth >= 1) spanLimits.set(id, Math.max(1.3, angles[angles.length - 1]! - angles[0]!));
		const share = parent.depth === 0 ? 0 : (angles[angles.length - 1]! - angles[0]!) / Math.max(1, ids.length - 1) * 0.7;
		const minimumGaps: number[] = [];
		for (let i = 1; i < ids.length; i++) {
			const a = entryById.get(ids[i - 1]!), b = entryById.get(ids[i]!);
			if (!a || !b) { minimumGaps.push(0); continue; }
			// Every sibling gets a share of the existing fan, including terminal
			// notes and deep folders. Descendant count must not reduce a node to
			// a physically non-overlapping but unreadable angular slot.
			const angle = Math.max(requiredAngle(a.point, b.point, pairDistance(a.point, b.point)), share);
			minimumGaps.push(Math.min(angles[i]! - angles[i - 1]!, angle));
			if (a.point.depth > 1) siblingPairs.push({ a, b, angle });
		}
		for (let i = 0; i < ids.length; i++) {
			neighbors.set(ids[i]!, { left: ids[i - 1], right: ids[i + 1], leftGap: minimumGaps[i - 1] ?? 0, rightGap: minimumGaps[i] ?? 0 });
			siblingRanks.set(ids[i]!, i);
		}
	}
	const valid = (proposed: Map<string, RadialPoint>) => {
		const pointAt = (id: string) => proposed.get(id) ?? positions.get(id)!;
		const families = new Set<string>();
		for (const [id, point] of proposed) {
			const parentId = parents.get(id);
			if (parentId !== undefined) {
				families.add(parentId);
				const parent = pointAt(parentId), center = familyAngle(parent), angle = unwrapAngleNear(point.angle, center);
				if (!outward(parent, point)) return false;
				const adjacent = neighbors.get(id)!;
				if (adjacent.left && angle < unwrapAngleNear(pointAt(adjacent.left).angle, center) + adjacent.leftGap - 1e-9) return false;
				if (adjacent.right && angle > unwrapAngleNear(pointAt(adjacent.right).angle, center) - adjacent.rightGap + 1e-9) return false;
				if (parent.depth === 0 && Math.abs(angle - center) >= Math.PI - 1e-9) return false;
			}
			for (const child of children.get(id) ?? []) if (!outward(point, pointAt(child))) return false;
		}
		// Clearance must not accumulate into a wider outer fan than the
		// existing layout allows. A whole family can still translate in angle.
		for (const id of families) {
			const limit = spanLimits.get(id), ids = children.get(id)!;
			if (limit === undefined || ids.length < 2) continue;
			const center = pointAt(id).angle;
			if (unwrapAngleNear(pointAt(ids[ids.length - 1]!).angle, center) - unwrapAngleNear(pointAt(ids[0]!).angle, center) > limit + 1e-9) return false;
		}
		return clearance.accept(proposed);
	};
	for (let pass = 0; pass < 3; pass++) {
		const index = new SpatialIndex(entries, ({ point: p }) => ({
			minX: p.x - p.nodeRadius, maxX: p.x + p.nodeRadius,
			minY: p.y - p.nodeRadius, maxY: p.y + p.nodeRadius,
		}));
		const pairById = new Map<string, Pair>();
		const addPair = (a: Entry, b: Entry, required: number) => {
			if (a.id > b.id) [a, b] = [b, a];
			const angle = shortestAngleDelta(a.point.angle, b.point.angle);
			const missing = Math.max(0, required - Math.abs(angle));
			if (missing < 1e-10) return;
			const key = `${a.id}\0${b.id}`, previous = pairById.get(key);
			if (previous) { previous.required = Math.max(previous.required, required); return; }
			const parentA = parents.get(a.id), parentB = parents.get(b.id);
			const ordering = Math.abs(angle) > 1e-10 ? angle : parentA !== undefined && parentA === parentB
				? siblingRanks.get(b.id)! - siblingRanks.get(a.id)!
				: parentA !== undefined && parentB !== undefined ? shortestAngleDelta(positions.get(parentA)!.angle, positions.get(parentB)!.angle) : 1;
			pairById.set(key, { a, b, sign: ordering < 0 ? -1 : 1, required, missing });
		};
		for (const a of entries) for (const b of index.query(a.point.x, a.point.y, a.point.nodeRadius + (a.point.depth === 1 ? searchGap : gap))) {
			if (a.id >= b.id || a.point.depth !== b.point.depth || a.point.depth === 0) continue;
			// Notes need clearance from both notes and folders on the first ring.
			// Keep the weighted allocation between continuing folder branches.
			if (a.point.depth === 1 && graph.nodesById.get(a.id)?.type !== 'note' && graph.nodesById.get(b.id)?.type !== 'note') continue;
			const distance = pairDistance(a.point, b.point);
			if (Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y) >= distance - 1e-4) continue;
			addPair(a, b, requiredAngle(a.point, b.point, distance));
		}
		for (const { a, b, angle } of siblingPairs) addPair(a, b, angle);
		const pairs = [...pairById.values()], links = new Map<string, Pair[]>();
		for (const pair of pairs) {
			const { a, b } = pair;
			for (const id of [a.id, b.id]) { const list = links.get(id) ?? []; list.push(pair); links.set(id, list); }
		}
		if (!pairs.length) break;
		const visited = new Set<Pair>();
		let moved = false;
		for (const first of pairs) {
			if (visited.has(first)) continue;
			const cluster: Pair[] = [], members = new Map<string, Entry>(), stack = [first];
			while (stack.length) {
				const pair = stack.pop()!;
				if (visited.has(pair)) continue;
				visited.add(pair); cluster.push(pair);
				for (const entry of [pair.a, pair.b]) if (!members.has(entry.id)) {
					members.set(entry.id, entry); stack.push(...links.get(entry.id)!);
				}
			}
			// A previous cluster may have translated a whole family containing
			// one of these nodes. Recompute demand from its current position.
			for (const pair of cluster) pair.missing = Math.max(0, pair.required - pair.sign * shortestAngleDelta(pair.a.point.angle, pair.b.point.angle));
			if (cluster.every((pair) => pair.missing < 1e-10)) continue;
			const shifts = new Map([...members.keys()].map((id) => [id, 0]));
			// Solve a crowded run together so moving one endpoint does not simply
			// transfer the overlap to the next node in that run.
			for (let iteration = 0; iteration < 32; iteration++) for (const pair of cluster) {
				const a = shifts.get(pair.a.id)!, b = shifts.get(pair.b.id)!;
				const shift = Math.max(0, pair.missing - pair.sign * (b - a)) / 2;
				shifts.set(pair.a.id, a - pair.sign * shift); shifts.set(pair.b.id, b + pair.sign * shift);
			}
			const original = new Map([...members].map(([id, entry]) => [id, { ...entry.point }]));
			const proposal = (ids: string[], strength: number) => new Map(ids.map((id) => {
				const point = original.get(id)!, delta = shifts.get(id)! * strength, angle = point.angle + delta;
				return [id, { ...point, angle: normalizeAngle(angle), x: Math.cos(angle) * point.radius, y: Math.sin(angle) * point.radius,
					sectorStart: point.sectorStart! + delta, sectorEnd: point.sectorEnd! + delta }];
			}));
			let accepted = false;
			for (const strength of [1, 0.5, 0.25, 0.125]) {
				if (valid(proposal([...members.keys()], strength))) { moved = accepted = true; break; }
			}
			if (accepted) continue;
			// When an edge node cannot yield without squeezing its own siblings,
			// translate the sibling group in angle instead. This keeps the group's
			// existing internal spacing, radius and ordering exactly intact.
			const familyShifts = new Map<string, number[]>();
			for (const [id, shift] of shifts) {
				const parent = parents.get(id);
				if (parent === undefined) continue;
				const values = familyShifts.get(parent) ?? [];
				values.push(shift); familyShifts.set(parent, values);
			}
			if (familyShifts.size > 1) {
				const translations = [...familyShifts].map(([parent, values]) => ({ parent, shift: values.reduce((sum, value) => sum + value, 0) / values.length }));
				// If one group is pinned by its branches, the other can make room
				// alone without compressing its own internal fan.
				for (const selected of [translations, ...translations.map((entry) => [entry])]) {
					for (const strength of selected.length === translations.length ? [1, 0.5, 0.25, 0.125] : [2, 1, 0.5, 0.25]) {
						const proposed = new Map<string, RadialPoint>();
						for (const { parent, shift } of selected) {
							const delta = shift * strength;
							if (Math.abs(delta) < 1e-10) continue;
							for (const id of children.get(parent)!) {
								const point = positions.get(id)!, angle = point.angle + delta;
								proposed.set(id, { ...point, angle: normalizeAngle(angle), x: Math.cos(angle) * point.radius, y: Math.sin(angle) * point.radius,
									sectorStart: point.sectorStart! + delta, sectorEnd: point.sectorEnd! + delta });
							}
						}
						if (proposed.size && valid(proposed)) { moved = accepted = true; break; }
					}
					if (accepted) break;
				}
			}
			if (accepted) continue;
			// A folder can be pinned by its outgoing edges while an adjacent
			// terminal note still has free space. Allow that endpoint to yield.
			for (const [id] of [...shifts].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
				for (const strength of [2, 1, 0.5, 0.25]) {
					if (valid(proposal([id], strength))) { moved = true; break; }
				}
			}
		}
		if (!moved) break;
	}
}

function outward(parent: RadialPoint, child: RadialPoint): boolean {
	return child.radius > parent.radius && parent.x * (child.x - parent.x) + parent.y * (child.y - parent.y) >= -1e-6;
}

function requiredAngle(a: RadialPoint, b: RadialPoint, distance: number): number {
	// The cosine rule accounts for different groups' staggered radii.
	const radial = a.radius - b.radius;
	return 2 * Math.asin(Math.sqrt(clamp((distance * distance - radial * radial) / Math.max(1, 4 * a.radius * b.radius), 0, 1)));
}
