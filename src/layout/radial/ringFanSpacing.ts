import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, labelArcPadding, normalizeAngle, setPointSector, unwrapAngleNear } from './geometry';
import { HierarchyClearance } from './hierarchyClearance';
import { relaxHierarchyAngles } from './angularRelaxation';
import { spreadBandSiblings } from './bandSiblingSpacing';
import type { DepthBand } from './depthBands';
import { innerSiblingSpacing } from './siblingSpacing';
import { spreadTerminalNotes } from './terminalNoteSpacing';
import { separateNearbyNodes } from './nodeSpacing';

/** Open each crowded family into physically free space on its ring. Descendants
 * rotate with their branch, so every accepted proposal is a complete layout.
 */
export function spreadRingSiblings(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, nodeGap: number, depthBands?: Map<number, DepthBand>): void {
	const children = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target);
		children.set(edge.source, group);
	}
	const parents = [...children.keys()].sort((a, b) => positions.get(a)!.depth - positions.get(b)!.depth);
	const maxDepth = Math.max(1, ...[...positions.values()].filter((p) => !p.external).map((p) => p.depth));
	let clearance: HierarchyClearance | undefined;
	for (const id of parents) {
		const parent = positions.get(id)!;
		const group = children.get(id)!;
		if (parent.depth < 1 || group.length < 2) continue;
		group.sort((a, b) => unwrapAngleNear(positions.get(a)!.angle, parent.angle) - unwrapAngleNear(positions.get(b)!.angle, parent.angle));
		const initialAngles = group.map((child) => unwrapAngleNear(positions.get(child)!.angle, parent.angle));
		const gaps: number[] = [];
		const physicalGaps: number[] = [];
		for (let index = 1; index < group.length; index++) {
			const a = positions.get(group[index - 1]!)!, b = positions.get(group[index]!)!;
			const radius = Math.max(1, Math.min(a.radius, b.radius));
			const label = Math.max(labelArcPadding(graph.nodesById.get(group[index - 1]!)!), labelArcPadding(graph.nodesById.get(group[index]!)!));
			const step = Math.max(0, radius - parent.radius);
			const boost = innerSiblingSpacing(a.depth, maxDepth);
			const readable = Math.min(step * (0.32 + label * 0.002) * boost / radius, 1.3 / (group.length - 1));
			const physical = 2 * Math.asin(clamp((a.nodeRadius + b.nodeRadius + 6) / (2 * radius), 0, 0.95));
			physicalGaps.push(physical);
			gaps.push(Math.max(physical, (nodeGap + label * 1.3) * boost / radius, readable));
		}
		if (gaps.every((gap, index) => initialAngles[index + 1]! - initialAngles[index]! >= gap * 0.98)) continue;
		const radius = Math.min(...group.map((child) => positions.get(child)!.radius));
		const outward = Math.acos(clamp(parent.radius / Math.max(parent.radius + 1, radius), 0, 1)) * 0.96;
		const branches = group.map((child) => {
			const ids: string[] = [];
			const stack = [child];
			while (stack.length) {
				const next = stack.pop()!;
				ids.push(next);
				for (const descendant of children.get(next) ?? []) stack.push(descendant);
			}
			return ids;
		});
		clearance ??= new HierarchyClearance(positions, graph);
		// If the comfortable fan cannot fit, still try the much smaller movement
		// needed to resolve existing endpoint overlaps.
		for (const requested of [gaps, physicalGaps]) {
			const angles = group.map((child) => unwrapAngleNear(positions.get(child)!.angle, parent.angle));
			if (requested.every((gap, index) => angles[index + 1]! - angles[index]! >= gap * 0.999)) continue;
			const desired = spreadAngles(angles, requested, parent.angle - outward, parent.angle + outward);
			for (const strength of [1, 0.5, 0.25, 0.125, 0.0625]) {
				const proposed = new Map<string, RadialPoint>();
				for (let index = 0; index < group.length; index++) {
					const delta = (desired[index]! - angles[index]!) * strength;
					if (Math.abs(delta) < 1e-10) continue;
					for (const childId of branches[index]!) {
						const point = positions.get(childId)!;
						const angle = point.angle + delta;
						proposed.set(childId, { ...point, angle: normalizeAngle(angle), x: Math.cos(angle) * point.radius, y: Math.sin(angle) * point.radius,
							sectorStart: point.sectorStart! + delta, sectorEnd: point.sectorEnd! + delta });
					}
				}
				if (clearance.accept(proposed)) break;
			}
		}
	}
	relaxHierarchyAngles(positions, graph, nodeGap);
	spreadTerminalNotes(positions, graph);
	spreadBandSiblings(positions, graph, nodeGap, depthBands);
	separateNearbyNodes(positions, graph, nodeGap);
	syncFamilySectors(positions, children);
}

