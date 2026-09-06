import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, compareLayoutNode, deterministicUnitOffset, labelArcPadding, setPointAngle, setPointSector, unwrapAngleNear } from './geometry';
import { innerSiblingSpacing } from './siblingSpacing';

/** Assign complete subtree intervals, then position descendants in those intervals.
 * Moving only sibling centers leaves their old, overlapping subtree envelopes behind.
 */
export function arrangeHierarchySectors(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, spin: number): void {
	const children = new Map<string, string[]>();
	const weights = new Map<string, number>();
	const leaves = new Map<string, number>();
	for (const [id, point] of positions) {
		const node = graph.nodesById.get(id);
		weights.set(id, (point.nodeRadius * 2 + (node ? labelArcPadding(node) * 0.5 : 24) + 24) / Math.max(1, point.radius));
		leaves.set(id, 1);
	}
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target);
		children.set(edge.source, group);
	}
	for (const group of children.values()) group.sort((a, b) => compareLayoutNode(graph.nodesById.get(a), graph.nodesById.get(b)));
	const parents = [...children.keys()].sort((a, b) => positions.get(a)!.depth - positions.get(b)!.depth);
	// Carry actual angular demand upwards. Repeatedly compressing a subtree's
	// inherited weight starves long branches that have a side note at each level.
	for (const id of parents.slice().reverse()) {
		const group = children.get(id)!;
		const demand = group.reduce((sum, child) => sum + weights.get(child)!, 0);
		weights.set(id, Math.max(weights.get(id)!, demand));
		leaves.set(id, group.reduce((sum, child) => sum + leaves.get(child)!, 0));
	}
	const turn = spin * (deterministicUnitOffset(graph.rootId || 'vault', 'swirl-direction') >= 0 ? 1 : -1);
	for (const id of parents) {
		const parent = positions.get(id)!;
		const group = children.get(id)!;
		const root = parent.radius < 0.001;
		const parentCenter = ((parent.sectorStart ?? parent.angle) + (parent.sectorEnd ?? parent.angle)) / 2;
		const parentAngle = root ? parent.angle + turn * 0.6 : unwrapAngleNear(parent.angle, parentCenter);
		const inherited = Math.min(Math.PI * 2, parent.sectorSpan ?? Math.PI * 2);
		const start = root ? parentAngle - (group.length === 1 ? Math.PI : 0) : parent.sectorStart ?? parentAngle - inherited / 2;
		const end = start + inherited;
		if (root) setPointSector(parent, start, end);
		if (group.length === 1) {
			const child = positions.get(group[0]!)!;
			setPointAngle(child, parentAngle);
			setPointSector(child, start, end);
			continue;
		}

		const leafFan = group.every((child) => !children.has(child));
		let span = inherited * (root || !leafFan ? 1 : 0.96);
		if (!root && group.length <= 4 && inherited > 1.5 && inherited < Math.PI * 1.98) span *= 0.76;
		if (!leafFan && parent.depth > 1) {
			const childRadius = Math.min(...group.map((child) => positions.get(child)!.radius));
			// A straight edge should leave the parent towards the outside of its ring.
			const outwardSpan = 2 * Math.acos(clamp(parent.radius / Math.max(parent.radius + 1, childRadius), 0, 1));
			span = Math.min(span, outwardSpan * 0.92);
		}
		if (leafFan && parent.depth > 1) {
			const demand = group.reduce((sum, child) => {
				const point = positions.get(child)!;
				const node = graph.nodesById.get(child)!;
				return sum + (point.nodeRadius * 2.6 + labelArcPadding(node) * 1.28 + 34) / Math.max(1, point.radius);
			}, 0);
			const floor = Math.min(inherited * 0.55, 0.18 + Math.log2(group.length + 1) * 0.125, Math.PI * 0.36);
			const comfortable = Math.max(floor, demand * 1.14 + 0.035);
			span = Math.min(span, comfortable * group.length / (group.length - 1));
		}
		const spare = inherited - span;
		const center = root ? start + inherited / 2 : clamp(parentAngle + turn * spare * 0.22, start + span / 2, end - span / 2);
		const minRadius = Math.min(...group.map((child) => positions.get(child)!.radius));
		const gap = Math.min(24 / Math.max(1, minRadius), span * 0.12 / group.length);
		const usable = span - gap * group.length;
		const allocationWeights = group.map((child) => weights.get(child)! * Math.sqrt(leaves.get(child)!));
		const total = allocationWeights.reduce((sum, weight) => sum + weight, 0);
		const minimumSpans = group.map((child) => {
			const point = positions.get(child)!;
			return (point.nodeRadius * 2 + labelArcPadding(graph.nodesById.get(child)!) * 0.5 + 12) / Math.max(1, point.radius);
		});
		const minimumTotal = minimumSpans.reduce((sum, value) => sum + value, 0);
		const minimumBudget = Math.min(usable * 0.5, minimumTotal);
		let cursor = center - span / 2 + gap / 2;
		for (const [index, childId] of group.entries()) {
			const child = positions.get(childId)!;
			const childSpan = minimumBudget * minimumSpans[index]! / minimumTotal + (usable - minimumBudget) * allocationWeights[index]! / total;
			setPointAngle(child, cursor + childSpan / 2);
			setPointSector(child, cursor, cursor + childSpan);
			cursor += childSpan + gap;
		}
	}
}

