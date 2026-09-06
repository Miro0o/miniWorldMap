import type { RadialPoint } from './types';
import { clamp, normalizeAngle, shortestAngleDelta, unwrapAngleNear } from './geometry';
import type { HierarchyClearance } from './hierarchyClearance';

/** Center a whole child forest on its parent when the surrounding space is
 * free. Rotating descendants together preserves each internal fan and all
 * depth bands; clearance checks protect its boundary against other branches.
 */
export function centerHierarchyFamilies(positions: Map<string, RadialPoint>, children: Map<string, string[]>, clearance: HierarchyClearance): void {
	const parents = [...children.keys()].filter((id) => positions.get(id)!.depth >= 1)
		.sort((a, b) => positions.get(a)!.depth - positions.get(b)!.depth || a.localeCompare(b));
	for (const id of parents) {
		const parent = positions.get(id)!, group = children.get(id)!;
		// Preserve the first ring's allocated child forests. Its anchors may
		// still settle toward those forests in the inward pass below.
		if (parent.depth < 2) continue;
		const angles = group.map((child) => unwrapAngleNear(positions.get(child)!.angle, parent.angle));
		const center = (Math.min(...angles) + Math.max(...angles)) / 2;
		const delta = shortestAngleDelta(center, parent.angle);
		if (Math.abs(delta) < 1e-5) continue;
		const descendants: string[] = [];
		const stack = [...group];
		while (stack.length) {
			const next = stack.pop()!;
			descendants.push(next);
			stack.push(...children.get(next) ?? []);
		}
		for (const strength of [1, 0.75, 0.5, 0.25, 0.125, 0.0625]) {
			const turn = delta * strength;
			if (group.some((child) => {
				const point = positions.get(child)!;
				return point.radius * Math.cos(point.angle + turn - parent.angle) < parent.radius - 1e-6;
			})) continue;
			const proposed = new Map(descendants.map((child) => {
				const point = positions.get(child)!, angle = point.angle + turn;
				return [child, { ...point, angle: normalizeAngle(angle), x: Math.cos(angle) * point.radius, y: Math.sin(angle) * point.radius,
					sectorStart: point.sectorStart! + turn, sectorEnd: point.sectorEnd! + turn,
					childSectorStart: point.childSectorStart === undefined ? undefined : point.childSectorStart + turn,
					childSectorEnd: point.childSectorEnd === undefined ? undefined : point.childSectorEnd + turn }];
			}));
			if (clearance.accept(proposed)) break;
		}
	}
	// A child forest can be pinned by neighboring paths even when its parent
	// has room to move along its own band. Settle those parents from the leaves
	// inward, retaining their order among siblings and every outgoing corridor.
	const parentOf = new Map([...children].flatMap(([id, group]) => group.map((child) => [child, id] as const)));
	for (const id of [...parents].reverse()) {
		const point = positions.get(id)!, group = children.get(id)!;
		const upstreamId = parentOf.get(id), upstream = upstreamId === undefined ? undefined : positions.get(upstreamId);
		if (!upstream) continue;
		const angles = group.map((child) => unwrapAngleNear(positions.get(child)!.angle, point.angle));
		const center = (Math.min(...angles) + Math.max(...angles)) / 2;
		// First-ring anchors can use the free arc inside their existing sector,
		// without changing the root's subtree allocation or moving descendants.
		const target = point.depth === 1 && point.sectorStart !== undefined && point.sectorEnd !== undefined
			? clamp(unwrapAngleNear(center, (point.sectorStart + point.sectorEnd) / 2), point.sectorStart, point.sectorEnd) : center;
		const delta = shortestAngleDelta(point.angle, target);
		if (Math.abs(delta) < 1e-5) continue;
		const upstreamAngle = upstream.depth === 0 && upstream.sectorStart !== undefined && upstream.sectorEnd !== undefined
			? (upstream.sectorStart + upstream.sectorEnd) / 2 : upstream.angle;
		const siblings = children.get(upstreamId!)!.map((child) => ({ id: child, angle: unwrapAngleNear(positions.get(child)!.angle, upstreamAngle) }))
			.sort((a, b) => a.angle - b.angle);
		const index = siblings.findIndex((sibling) => sibling.id === id);
		for (const strength of [1, 0.75, 0.5, 0.25, 0.125, 0.0625]) {
			const turn = delta * strength, angle = point.angle + turn;
			const orderedAngle = unwrapAngleNear(angle, upstreamAngle);
			if (index > 0 && orderedAngle <= siblings[index - 1]!.angle) continue;
			if (index + 1 < siblings.length && orderedAngle >= siblings[index + 1]!.angle) continue;
			if (upstream.radius > 0 && point.radius * Math.cos(angle - upstream.angle) < upstream.radius - 1e-6) continue;
			if (group.some((child) => {
				const next = positions.get(child)!;
				return next.radius * Math.cos(next.angle - angle) < point.radius - 1e-6;
			})) continue;
			const next = { ...point, angle: normalizeAngle(angle), x: Math.cos(angle) * point.radius, y: Math.sin(angle) * point.radius,
				sectorStart: point.sectorStart! + (point.depth === 1 ? 0 : turn), sectorEnd: point.sectorEnd! + (point.depth === 1 ? 0 : turn) };
			if (clearance.accept(new Map([[id, next]]))) break;
		}
	}
}
