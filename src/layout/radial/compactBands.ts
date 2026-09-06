import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { clamp, normalizeAngle, setPointSector, unwrapAngleNear } from './geometry';
import { HierarchyClearance } from './hierarchyClearance';
import { solveBandConstraints, type BandConstraint } from './bandConstraints';
import { spreadBandSiblings } from './bandSiblingSpacing';
import { syncFamilySectors } from './ringFanSpacing';
import { siblingAngle, siblingDistance, siblingSpacingUnit } from './siblingDistance';
import { separateNearbyNodes } from './nodeSpacing';

const TAU = Math.PI * 2;
const SEAM_GAP = 0.16;
const NODE_CLEARANCE_FACTOR = 3.4;
const NODE_BODY_CLEARANCE_FACTOR = 8;
const NODE_GAP_CLEARANCE_FACTOR = 9;

interface Band {
	radius: number;
	min: number;
	max: number;
}

/** Redistribute a stretched hierarchy into separate depth bands with enough capacity. Each
 * depth keeps a separate annular band. Population sets the overall scale; a
 * minimum radial step keeps successive depths visibly separated.
 *
 * A depth-first order puts every family's children next to one another on
 * their band. Ordered endpoints and outward edges provide a planar starting
 * layout; the final clearance check also protects node bodies near the edges.
 */
