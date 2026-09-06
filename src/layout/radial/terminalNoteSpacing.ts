import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, normalizeAngle, unwrapAngleNear } from './geometry';
import { HierarchyClearance } from './hierarchyClearance';
import { innerSiblingSpacing } from './siblingSpacing';

/** A terminal note needs room on its own band, not a wedge extending through
 * every outer band. Reuse the empty angle between its sibling branch anchors
 * without moving those branches or changing any radius. */
export function spreadTerminalNotes(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph): void {
	spreadNotes(positions, graph, false);
}

/** Let root notes borrow empty arc between the existing branch anchors. Their
 * folders and descendants keep the layout's weighted angular allocation. */
export function spreadRootNotes(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph): void {
	spreadNotes(positions, graph, true);
}

function spreadNotes(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, rootOnly: boolean): void {
	const children = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target); children.set(edge.source, group);
	}
	const maxDepth = Math.max(1, ...[...positions.values()].filter((p) => !p.external).map((p) => p.depth));
	let clearance: HierarchyClearance | undefined;
	for (const [parentId, ids] of children) {
		const parent = positions.get(parentId)!;
		if ((rootOnly ? parent.depth !== 0 : parent.depth < 1) || ids.length < 2) continue;
		const boost = innerSiblingSpacing(parent.depth + 1, maxDepth);
		if (!rootOnly && boost <= 1) continue;
		const angleCenter = rootOnly ? (parent.sectorStart! + parent.sectorEnd!) / 2 : parent.angle;
		ids.sort((a, b) => unwrapAngleNear(positions.get(a)!.angle, angleCenter) - unwrapAngleNear(positions.get(b)!.angle, angleCenter));
		const points = ids.map((id) => positions.get(id)!);
		const terminal = ids.map((id) => !children.has(id) && graph.nodesById.get(id)?.type === 'note' && !positions.get(id)!.external);
		if (!terminal.some(Boolean)) continue;
		// A flat note-only root already has a full-circle allocation.
		if (rootOnly && terminal.every(Boolean)) continue;
		const angles = points.map((p) => unwrapAngleNear(p.angle, angleCenter));
		const radius = Math.min(...points.map((p) => p.radius));
		const outward = Math.acos(clamp(parent.radius / Math.max(1, radius), 0, 1)) * 0.98;
		const span = angles[angles.length - 1]! - angles[0]!;
		const desiredSpan = Math.max(span, Math.min(1.3, (radius - parent.radius) / Math.max(1, radius) * boost));
		const center = (angles[0]! + angles[angles.length - 1]!) / 2;
		const low = rootOnly ? parent.sectorStart! : Math.max(parent.angle - outward, Math.min(angles[0]!, center - desiredSpan / 2));
		const high = rootOnly ? parent.sectorEnd! : Math.min(parent.angle + outward, Math.max(angles[angles.length - 1]!, center + desiredSpan / 2));
		// A small note-note gap elsewhere in the family must not let a note
		// crowd a larger folder. Preserve each pair's existing physical clearance.
		const minimumGap = Math.min(...angles.slice(1).map((angle, i) => angle - angles[i]!));
		const minimumGaps = angles.slice(1).map((angle, i) => Math.max(minimumGap, Math.min(angle - angles[i]!,
			(points[i]!.nodeRadius + points[i + 1]!.nodeRadius + 6) / Math.max(1, radius))));
		const desired = angles.slice();
		for (let start = 0; start < ids.length;) {
			if (!terminal[start]) { start++; continue; }
			let end = start + 1;
			while (end < ids.length && terminal[end]) end++;
			const leftAnchor = start > 0 || rootOnly, rightAnchor = end < ids.length || rootOnly;
			const left = start > 0 ? angles[start - 1]! : low;
			const right = end < ids.length ? angles[end]! : high;
			const slots = end - start - 1 + Number(leftAnchor) + Number(rightAnchor);
			for (let i = start; i < end; i++) desired[i] = left + (right - left) * (i - start + Number(leftAnchor)) / Math.max(1, slots);
			start = end;
		}
		clearance ??= new HierarchyClearance(positions, graph);
		// Move outward from each crowded run first, so its interior notes can
		// then use the released space without changing sibling order.
		const left = ids.map((_, i) => i).filter((i) => terminal[i] && desired[i]! < angles[i]!);
		const right = ids.map((_, i) => i).filter((i) => terminal[i] && desired[i]! > angles[i]!).reverse();
		for (const i of [...left, ...right]) {
			const point = points[i]!, angle = unwrapAngleNear(point.angle, angleCenter);
			const min = i > 0 ? unwrapAngleNear(points[i - 1]!.angle, angleCenter) + minimumGaps[i - 1]! : low;
			const max = i + 1 < ids.length ? unwrapAngleNear(points[i + 1]!.angle, angleCenter) - minimumGaps[i]! : high;
			if (max < min) continue;
			const target = clamp(desired[i]!, min, max);
			if (Math.abs(target - angle) < 1e-8) continue;
			const before = { ...point };
			const propose = (strength: number) => {
				const delta = (target - angle) * strength, nextAngle = angle + delta;
				return clearance!.accept(new Map([[ids[i]!, { ...before, angle: normalizeAngle(nextAngle),
					x: Math.cos(nextAngle) * before.radius, y: Math.sin(nextAngle) * before.radius,
					sectorStart: before.sectorStart! + delta, sectorEnd: before.sectorEnd! + delta }]]));
			};
			if (propose(1)) continue;
			let accepted = 0, rejected = 1;
			for (let attempt = 0; attempt < 8; attempt++) {
				const strength = (accepted + rejected) / 2;
				if (propose(strength)) accepted = strength;
				else rejected = strength;
			}
		}
	}
}