/** Keep the start of an outgoing branch beyond all of its sibling endpoints.
 * Otherwise an inner folder's descendants cut across the longer edges to notes.
 */
export function separateHierarchyBranches(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, ringGap: number): void {
	const groups = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = groups.get(edge.source) ?? [];
		group.push(edge.target);
		groups.set(edge.source, group);
	}
	const parents = [...groups.keys()].sort((a, b) => positions.get(a)!.depth - positions.get(b)!.depth);
	for (const id of parents) {
		const parent = positions.get(id)!;
		const children = groups.get(id)!;
		let outer = 0;
		for (const childId of children) {
			const child = positions.get(childId)!;
			const cosine = Math.cos(child.angle - parent.angle);
			const minimum = parent.radius + parent.nodeRadius + child.nodeRadius + ringGap * 0.68;
			const outwardRadius = parent.depth > 1 && cosine > 0.05 ? parent.radius / cosine + 8 : 0;
			moveOutward(child, Math.max(child.radius, minimum, outwardRadius));
			outer = Math.max(outer, child.radius);
		}
		const ordered = children.map((childId) => positions.get(childId)!).sort((a, b) => a.angle - b.angle);
		for (let index = 0; index < ordered.length; index++) {
			const a = ordered[index]!;
			const b = ordered[(index + 1) % ordered.length]!;
			if (a === b) continue;
			const sine = Math.abs(Math.sin((b.angle - a.angle) / 2));
			outer = Math.max(outer, (a.nodeRadius + b.nodeRadius + 24) / Math.max(1e-9, 2 * sine));
		}
		// A family shares an attachment radius; different families retain their
		// radial offsets. Longer edges must not pass behind their sibling nodes.
		for (const childId of children) moveOutward(positions.get(childId)!, outer);
	}
}

/** Improve local branching after radial clearance is settled. Only angles and
 * subtree intervals change here; depth rings and every node's radius stay fixed.
 */