export function compactHierarchyBands(
	positions: Map<string, RadialPoint>, graph: VisibleWorldGraph,
	ringTargets: Map<number, number>, ringGap: number, nodeGap: number,
): boolean {
	const root = positions.get(graph.rootId);
	if (!root || root.depth !== 0) return false;
	const children = new Map<string, string[]>();
	const parentOf = new Map<string, string>();
	for (const edge of graph.hierarchyEdges) {
		if (edge.type !== 'hierarchy' || !positions.has(edge.source) || !positions.has(edge.target)) continue;
		const group = children.get(edge.source) ?? [];
		group.push(edge.target);
		children.set(edge.source, group);
		parentOf.set(edge.target, edge.source);
	}
	for (const [id, group] of children) {
		const parent = positions.get(id)!;
		group.sort((a, b) => parent.depth === 0
			? positions.get(a)!.sectorStart! - positions.get(b)!.sectorStart!
			: unwrapAngleNear(positions.get(a)!.angle, parent.angle) - unwrapAngleNear(positions.get(b)!.angle, parent.angle));
	}
	const ids: string[] = [];
	const levels = new Map<number, number[]>();
	const stack = [graph.rootId];
	const visited = new Set<string>();
	while (stack.length) {
		const id = stack.pop()!;
		if (visited.has(id)) return false;
		visited.add(id);
		const point = positions.get(id)!;
		const row = levels.get(point.depth) ?? [];
		row.push(ids.length);
		levels.set(point.depth, row);
		ids.push(id);
		const group = children.get(id) ?? [];
		for (let i = group.length - 1; i >= 0; i--) stack.push(group[i]!);
	}
	// Disconnected nodes keep the existing outer-shell placement.
	if (ids.length !== positions.size) return false;
	const baseBands = compactBandTargets(levels, ids.map((id) => positions.get(id)!), ringGap, nodeGap);
	const oldOuter = Math.max(...[...positions.values()].map((p) => p.radius));

	// The ordinary layout already handles small maps. Repack only when there
	// is substantial stretching relative to the requested layer spacing.
	if (oldOuter < ringGap * Math.max(...levels.keys()) * 12) return false;
	const indices = new Map(ids.map((id, index) => [id, index]));
	// Freeze the spacing reference before adding capacity. Enlarging the bands
	// must not enlarge their demand again and create a moving target.
	const reference = new Map(ids.map((id) => [id, { ...positions.get(id)!, ringRadius: baseBands.get(positions.get(id)!.depth)!.radius }]));
	const distance = siblingDistance(reference, nodeGap);
	const spacingUnit = siblingSpacingUnit(reference, nodeGap);
	const spacingRadius = (point: RadialPoint) => Math.max(point.nodeRadius * NODE_BODY_CLEARANCE_FACTOR, distance(point, point) / 2 - nodeGap * NODE_GAP_CLEARANCE_FACTOR / 2);
	const requiredRadii = new Map<number, number>();
	for (const [depth, row] of levels) {
		if (!depth) continue;
		let demand = 0;
		for (let i = 1; i < row.length; i++) {
			const a = reference.get(ids[row[i - 1]!]!)!, b = reference.get(ids[row[i]!]!)!;
			const boundary = parentOf.get(ids[row[i - 1]!]!) === parentOf.get(ids[row[i]!]!) ? 1 : 1.7;
			demand += (spacingRadius(a) + spacingRadius(b) + nodeGap * NODE_GAP_CLEARANCE_FACTOR + 8) * boundary;
		}
		requiredRadii.set(depth, Math.max(baseBands.get(depth)!.radius, demand / ((TAU - SEAM_GAP) * 0.85)));
	}
	const depths = [...requiredRadii.keys()].sort((a, b) => a - b);
	const steps = new Map<number, number>();
	let outer = 0, previousStep = 0;
	for (const depth of depths) {
		const step = Math.max(previousStep, requiredRadii.get(depth)! - outer);
		steps.set(depth, step); outer += step; previousStep = step;
	}
	// Share an abrupt capacity jump with preceding bands. Sparse inner levels
	// retain smaller radii, while no later band collapses onto its predecessor.
	for (let i = depths.length - 1; i > 0; i--) {
		const depth = depths[i]!, previous = depths[i - 1]!;
		steps.set(previous, Math.max(steps.get(previous)!, steps.get(depth)! / 2));
	}
	const rootAngle = root.angle, rootSectorStart = root.sectorStart;
	let scale = 1;
	// A failed corridor fit asks for more circumference, rather than reducing
	// the requested sibling clearance. All depth bands expand together.
	for (let attempt = 0; attempt < 6; attempt++, scale *= 1.4) {
		const bands = new Map<number, Band>([[0, { radius: 0, min: 0, max: 0 }]]);
		let radius = 0;
		for (const depth of depths) {
			const step = steps.get(depth)! * scale;
			radius += step;
			bands.set(depth, { radius, min: radius - step * 0.4, max: radius + step * 0.4 });
		}
		if (placeInBands(bands)) return true;
	}
	return false;

	function placeInBands(bands: Map<number, Band>): boolean {
		const proposed = new Map(ids.map((id) => {
			const point = positions.get(id)!, band = bands.get(point.depth)!;
			return [id, { ...point, radius: band.radius, ringRadius: band.radius, ringBandMin: band.min, ringBandMax: band.max, siblingSpacing: spacingUnit }];
		}));
		const points = ids.map((id) => proposed.get(id)!);
		const pairArc = (a: RadialPoint, b: RadialPoint) => siblingAngle(spacingRadius(a) + spacingRadius(b) + nodeGap * NODE_GAP_CLEARANCE_FACTOR + 8, a.radius);
		const constraints: BandConstraint[] = [];
		const add = (a: number, b: number, base: number, extra = 0, priority = 1) => { constraints.push({ a, b, base, extra, priority }); };
		const departures = bandDepartureLimits(levels, points, nodeGap);
		for (const [id, group] of children) {
			const a = indices.get(id)!, parent = points[a]!;
			for (const childId of group) {
				const b = indices.get(childId)!, child = points[b]!;
				if (parent.radius === 0) continue;
				// Keep chords outside the source band, with clearance from a tangent.
				const departure = departures.get(a)!;
				const limit = departure - Math.asin(clamp(parent.radius / child.radius, 0, 1) * Math.sin(departure));
				add(a, b, -limit);
				add(b, a, -limit);
			}
			// Small forks need their parent beside the fan. Without this bound,
			// individually separated children can still trail a long diagonal edge.
			if (parent.depth >= 3 && group.length >= 2 && group.length <= 7) {
				const first = indices.get(group[0]!)!, last = indices.get(group[group.length - 1]!)!;
				const child = points[first]!;
				const slack = (child.radius - parent.radius) / child.radius * 0.1;
				add(first, a, -slack);
				add(a, last, -slack);
			}

		}
		for (const [depth, row] of levels) {
			if (depth === 0) continue;
			for (let i = 1; i < row.length; i++) {
				const a = row[i - 1]!, b = row[i]!;
				const sameFamily = parentOf.get(ids[a]!) === parentOf.get(ids[b]!);
				add(a, b, pairArc(points[a]!, points[b]!) * (sameFamily ? 1 : 1.7));
			}
			if (row.length > 1) {
				const first = row[0]!, last = row[row.length - 1]!;
				add(last, first, -(TAU - Math.max(SEAM_GAP, pairArc(points[first]!, points[last]!))));
			}
		}
		const families = [...children].filter(([id]) => proposed.get(id)!.depth >= 2).map(([id, group]) => ({
			parent: indices.get(id)!, first: indices.get(group[0]!)!, last: indices.get(group[group.length - 1]!)!,
		})).sort((a, b) => points[b.parent]!.depth - points[a.parent]!.depth);
		// Each row keeps its seam gap, but its endpoints may shift slightly relative
		// to the neighboring rows while the parent/fan centers settle.
		const angularSpan = TAU - SEAM_GAP / 2;
		const angles = solveBandConstraints(ids.length, constraints, angularSpan, families);
		if (!angles) return false;
		const start = (rootSectorStart ?? -Math.PI / 2) + SEAM_GAP / 4;
		for (let i = 0; i < points.length; i++) {
			const point = points[i]!, angle = start + angles[i]!;
			point.angle = point.depth === 0 ? rootAngle : normalizeAngle(angle);
			point.x = Math.cos(point.angle) * point.radius;
			point.y = Math.sin(point.angle) * point.radius;
		}
		// Partition the actual bands, then record each parent's corridor on its
		// children's band. A corridor need not extend through all later bands.
		for (const [depth, row] of levels) {
			if (depth === 0) continue;
			for (let i = 0; i < row.length; i++) {
				const index = row[i]!;
				const low = i ? (angles[row[i - 1]!]! + angles[index]!) / 2 : 0;
				const high = i + 1 < row.length ? (angles[index]! + angles[row[i + 1]!]!) / 2 : angularSpan;
				setPointSector(points[index]!, start + low, start + high);
			}
		}
		for (const [id, group] of children) {
			const parent = proposed.get(id)!;
			parent.childSectorStart = proposed.get(group[0]!)!.sectorStart;
			parent.childSectorEnd = proposed.get(group[group.length - 1]!)!.sectorEnd;
		}
		if (!new HierarchyClearance(positions, graph).accept(proposed)) return false;
		// Separate depth bands reserve room for whole families to stagger radially.
		spreadBandSiblings(positions, graph, nodeGap, bands, { gap: nodeGap * NODE_GAP_CLEARANCE_FACTOR, radiusScale: NODE_BODY_CLEARANCE_FACTOR, radius: spacingRadius, distance, comfortableScale: 2.5, fanAspect: 0.5 });
		separateNearbyNodes(positions, graph, nodeGap);
		syncFamilySectors(positions, children);
		for (const [depth, band] of bands) ringTargets.set(depth, band.radius);
		return true;
	}
}

