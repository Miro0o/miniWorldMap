import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, normalizeAngle, shortestAngleDelta, unwrapAngleNear } from './geometry';
import { HierarchyClearance } from './hierarchyClearance';
import type { DepthBand } from './depthBands';
import { siblingAngle, siblingDistance } from './siblingDistance';
import { centerHierarchyFamilies } from './familyCentering';

interface Family {
	parent: RadialPoint;
	ids: string[];
	points: RadialPoint[];
	depth: number;
}

/** A family shares one radius. Only whole families change radial lanes; the
 * original depth baselines and annular bounds remain immutable. */
export function spreadBandSiblings(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, nodeGap: number, depthBands?: Map<number, DepthBand>, clearanceSpacing?: { gap: number; radiusScale: number; radius?: (point: RadialPoint) => number; distance?: (a: RadialPoint, b: RadialPoint) => number; comfortableScale?: number; fanAspect?: number }): void {
	const children = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target); children.set(edge.source, group);
	}
	// Keep the root allocation, but let the inner sibling groups use the same
	// band and angular clearance rules as the deeper groups.
	const families: Family[] = [...children].filter(([id, group]) => positions.get(id)!.depth >= 1 && group.length > 1).map(([id, ids]) => {
		const parent = positions.get(id)!;
		ids.sort((a, b) => unwrapAngleNear(positions.get(a)!.angle, parent.angle) - unwrapAngleNear(positions.get(b)!.angle, parent.angle));
		return { parent, ids, points: ids.map((id) => positions.get(id)!), depth: positions.get(ids[0]!)!.depth };
	}).sort((a, b) => a.depth - b.depth || a.parent.angle - b.parent.angle);
	const branchGap = (point: RadialPoint) => Math.max(nodeGap * 4, ((point.ringBandMax ?? point.radius) - (point.ringBandMin ?? point.radius)) * 0.1);
	const clearance = new HierarchyClearance(positions, graph, clearanceSpacing?.gap ?? 4, clearanceSpacing?.radiusScale ?? 1, clearanceSpacing?.radius, branchGap);
	const distance = clearanceSpacing?.distance ?? siblingDistance(positions, nodeGap);
	const bodyRadius = (point: RadialPoint) => Math.max(point.nodeRadius * (clearanceSpacing?.radiusScale ?? 1), clearanceSpacing?.radius?.(point) ?? 0);
	const pairDistance = (a: RadialPoint, b: RadialPoint) => Math.max(distance(a, b) * (clearanceSpacing?.comfortableScale ?? 1), bodyRadius(a) + bodyRadius(b) + (clearanceSpacing?.gap ?? 4) + 8);
	const familyDistance = (family: Family, a: RadialPoint, b: RadialPoint, radius: number) => Math.max(pairDistance(a, b),
		(radius - family.parent.radius) * (clearanceSpacing?.fanAspect ?? 0) / Math.max(1, family.points.length - 1));
	const byDepth = new Map<number, Family[]>();
	for (const family of families) {
		const group = byDepth.get(family.depth) ?? [];
		group.push(family); byDepth.set(family.depth, group);
	}
	const bounds = (family: Family): { min: number; max: number } => {
		let min = depthBands?.get(family.depth)?.min ?? 0, max = depthBands?.get(family.depth)?.max ?? Infinity;
		for (let i = 0; i < family.points.length; i++) {
			const point = family.points[i]!;
			const low = point.ringBandMin ?? point.radius, high = point.ringBandMax ?? point.radius;
			const padding = (high - low) * 0.04;
			min = Math.max(min, low + padding, family.parent.radius + Math.min(nodeGap * 2, (point.radius - family.parent.radius) * 0.5));
			max = Math.min(max, high - padding);
			for (const id of children.get(family.ids[i]!) ?? []) {
				const child = positions.get(id)!;
				max = Math.min(max, child.radius - Math.min(nodeGap * 2, (child.radius - point.radius) * 0.5));
			}
		}
		return { min, max };
	};
	const descendants = new Map<string, string[]>();
	const branchBelow = (id: string): string[] => {
		const cached = descendants.get(id);
		if (cached) return cached;
		const result: string[] = [], stack = [...children.get(id) ?? []];
		while (stack.length) {
			const next = stack.pop()!;
			result.push(next); stack.push(...children.get(next) ?? []);
		}
		descendants.set(id, result);
		return result;
	};
	const propose = (family: Family, radius: number, angles: number[]): Map<string, RadialPoint> | undefined => {
		const proposed = new Map<string, RadialPoint>();
		for (let i = 0; i < family.points.length; i++) {
			const point = family.points[i]!, angle = angles[i]!, delta = shortestAngleDelta(point.angle, angle);
			const next = { ...point, radius, angle: normalizeAngle(angle), x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
				sectorStart: point.sectorStart! + delta, sectorEnd: point.sectorEnd! + delta };
			if (!outward(family.parent, next)) return undefined;
			proposed.set(family.ids[i]!, next);
			const childrenAngles = (children.get(family.ids[i]!) ?? []).map((id) => unwrapAngleNear(positions.get(id)!.angle, point.angle));
			const childCenter = childrenAngles.length ? (Math.min(...childrenAngles) + Math.max(...childrenAngles)) / 2 : point.angle;
			const carriesBranch = Math.abs(shortestAngleDelta(angle, childCenter)) > Math.abs(shortestAngleDelta(point.angle, childCenter)) + 1e-8;
			// An angular lane adjustment moves the branch with its endpoint.
			// Leaving descendants behind creates skew that later passes cannot
			// repair once neighboring branches have occupied the free corridor.
			if (carriesBranch && Math.abs(delta) > 1e-10) for (const id of branchBelow(family.ids[i]!)) {
				const child = positions.get(id)!, childAngle = child.angle + delta;
				proposed.set(id, { ...child, angle: normalizeAngle(childAngle), x: Math.cos(childAngle) * child.radius, y: Math.sin(childAngle) * child.radius,
					sectorStart: child.sectorStart! + delta, sectorEnd: child.sectorEnd! + delta,
					childSectorStart: child.childSectorStart === undefined ? undefined : child.childSectorStart + delta,
					childSectorEnd: child.childSectorEnd === undefined ? undefined : child.childSectorEnd + delta });
			}
			const nextChildren = (children.get(family.ids[i]!) ?? []).map((id) => proposed.get(id) ?? positions.get(id)!);
			if (nextChildren.some((child) => !outward(next, child))) return undefined;
		}
		return proposed;
	};
	// Stagger neighboring families whose desired fans compete for the same
	// angular space, using separated lanes across the available band width.
	for (const family of families) {
		const { min, max } = bounds(family);
		if (max < min) continue;
		const radius = familyRadius(family), center = familyCenter(family), width = Math.max(1, max - min);
		const currentSpan = unwrapAngleNear(family.points[family.points.length - 1]!.angle, center)
			- unwrapAngleNear(family.points[0]!.angle, center);
		const reach = fanReach(family);
		const neighbors = (byDepth.get(family.depth) ?? []).filter((other) => other !== family).map((other) => ({
			radius: familyRadius(other),
			proximity: Math.max(0, 1 - Math.abs(shortestAngleDelta(center, familyCenter(other))) / Math.max(1e-6, reach + fanReach(other))),
		})).filter((other) => other.proximity > 0);
		const occupied = [...new Set([min, max, ...neighbors.map((other) => clamp(other.radius, min, max))])].sort((a, b) => a - b);
		const freeLanes = occupied.slice(1).map((r, i) => ({ radius: (r + occupied[i]!) / 2, width: r - occupied[i]! }))
			.sort((a, b) => b.width - a.width).slice(0, 3).map((lane) => lane.radius);
		const lane = [0, 0.5, 1, 0.25, 0.75][byDepth.get(family.depth)!.indexOf(family) % 5]!;
		const preferred = min + (max - min) * lane;
		const candidates = [...new Set([preferred, clamp(radius, min, max), ...freeLanes, ...[0, 0.25, 0.5, 0.75, 1].map((t) => min + (max - min) * t)])];
		const cost = (r: number) => neighbors.reduce((sum, other) => sum + other.proximity * Math.exp(-(((r - other.radius) / (width * 0.28)) ** 2)), 0) * 1.8 + Math.abs(r - preferred) / width * 1.5;
		// Score distance error in both directions: a sparse outer fan must be
		// allowed to contract just as a crowded inner fan needs to open.
		const spacingError = (angles: number[], r: number) => angles.slice(1).reduce((sum, angle, i) => {
			const actual = 2 * r * Math.sin((angle - angles[i]!) / 2);
			return sum + Math.abs(Math.log(Math.max(1e-9, actual / familyDistance(family, family.points[i]!, family.points[i + 1]!, r))));
		}, 0) / (angles.length - 1);
		const offers = candidates.flatMap((nextRadius) => {
			const angles = family.points.map((p) => unwrapAngleNear(p.angle, center));
			const offsets = [0];
			for (let i = 1; i < angles.length; i++) offsets.push(offsets[i - 1]! + siblingAngle(familyDistance(family, family.points[i - 1]!, family.points[i]!, nextRadius), nextRadius));
			const target = offsets[offsets.length - 1]!;
			const desired = offsets.map((offset) => center + offset - target / 2);
			return [1, 0.5, 0.125, 0.03125, 0].flatMap((strength) => {
				const next = angles.map((angle, i) => angle + (desired[i]! - angle) * strength);
				const added = (next[next.length - 1]! - next[0]! - currentSpan) / 2;
				const alignment = shortestAngleDelta(center, family.parent.angle);
				const shifts = [...new Set([alignment, alignment * 0.5, 0, ...(family.points.length <= 8 && Math.abs(added) > 1e-9 ? [-added, added] : [])])];
				return shifts.map((shift) => ({ radius: nextRadius, angles: next.map((angle) => angle + shift),
					cost: cost(nextRadius) + spacingError(next, nextRadius) * 6
						+ Math.abs(shortestAngleDelta(family.parent.angle, center + shift)) / Math.max(0.01, target) }));
			});
		});
		offers.sort((a, b) => a.cost - b.cost || Math.abs(a.radius - radius) - Math.abs(b.radius - radius));
		for (const offer of offers) {
			// A fixed physical distance can require too much angle on an inner
			// lane. Keep the existing fan budget and check the outward corridors.
			if (offer.angles[offer.angles.length - 1]! - offer.angles[0]! > Math.max(currentSpan, 1.3) + 1e-8) continue;
			const proposal = propose(family, offer.radius, offer.angles);
			if (proposal && clearance.accept(proposal, proposal.size > family.points.length)) break;
		}
	}
	// Once neighboring groups have found lanes, settle toward the same chord
	// lengths again. This also recovers space released by contracting outer fans.
	for (const family of families) {
		const { min, max } = bounds(family);
		if (max < min) continue;
		const radius = clamp(familyRadius(family), min, max);
		const angles = family.points.map((p) => unwrapAngleNear(p.angle, family.parent.angle));
		const offsets = [0];
		for (let i = 1; i < angles.length; i++) offsets.push(offsets[i - 1]! + siblingAngle(familyDistance(family, family.points[i - 1]!, family.points[i]!, radius), radius));
		const target = offsets[offsets.length - 1]!;
		if (target > Math.max(1.3, angles[angles.length - 1]! - angles[0]!) + 1e-8) continue;
		const center = (angles[0]! + angles[angles.length - 1]!) / 2;
		const desired = offsets.map((offset) => center + offset - target / 2);
		if (desired.every((angle, i) => Math.abs(angle - angles[i]!) < 1e-9)) continue;
		for (const strength of [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.0078125]) {
			const proposal = propose(family, radius, angles.map((angle, i) => angle + (desired[i]! - angle) * strength));
			if (proposal && clearance.accept(proposal, proposal.size > family.points.length)) break;
		}
	}
	// A branch anchor can block a whole-family move even when the terminal
	// siblings beside it have room. Settle those runs without moving the anchor
	// or reserving an outer subtree sector for a terminal node.
	for (const family of families) {
		if (family.ids.every((id) => !children.has(id))) continue;
		const radius = familyRadius(family);
		if (family.points.some((point) => Math.abs(point.radius - radius) > 1e-6)) continue;
		for (let first = 0; first < family.ids.length;) {
			if (children.has(family.ids[first]!)) { first++; continue; }
			let end = first + 1;
			while (end < family.ids.length && !children.has(family.ids[end]!)) end++;
			const angles = family.points.map((point) => unwrapAngleNear(point.angle, family.parent.angle));
			const offsets = [0];
			for (let i = first + 1; i < end; i++) offsets.push(offsets[offsets.length - 1]! + siblingAngle(familyDistance(family, family.points[i - 1]!, family.points[i]!, radius), radius));
			const span = offsets[offsets.length - 1]!;
			const outer = Math.acos(clamp(family.parent.radius / radius, 0, 1)) * 0.98;
			const low = first ? angles[first - 1]! + siblingAngle(familyDistance(family, family.points[first - 1]!, family.points[first]!, radius), radius) : family.parent.angle - Math.min(0.65, outer);
			const high = end < angles.length ? angles[end]! - siblingAngle(familyDistance(family, family.points[end - 1]!, family.points[end]!, radius), radius) : family.parent.angle + Math.min(0.65, outer);
			if (high - low >= span) {
				const center = clamp((angles[first]! + angles[end - 1]!) / 2, low + span / 2, high - span / 2);
				for (const strength of [1, 0.5, 0.25, 0.125]) {
					const next = angles.map((angle, i) => i < first || i >= end ? angle : angle + (center + offsets[i - first]! - span / 2 - angle) * strength);
					if (next[next.length - 1]! - next[0]! > Math.max(1.3, angles[angles.length - 1]! - angles[0]!) + 1e-8) continue;
					const proposal = propose(family, radius, next);
					if (proposal && clearance.accept(proposal, false)) break;
				}
			}
			first = end;
		}
	}
	centerHierarchyFamilies(positions, children, clearance);
}

function familyRadius(family: Family): number {
	const radii = family.points.map((p) => p.radius).sort((a, b) => a - b);
	return radii[Math.floor(radii.length / 2)]!;
}

function familyCenter(family: Family): number {
	return (unwrapAngleNear(family.points[0]!.angle, family.parent.angle) + unwrapAngleNear(family.points[family.points.length - 1]!.angle, family.parent.angle)) / 2;
}

function fanReach(family: Family): number {
	const radius = familyRadius(family);
	const span = unwrapAngleNear(family.points[family.points.length - 1]!.angle, family.parent.angle) - unwrapAngleNear(family.points[0]!.angle, family.parent.angle);
	return Math.max(span / 2, Math.min(0.3, Math.max(0, radius - family.parent.radius) * 0.35 / Math.max(1, radius)));
}

function outward(parent: RadialPoint, child: RadialPoint): boolean {
	return child.radius > parent.radius && parent.x * (child.x - parent.x) + parent.y * (child.y - parent.y) >= -1e-6;
}