export function syncFamilySectors(positions: Map<string, RadialPoint>, children: Map<string, string[]>): void {
	// Angular corridors belong to a family at its actual radial range.
	// Distinct families can reuse an angle at different radii; do not partition
	// an entire hierarchy level as though all its nodes sat on one circle.
	for (const [id, group] of children) {
		const parent = positions.get(id)!;
		const center = parent.depth === 0 ? (parent.sectorStart! + parent.sectorEnd!) / 2 : parent.angle;
		group.sort((a, b) => unwrapAngleNear(positions.get(a)!.angle, center) - unwrapAngleNear(positions.get(b)!.angle, center));
		const angles = group.map((child) => unwrapAngleNear(positions.get(child)!.angle, center));
		if (parent.depth === 0) {
			// Keep root allocations except for boundaries crossed by a local
			// anchor adjustment. Child forests retain their separate corridors.
			for (let i = 0; i < group.length; i++) {
				const child = positions.get(group[i]!)!;
				setPointSector(child, Math.min(child.sectorStart!, angles[i]!), Math.max(child.sectorEnd!, angles[i]!));
				if (!i) continue;
				const previous = positions.get(group[i - 1]!)!;
				if (previous.sectorEnd! <= child.sectorStart!) continue;
				const boundary = clamp((previous.sectorEnd! + child.sectorStart!) / 2, angles[i - 1]!, angles[i]!);
				setPointSector(previous, previous.sectorStart!, boundary);
				setPointSector(child, boundary, child.sectorEnd!);
			}
		}
		for (let i = 0; parent.depth >= 1 && i < group.length; i++) {
			const child = positions.get(group[i]!)!;
			const half = (child.sectorSpan ?? 0) / 2;
			const start = i > 0 ? (angles[i - 1]! + angles[i]!) / 2 : angles[i]! - Math.min(half, group.length > 1 ? (angles[1]! - angles[0]!) / 2 : half);
			const end = i + 1 < group.length ? (angles[i]! + angles[i + 1]!) / 2 : angles[i]! + Math.min(half, group.length > 1 ? (angles[i]! - angles[i - 1]!) / 2 : half);
			setPointSector(child, start, end);
		}
		parent.childSectorStart = Math.min(...group.map((child) => positions.get(child)!.sectorStart!));
		parent.childSectorEnd = Math.max(...group.map((child) => positions.get(child)!.sectorEnd!));
	}
}

function spreadAngles(original: number[], requested: number[], low: number, high: number): number[] {
	const total = requested.reduce((sum, gap) => sum + gap, 0);
	const gaps = requested.map((gap) => gap * Math.min(1, Math.max(0, high - low) / total));
	const offsets = [0];
	for (const gap of gaps) offsets.push(offsets[offsets.length - 1]! + gap);
	// Isotonic regression minimizes movement while enforcing adjacent gaps.
	const blocks: { start: number; end: number; sum: number; count: number }[] = [];
	for (let index = 0; index < original.length; index++) {
		blocks.push({ start: index, end: index, sum: original[index]! - offsets[index]!, count: 1 });
		while (blocks.length > 1) {
			const b = blocks[blocks.length - 1]!, a = blocks[blocks.length - 2]!;
			if (a.sum / a.count <= b.sum / b.count) break;
			a.end = b.end; a.sum += b.sum; a.count += b.count;
			blocks.pop();
		}
	}
	const angles: number[] = [];
	for (const block of blocks) {
		const anchor = clamp(block.sum / block.count, low, high - offsets[offsets.length - 1]!);
		for (let index = block.start; index <= block.end; index++) angles[index] = anchor + offsets[index]!;
	}
	return angles;
}