function compactBandTargets(levels: Map<number, number[]>, points: RadialPoint[], ringGap: number, nodeGap: number): Map<number, Band> {
	const bands = new Map<number, Band>([[0, { radius: 0, min: 0, max: 0 }]]);
	const demands = new Map([...levels].map(([depth, row]) => [depth, row.reduce((sum, index) =>
		sum + points[index]!.nodeRadius * 2 * NODE_BODY_CLEARANCE_FACTOR + nodeGap * NODE_CLEARANCE_FACTOR + 8, 0)]));
	const depths = [...levels.keys()].filter((d) => d > 0).sort((a, b) => a - b);
	// Share the capacity required by each depth across every preceding step.
	// All bands then advance evenly from the origin, without a jump before the
	// crowded middle levels. Each band has room for distinct family radii.
	const step = Math.max(ringGap * 5, ...depths.map((depth) => demands.get(depth)! * 4 / (TAU * 0.7 * depth)));
	for (const depth of depths) {
		const radius = depth * step;
		const half = step * 0.4;
		bands.set(depth, { radius, min: radius - half, max: radius + half });
	}

	return bands;
}

function nodePairArc(a: RadialPoint, b: RadialPoint, nodeGap: number): number {
	const distance = (a.nodeRadius + b.nodeRadius) * NODE_BODY_CLEARANCE_FACTOR + nodeGap * NODE_CLEARANCE_FACTOR + 8;
	return 2 * Math.asin(clamp(distance / (2 * a.radius), 0, 1));
}

function bandDepartureLimits(levels: Map<number, number[]>, points: RadialPoint[], nodeGap: number): Map<number, number> {
	const limits = new Map<number, number>();
	const minimumCosine = Math.cos(Math.PI * 87 / 180);
	for (const [depth, row] of levels) {
		if (depth === 0) continue;
		const largest = Math.max(...row.map((index) => points[index]!.nodeRadius));
		for (let i = 0; i < row.length; i++) {
			const point = points[row[i]!]!;
			let cosine = minimumCosine;
			// Only nearby bodies can limit this edge's departure. A large hub
			// elsewhere on the band must not flatten every other family's fork.
			for (const direction of [-1, 1]) {
				let angle = 0, previous = i;
				for (let offset = 1; offset < row.length; offset++) {
					const j = (i + direction * offset + row.length) % row.length;
					const neighbor = points[row[j]!]!;
					const gap = nodePairArc(points[row[previous]!]!, neighbor, nodeGap);
					const wraps = direction > 0 ? previous === row.length - 1 && j === 0 : previous === 0 && j === row.length - 1;
					angle += wraps ? Math.max(SEAM_GAP, gap) : gap;
					if (angle >= Math.PI) break;
					const distance = 2 * point.radius * Math.sin(angle / 2);
					cosine = Math.max(cosine, (neighbor.nodeRadius + 4) * 1.1 / distance);
					if (distance * minimumCosine >= (largest + 4) * 1.1) break;
					previous = j;
				}
			}
			limits.set(row[i]!, Math.acos(clamp(cosine, 0, 0.95)));
		}
	}
	return limits;
}