export function expandHierarchyFans(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, nodeGap: number): void {
	const maxDepth = Math.max(1, ...[...positions.values()].filter((p) => !p.external).map((p) => p.depth));
	const children = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target);
		children.set(edge.source, group);
	}
	for (const group of children.values()) group.sort((a, b) => positions.get(a)!.sectorStart! - positions.get(b)!.sectorStart!);
	const parents = [...children.keys()].sort((a, b) => positions.get(a)!.depth - positions.get(b)!.depth);
	const original = new Map([...positions].map(([id, point]) => [id, { ...point }]));
	const demand = new Map<string, number>();
	const gaps = new Map<string, number>();
	for (const [id, point] of positions) {
		const label = labelArcPadding(graph.nodesById.get(id)!);
		demand.set(id, (point.nodeRadius * 2 + label * 0.6 + nodeGap * 0.65) / Math.max(1, point.radius));
	}
	for (const id of parents.slice().reverse()) {
		const parent = positions.get(id)!;
		const group = children.get(id)!;
		const radius = Math.min(...group.map((child) => positions.get(child)!.radius));
		const gap = Math.max(24, nodeGap * 0.28) / Math.max(1, radius);
		gaps.set(id, gap);
		const carried = group.reduce((sum, child) => sum + demand.get(child)!, 0) + gap * Math.max(0, group.length - 1);
		// A fork should remain visible when the next hierarchy ring is far away.
		// Carry the complete demand upwards, including through single-child chains.
		const width = Math.max(nodeGap * (group.length - 1), (radius - parent.radius) * 0.6);
		const fan = group.length > 1
			? 2 * Math.asin(clamp(width / Math.max(1, 2 * radius), 0, 0.95)) * group.length / (group.length - 1)
			: 0;
		demand.set(id, Math.max(demand.get(id)!, carried, fan));
	}

	for (const id of parents) {
		const parent = positions.get(id)!;
		const before = original.get(id)!;
		const group = children.get(id)!;
		const start = parent.childSectorStart ?? parent.sectorStart!;
		const end = parent.childSectorEnd ?? parent.sectorEnd!;
		const inherited = end - start;
		const parentAngle = unwrapAngleNear(parent.angle, (start + end) / 2);
		if (group.length === 1) {
			const child = positions.get(group[0]!)!;
			setPointAngle(child, clamp(parentAngle, start, end));
			setPointSector(child, start, end);
			continue;
		}
		const first = original.get(group[0]!)!;
		const last = original.get(group[group.length - 1]!)!;
		const scale = inherited / Math.max(1e-9, before.sectorSpan!);
		const oldSpan = last.sectorEnd! - first.sectorStart!;
		let span = Math.min(inherited, Math.max(oldSpan * scale, demand.get(id)!));
		let minCenter = start + span / 2;
		let maxCenter = end - span / 2;
		if (parent.depth > 1) {
			const radius = Math.min(...group.map((child) => positions.get(child)!.radius));
			const outward = Math.acos(clamp(parent.radius / Math.max(parent.radius + 1, radius), 0, 1)) * 0.98;
			const low = Math.max(start, parentAngle - outward);
			const high = Math.min(end, parentAngle + outward);
			span = Math.min(span, Math.max(1e-9, high - low));
			minCenter = low + span / 2;
			maxCenter = high - span / 2;
		}
		const oldCenter = (first.sectorStart! + last.sectorEnd!) / 2;
		const preferredCenter = start + (oldCenter - before.sectorStart!) * scale;
		const center = clamp(preferredCenter, minCenter, maxCenter);
		const gap = Math.min(gaps.get(id)!, span * 0.12 / group.length);
		const usable = Math.max(1e-9, span - gap * (group.length - 1));
		const previousSpans = group.map((child) => original.get(child)!.sectorSpan!);
		const previousTotal = previousSpans.reduce((sum, value) => sum + value, 0);
		const allocated = previousSpans.map((value) => usable * value / previousTotal);
		const requested = group.map((child) => demand.get(child)!);
		const requestedTotal = requested.reduce((sum, value) => sum + value, 0);
		const targets = requested.map((value) => value * Math.min(1, usable / requestedTotal));
		const floors = allocated.map((value, index) => Math.min(value, Math.max(value * 0.68, targets[index]!)));
		const spare = allocated.reduce((sum, value, index) => sum + value - floors[index]!, 0);
		const deficits = allocated.map((value, index) => Math.max(0, targets[index]! - value));
		const totalDeficit = deficits.reduce((sum, value) => sum + value, 0);
		const transfer = Math.min(spare, totalDeficit);
		const branchSpans = group.map((_, index) => {
			const donated = spare > 0 ? transfer * (allocated[index]! - floors[index]!) / spare : 0;
			const received = totalDeficit > 0 ? transfer * deficits[index]! / totalDeficit : 0;
			return allocated[index]! - donated + received;
		});
		const terminal = group.map((child) => !children.has(child) && graph.nodesById.get(child)?.type === 'note');
		const reserve = parent.depth > 0 && terminal.some(Boolean)
			? usable / group.length * (innerSiblingSpacing(parent.depth + 1, maxDepth) - 1) / 2.5 : 0;
		const nodeSpans = branchSpans.map((width, index) => terminal[index] ? Math.max(width, reserve) : width);
		const nodeTotal = nodeSpans.reduce((sum, width) => sum + width, 0);
		let cursor = center - span / 2, branchCursor = cursor;
		const slots = group.map((childId, index) => {
			const width = nodeSpans[index]! * usable / nodeTotal;
			const start = branchCursor, end = start + branchSpans[index]!;
			const slot = { angle: cursor + width / 2, width, start, end,
				min: children.has(childId) ? start : center - span / 2,
				max: children.has(childId) ? end : center + span / 2 };
			cursor += width + gap; branchCursor = end + gap;
			return slot;
		});
		// Branch anchors stay inside their continuation corridors. Notes can
		// borrow unused angle beside those anchors on this band, while the
		// ordered bounds prevent them from passing a sibling branch.
		for (let i = 1; i < slots.length; i++) slots[i]!.min = Math.max(slots[i]!.min, slots[i - 1]!.min + gap);
		for (let i = slots.length - 2; i >= 0; i--) slots[i]!.max = Math.min(slots[i]!.max, slots[i + 1]!.max - gap);
		for (const [index, childId] of group.entries()) {
			const slot = slots[index]!, angle = clamp(slot.angle, slot.min, slot.max);
			const child = positions.get(childId)!;
			setPointAngle(child, angle);
			setPointSector(child, angle - slot.width / 2, angle + slot.width / 2);
			if (children.has(childId)) {
				child.childSectorStart = slot.start;
				child.childSectorEnd = slot.end;
			}
		}
	}
}

function moveOutward(point: RadialPoint, radius: number): void {
	point.radius = radius;
	point.x = Math.cos(point.angle) * radius;
	point.y = Math.sin(point.angle) * radius;
	point.ringBandMax = Math.max(point.ringBandMax ?? radius, radius);
}
