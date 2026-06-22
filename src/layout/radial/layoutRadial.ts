import type { VisibleWorldGraph, WorldEdge, WorldNode } from '../../world/types';
import { ROOT_ID } from '../../world/types';

export const DEFAULT_RING_SPACING = 960;
export const MIN_RING_SPACING = 720;
export const MAX_RING_SPACING = 2800;
export const DEFAULT_NODE_SPACING = 126;
export const MIN_NODE_SPACING = 72;
export const MAX_NODE_SPACING = 360;

const RING_JAGGED_BAND_FACTOR = 0.26;
const RING_JAGGED_MAX_FACTOR = 0.22;

export interface RadialPoint {
	x: number;
	y: number;
	homeX: number;
	homeY: number;
	radius: number;
	homeRadius: number;
	angle: number;
	homeAngle: number;
	depth: number;
	nodeRadius: number;
	centerX: number;
	centerY: number;
	external: boolean;
	ringRadius?: number;
	ringBandMin?: number;
	ringBandMax?: number;
}

export interface RadialRing {
	depth: number;
	radius: number;
	count: number;
}

export interface RadialRoute {
	kind: 'line' | 'curve' | 'outer';
	centerX: number;
	centerY: number;
	radius: number;
	sourceAngle: number;
	targetAngle: number;
	endAngle?: number;
	curveStrength?: number;
}

export interface RadialLayout {
	positions: Map<string, RadialPoint>;
	rings: RadialRing[];
	routes: Map<string, RadialRoute>;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	width: number;
	height: number;
	centerX: number;
	centerY: number;
	ringSpacing: number;
	nodeSpacing: number;
}

export interface RadialLayoutOptions {
	ringSpacing: number;
	nodeSpacing: number;
	swirlStrength: number;
}

interface Metric {
	weight: number;
	count: number;
	maxDepth: number;
}

interface SpacingProfile {
	baseRingGap: number;
	baseNodeGap: number;
	ringGap: number;
	nodeGap: number;
	branchFanSpan: number;
	routeGapFactor: number;
	radiusExpansion: number;
	ringCountsByDepth: Map<number, number>;
	maxDensityDepth: number;
	incidentPressureByNode: Map<string, number>;
}

interface RingItem {
	id: string;
	node: WorldNode;
	point: RadialPoint;
	depth: number;
	parentId: string | null;
	parentAngle: number;
	visualRadius: number;
	arcDemand: number;
	preferred: number;
}

export function layoutRadialGraph(graph: VisibleWorldGraph, options: RadialLayoutOptions): RadialLayout {
	const baseRingGap = clamp(options.ringSpacing, MIN_RING_SPACING, MAX_RING_SPACING);
	const baseNodeGap = clamp(options.nodeSpacing, MIN_NODE_SPACING, MAX_NODE_SPACING);
	const padding = 340;
	const positions = new Map<string, RadialPoint>();
	const nodesById = graph.nodesById;
	const maxDegree = maxLinkDegree(graph.nodes);
	const normalNodes = graph.nodes.filter((node) => !node.externalProxy && node.type !== 'external');
	const normalIds = new Set(normalNodes.map((node) => node.id));
	const spacing = adaptiveLayoutSpacing(graph, normalIds, baseRingGap, baseNodeGap);
	const rootId = normalIds.has(graph.rootId) ? graph.rootId : normalIds.has(ROOT_ID) ? ROOT_ID : (normalNodes[0]?.id ?? null);
	const childrenByParent = childrenByParentMap(graph, normalIds, nodesById);
	const metrics = new Map<string, Metric>();
	const reachable = new Set<string>();

	if (rootId !== null) {
		measureSubtree(rootId, 0, childrenByParent, spacing, metrics);
		collectReachable(rootId, childrenByParent, reachable);
	}

	if (rootId !== null) {
		const rootPoint = makePoint(0, -Math.PI / 2, 0, nodeRadius(nodesById.get(rootId), maxDegree), false);
		positions.set(rootId, rootPoint);
		placeRadialChildren(
			rootId,
			0,
			-Math.PI / 2,
			-Math.PI / 2 + Math.PI * 2,
			-Math.PI / 2,
			childrenByParent,
			metrics,
			positions,
			nodesById,
			spacing,
			rootId,
			maxDegree,
		);
	}

	const orphanNodes = normalNodes.filter((node) => node.id !== rootId && !reachable.has(node.id)).sort(compareLayoutNode);
	const rootMetric = rootId !== null ? metrics.get(rootId) : null;
	const maxTreeDepth = Math.max(0, rootMetric?.maxDepth ?? 0);
	let outerRadius = Math.max(maxRadius(positions), spacing.ringGap);
	if (orphanNodes.length > 0) {
		outerRadius = Math.max(
			outerRadius,
			placeOuterCircleNodes(orphanNodes, positions, graph, nodesById, outerRadius + spacing.ringGap * 0.72, spacing.nodeGap, -Math.PI / 2, maxTreeDepth + 1, false, maxDegree),
		);
	}

	const externalGroups = graph.nodes.filter((node) => node.type === 'external' && !node.externalProxy).sort(compareLayoutNode);
	if (externalGroups.length > 0) {
		outerRadius = Math.max(
			outerRadius,
			placeOuterCircleNodes(externalGroups, positions, graph, nodesById, outerRadius + spacing.ringGap * 0.62, spacing.nodeGap * 1.15, -Math.PI / 3, maxTreeDepth + 1, true, maxDegree),
		);
	}

	const externalFiles = graph.nodes.filter((node) => node.externalProxy).sort(compareLayoutNode);
	if (externalFiles.length > 0) {
		outerRadius = Math.max(
			outerRadius,
			placeOuterCircleNodes(externalFiles, positions, graph, nodesById, outerRadius + Math.max(220, spacing.ringGap * 0.52), spacing.nodeGap, -Math.PI / 5, maxTreeDepth + 2, true, maxDegree),
		);
	}

	const ringTargets = assignDepthRingTargets(positions, graph, spacing, spacing.nodeGap, maxDegree);
	resolveRadialCollisions(positions, graph, spacing, spacing.nodeGap, ringTargets, maxDegree);
	enforceDepthRingBands(positions, graph, spacing, spacing.nodeGap, ringTargets, maxDegree);
	if (spacing.radiusExpansion > 1.001) applyAdaptiveRadiusExpansion(positions, ringTargets, spacing);
	const spinSpeed = clamp(options.swirlStrength, 0, 100) / 100;
	const swirlStrength = spinSpeed > 0.001 ? clamp(0.24 + spinSpeed * 0.34, 0.24, 0.58) : 0;
	if (swirlStrength > 0.001) applyRadialSwirl(positions, graph, spacing, swirlStrength);
	outerRadius = Math.max(outerRadius, maxRadius(positions));
	const routeMaxDepth = maxTreeDepth + (externalGroups.length || externalFiles.length ? 2 : orphanNodes.length ? 1 : 0);
	const routeBundle = computeLinkRoutes(
		graph.linkEdges,
		positions,
		routeMaxDepth,
		spacing.ringGap,
		outerRadius + Math.max(150, spacing.ringGap * 0.35),
	);
	const rawBounds = radialLayoutBounds(positions, Math.max(routeBundle.maxRadius, outerRadius + Math.max(160, spacing.ringGap * 0.34)));
	const offsetX = padding - rawBounds.minX;
	const offsetY = padding - rawBounds.minY;
	shiftRadialLayout(positions, routeBundle.routes, offsetX, offsetY);
	anchorHomePositions(positions);
	const rings = computeRings(positions, ringTargets);
	const width = Math.max(900, rawBounds.maxX - rawBounds.minX + padding * 2);
	const height = Math.max(520, rawBounds.maxY - rawBounds.minY + padding * 2);
	const bounds = { minX: 0, minY: 0, maxX: width, maxY: height };
	return {
		positions,
		rings,
		routes: routeBundle.routes,
		bounds,
		width,
		height,
		centerX: offsetX,
		centerY: offsetY,
		ringSpacing: spacing.ringGap,
		nodeSpacing: spacing.nodeGap,
	};
}

function childrenByParentMap(
	graph: VisibleWorldGraph,
	normalIds: Set<string>,
	nodesById: Map<string, WorldNode>,
): Map<string, string[]> {
	const childrenByParent = new Map<string, string[]>();
	for (const node of graph.nodes) {
		if (!normalIds.has(node.id) || node.parentId === null || node.parentId === undefined || !normalIds.has(node.parentId)) continue;
		const list = childrenByParent.get(node.parentId);
		if (list) list.push(node.id);
		else childrenByParent.set(node.parentId, [node.id]);
	}
	for (const children of childrenByParent.values()) children.sort((a, b) => compareLayoutNode(nodesById.get(a), nodesById.get(b)));
	return childrenByParent;
}

function measureSubtree(
	id: string,
	depth: number,
	childrenByParent: Map<string, string[]>,
	spacing: SpacingProfile,
	metrics: Map<string, Metric>,
	visiting = new Set<string>(),
): Metric {
	const cached = metrics.get(id);
	if (cached) return cached;
	if (visiting.has(id)) {
		const fallback = { weight: 1, count: 1, maxDepth: depth };
		metrics.set(id, fallback);
		return fallback;
	}
	visiting.add(id);
	const incidentPressure = spacing.incidentPressureByNode.get(id) ?? 0;
	let weight = Math.min(9, incidentPressure * 0.24);
	let count = 1;
	let maxDepth = depth;
	for (const childId of childrenByParent.get(id) ?? []) {
		const child = measureSubtree(childId, depth + 1, childrenByParent, spacing, metrics, visiting);
		weight += child.weight;
		count += child.count;
		maxDepth = Math.max(maxDepth, child.maxDepth);
	}
	visiting.delete(id);
	const metric = { weight: Math.max(1, weight || 1), count, maxDepth };
	metrics.set(id, metric);
	return metric;
}

function collectReachable(id: string | null | undefined, childrenByParent: Map<string, string[]>, reachable: Set<string>): void {
	if (id === null || id === undefined || reachable.has(id)) return;
	reachable.add(id);
	for (const childId of childrenByParent.get(id) ?? []) collectReachable(childId, childrenByParent, reachable);
}

function placeRadialChildren(
	parentId: string,
	depth: number,
	sectorStart: number,
	sectorEnd: number,
	parentAngle: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
	positions: Map<string, RadialPoint>,
	nodesById: Map<string, WorldNode>,
	spacing: SpacingProfile,
	rootId: string,
	maxDegree: number,
): void {
	const children = childrenByParent.get(parentId) ?? [];
	if (children.length === 0) return;

	let start = sectorStart;
	let end = sectorEnd;
	let span = Math.max(0.001, end - start);
	const parentPoint = positions.get(parentId) ?? makePoint(0, parentAngle, depth, 5, false);
	let childRadius = parentPoint.radius + localRadialGap(parentId, depth, children, metrics, spacing, rootId);
	const nodeGap = localArcGap(parentId, children, metrics, spacing, rootId);

	if (children.length === 1 && parentId === rootId) {
		const localSpan = Math.max(Math.PI * 0.36, spacing.branchFanSpan * 0.82);
		start = parentAngle - localSpan / 2;
		end = parentAngle + localSpan / 2;
		span = localSpan;
	} else if (parentId !== rootId) {
		const demandSpan = children.length > 1 ? ((children.length - 1) * nodeGap) / childRadius + 0.08 : Math.max(Math.PI * 0.24, spacing.branchFanSpan * 0.62);
		const cappedFan = Math.min(span, spacing.branchFanSpan);
		const localSpan = Math.min(span, Math.max(cappedFan, demandSpan));
		start = parentAngle - localSpan / 2;
		end = parentAngle + localSpan / 2;
		span = localSpan;
	}

	if (children.length > 1) {
		const requiredRadius = ((children.length - 1) * nodeGap) / Math.max(0.16, span * 0.64);
		const maxExtra = spacing.ringGap * (parentId === rootId ? 1.8 : 2.8);
		childRadius = Math.max(childRadius, Math.min(parentPoint.radius + maxExtra, requiredRadius));
	}

	const totalWeight = Math.max(1, children.reduce((sum, childId) => sum + (metrics.get(childId)?.weight ?? 1), 0));
	const localGap = children.length > 1 ? Math.min(nodeGap / childRadius, (span * 0.38) / (children.length - 1)) : 0;
	const usableSpan = Math.max(0.001, span - localGap * Math.max(0, children.length - 1));
	let cursor = start;

	for (const childId of children) {
		const childSpan = children.length === 1 ? usableSpan : usableSpan * ((metrics.get(childId)?.weight ?? 1) / totalWeight);
		const childStart = cursor;
		const childEnd = cursor + childSpan;
		const angle = childStart + childSpan / 2;
		const node = nodesById.get(childId);
		positions.set(childId, makePoint(childRadius, angle, depth + 1, nodeRadius(node, maxDegree), false));
		placeRadialChildren(childId, depth + 1, childStart, childEnd, angle, childrenByParent, metrics, positions, nodesById, spacing, rootId, maxDegree);
		cursor = childEnd + localGap;
	}
}

function localRadialGap(
	parentId: string,
	depth: number,
	children: string[],
	metrics: Map<string, Metric>,
	spacing: SpacingProfile,
	rootId: string,
): number {
	const childCount = children.length;
	const parentMetric = metrics.get(parentId) ?? { count: 1, weight: 1, maxDepth: depth };
	const incidentPressure = spacing.incidentPressureByNode.get(parentId) ?? 0;
	const childRoot = Math.sqrt(Math.max(1, childCount));
	const subtreeSignal = Math.log2(Math.max(1, parentMetric.count || parentMetric.weight || 1));
	const pressureSignal = Math.sqrt(Math.max(0, incidentPressure));
	let factor = 0.62 + depth * 0.105 + childRoot * 0.135 + subtreeSignal * 0.094 + pressureSignal * 0.086;
	if (parentId === rootId) factor *= 0.96;
	if (childCount <= 4) factor = Math.min(factor, parentId === rootId ? 0.94 : 1.12);
	if (childCount >= 14) factor = Math.max(factor, 1.24 + Math.min(1.1, childRoot * 0.09));
	if (childCount >= 40) factor = Math.max(factor, 1.56 + Math.min(1.34, childRoot * 0.084));
	return clamp(spacing.baseRingGap * factor, parentId === rootId ? 260 : 300, 4400);
}

function localArcGap(
	parentId: string,
	children: string[],
	metrics: Map<string, Metric>,
	spacing: SpacingProfile,
	rootId: string,
): number {
	const childCount = children.length;
	const parentMetric = metrics.get(parentId) ?? { count: 1, weight: 1, maxDepth: 1 };
	const incidentPressure = spacing.incidentPressureByNode.get(parentId) ?? 0;
	const densitySignal =
		Math.sqrt(Math.max(1, childCount)) * 0.07 +
		Math.log2(Math.max(1, parentMetric.count || 1)) * 0.052 +
		Math.sqrt(Math.max(0, incidentPressure)) * 0.05;
	let factor = 1.58 + densitySignal * 1.95;
	if (parentId === rootId && childCount <= 6) factor *= 1.08;
	if (childCount <= 4) factor = clamp(factor, 1.62, 2.08);
	else if (childCount <= 10) factor = Math.max(factor, 1.86);
	if (childCount >= 24) factor = Math.max(factor, 2.12);
	if (childCount >= 64) factor = Math.max(factor, 2.58);
	return clamp(spacing.baseNodeGap * factor, 132, 920);
}

function placeOuterCircleNodes(
	nodes: WorldNode[],
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	nodesById: Map<string, WorldNode>,
	radius: number,
	nodeGap: number,
	fallbackStart: number,
	depth: number,
	external: boolean,
	maxDegree: number,
): number {
	if (nodes.length === 0) return radius;
	const slot = (Math.PI * 2) / nodes.length;
	const crowding = nodes.length * (nodeGap / Math.max(1, radius));
	const items = nodes
		.map((node, index) => ({
			node,
			preferred: preferredAngleForNode(node, graph, positions, fallbackStart + index * slot),
		}))
		.sort((a, b) => normalizeAngle(a.preferred) - normalizeAngle(b.preferred));
	const offset = items[0] ? items[0].preferred - slot * 0.5 : fallbackStart;
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		if (!item) continue;
		const evenAngle = offset + index * slot;
		const preferredDelta = shortestAngleDelta(evenAngle, item.preferred);
		const angle = crowding < Math.PI * 1.35 ? evenAngle + preferredDelta * 0.55 : evenAngle;
		positions.set(item.node.id, makePoint(radius, angle, depth || item.node.depth || 1, nodeRadius(nodesById.get(item.node.id), maxDegree), external));
	}
	return radius;
}

function assignDepthRingTargets(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	nodeGap: number,
	maxDegree: number,
): Map<number, number> {
	const ringTargets = new Map<number, number>([[0, 0]]);
	const byDepth = new Map<number, { count: number; diameterTotal: number; maxDiameter: number; external: number; linkPressure: number }>();
	for (const [id, point] of positions.entries()) {
		const depth = Math.max(0, Math.round(point.depth || 0));
		const node = graph.nodesById.get(id);
		const visualRadius = nodeRadius(node, maxDegree);
		const diameter = visualRadius * 2 + Math.max(18, nodeGap * 0.36);
		const entry = byDepth.get(depth) ?? { count: 0, diameterTotal: 0, maxDiameter: 0, external: 0, linkPressure: 0 };
		entry.count++;
		entry.diameterTotal += diameter;
		entry.maxDiameter = Math.max(entry.maxDiameter, diameter);
		entry.linkPressure += spacing.incidentPressureByNode.get(id) ?? 0;
		if (point.external || node?.externalProxy || node?.type === 'external') entry.external++;
		byDepth.set(depth, entry);
	}

	let previousRadius = 0;
	const depths = [...byDepth.keys()].filter((depth) => depth > 0).sort((a, b) => a - b);
	const maxDepth = Math.max(...depths, 1);
	const totalNodes = [...byDepth.values()].reduce((sum, entry) => sum + entry.count, 0);
	const globalCompression = clamp(1 - Math.log10(Math.max(1, totalNodes)) * 0.085, 0.58, 0.9);
	for (const depth of depths) {
		const entry = byDepth.get(depth);
		if (!entry) continue;
		const avgDiameter = entry.diameterTotal / Math.max(1, entry.count);
		const rawDemand = entry.count > 1 ? (entry.count * avgDiameter) / (Math.PI * 2) : 0;
		const compressedDemand = rawDemand > 0 ? Math.pow(rawDemand, 0.64) * Math.pow(spacing.ringGap, 0.36) : 0;
		const depthRatio = depth / Math.max(1, maxDepth);
		const outerExpansion = 1 + Math.pow(depthRatio, 1.35) * 0.34;
		const pressureExpansion = 1 + Math.min(0.28, Math.sqrt(entry.linkPressure / Math.max(1, entry.count)) * 0.036);
		const depthCompression = clamp(1 - depthRatio * 0.1, 0.84, 0.98);
		const baseRadius = depth * spacing.ringGap * globalCompression * depthCompression * outerExpansion * pressureExpansion;
		const minSeparatedRadius = previousRadius + spacing.ringGap * (entry.external ? 0.54 : 0.62);
		const crowdingRadius = compressedDemand * globalCompression * outerExpansion * pressureExpansion + entry.maxDiameter * 1.45;
		const maxStepRadius = previousRadius + spacing.ringGap * (entry.external ? 1.45 : 1.72) * outerExpansion;
		const radius = Math.min(maxStepRadius, Math.max(baseRadius, minSeparatedRadius, crowdingRadius));
		ringTargets.set(depth, radius);
		previousRadius = radius;
	}
	for (const point of positions.values()) {
		const depth = Math.max(0, Math.round(point.depth || 0));
		const targetRadius = ringTargets.get(depth);
		if (!Number.isFinite(targetRadius)) continue;
		const radius = targetRadius as number;
		const angle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
		point.ringRadius = radius;
		if (depth === 0) {
			point.x = 0;
			point.y = 0;
			point.radius = 0;
			point.angle = -Math.PI / 2;
			continue;
		}
		point.x = Math.cos(angle) * radius;
		point.y = Math.sin(angle) * radius;
		point.radius = radius;
		point.angle = normalizeAngle(angle);
	}
	return ringTargets;
}

function resolveRadialCollisions(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	nodeGap: number,
	ringTargets: Map<number, number>,
	maxDegree: number,
): void {
	if (positions.size < 2) return;
	const basePad = clamp(nodeGap * 1.12, 54, 280);
	const items: {
		id: string;
		node: WorldNode;
		point: RadialPoint;
		visualRadius: number;
		collisionRadius: number;
		gravity: number;
		fixed: boolean;
		anchorAngle: number;
		ringRadius: number | null;
	}[] = [];
	let maxCollisionRadius = 1;

	for (const [id, point] of positions.entries()) {
		const node = graph.nodesById.get(id);
		if (!node) continue;
		const visualRadius = nodeRadius(node, maxDegree) * 1.72;
		const spacingPad = Math.min(320, basePad + labelCollisionPadding(node));
		const collisionRadius = visualRadius + spacingPad;
		const depth = Math.max(0, Math.round(point.depth || 0));
		const ringRadius = Number.isFinite(point.ringRadius) ? point.ringRadius! : ringTargets.get(depth);
		maxCollisionRadius = Math.max(maxCollisionRadius, collisionRadius);
		items.push({
			id,
			node,
			point,
			visualRadius,
			collisionRadius,
			gravity: clamp(Math.sqrt(Math.max(1, visualRadius)) / 3.1, 0.85, 2.55),
			fixed: id === graph.rootId,
			anchorAngle: Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x),
			ringRadius: Number.isFinite(ringRadius) ? ringRadius! : null,
		});
	}
	if (items.length < 2) return;

	const iterations = items.length > 3500 ? 9 : items.length > 1200 ? 11 : 16;
	const cellSize = Math.max(112, maxCollisionRadius * 2.48);
	const separateItems = (strength: number, softRepel: number) => {
		let moved = false;
		const grid = new Map<string, number[]>();
		for (let index = 0; index < items.length; index++) {
			const item = items[index]!;
			const gx = Math.floor(item.point.x / cellSize);
			const gy = Math.floor(item.point.y / cellSize);
			const key = `${gx},${gy}`;
			const bucket = grid.get(key);
			if (bucket) bucket.push(index);
			else grid.set(key, [index]);
		}
		for (let index = 0; index < items.length; index++) {
			const item = items[index]!;
			const gx = Math.floor(item.point.x / cellSize);
			const gy = Math.floor(item.point.y / cellSize);
			for (let x = gx - 1; x <= gx + 1; x++) {
				for (let y = gy - 1; y <= gy + 1; y++) {
					const bucket = grid.get(`${x},${y}`);
					if (!bucket) continue;
					for (const otherIndex of bucket) {
						if (otherIndex <= index) continue;
						const other = items[otherIndex]!;
						if (item.fixed && other.fixed) continue;
						let dx = item.point.x - other.point.x;
						let dy = item.point.y - other.point.y;
						let distance = Math.hypot(dx, dy);
						if (distance < 0.001) {
							const angle = deterministicPairAngle(item.id, other.id);
							dx = Math.cos(angle);
							dy = Math.sin(angle);
							distance = 1;
						}
						const minDistance = item.collisionRadius + other.collisionRadius;
						const gravity = Math.sqrt(item.gravity * other.gravity);
						const softDistance = minDistance + (item.visualRadius + other.visualRadius) * 1.75 * gravity;
						if (distance >= softDistance) continue;
						const overlapPush = distance < minDistance ? (minDistance - distance) * strength : 0;
						const softPush =
							distance >= minDistance
								? (softDistance - distance) * softRepel
								: (softDistance - minDistance) * softRepel * 0.35;
						const push = (overlapPush + softPush) * gravity + 0.01;
						const nx = dx / distance;
						const ny = dy / distance;
						const itemShare = item.fixed ? 0 : other.fixed ? 1 : 0.5;
						const otherShare = other.fixed ? 0 : item.fixed ? 1 : 0.5;
						item.point.x += nx * push * itemShare;
						item.point.y += ny * push * itemShare;
						other.point.x -= nx * push * otherShare;
						other.point.y -= ny * push * otherShare;
						moved = true;
					}
				}
			}
		}
		return moved;
	};
	const pullItemsToRings = (strength: number) => {
		for (const item of items) {
			if (item.fixed || !Number.isFinite(item.ringRadius)) continue;
			const currentRadius = Math.max(0.001, Math.hypot(item.point.x, item.point.y));
			const currentAngle = Math.atan2(item.point.y, item.point.x);
			const external = item.node.externalProxy || item.node.type === 'external';
			const anglePull = external ? 0.016 : 0.024;
			const ringTolerance = Math.max(item.visualRadius * (external ? 1.9 : 1.45), spacing.ringGap * (external ? 0.15 : 0.105));
			const nextAngle = currentAngle + shortestAngleDelta(currentAngle, item.anchorAngle) * anglePull;
			const pulledRadius = currentRadius + (item.ringRadius! - currentRadius) * strength;
			const nextRadius = clamp(pulledRadius, Math.max(0, item.ringRadius! - ringTolerance), item.ringRadius! + ringTolerance);
			item.point.x = Math.cos(nextAngle) * nextRadius;
			item.point.y = Math.sin(nextAngle) * nextRadius;
		}
	};

	for (let pass = 0; pass < iterations; pass++) {
		separateItems(pass === 0 ? 0.9 : 0.72, pass < 3 ? 0.22 : 0.13);
		pullItemsToRings(pass < 3 ? 0.42 : 0.28);
	}
	for (let pass = 0; pass < 5; pass++) {
		pullItemsToRings(pass === 0 ? 0.18 : 0.1);
		if (!separateItems(pass === 0 ? 1 : 0.82, 0.05)) break;
	}
	for (const item of items) {
		const radius = Math.hypot(item.point.x, item.point.y);
		if (radius < 0.001) continue;
		item.point.radius = radius;
		item.point.angle = Math.atan2(item.point.y, item.point.x);
	}
}

function enforceDepthRingBands(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	nodeGap: number,
	ringTargets: Map<number, number>,
	maxDegree: number,
): void {
	const byDepth = new Map<number, RingItem[]>();
	for (const [id, point] of positions.entries()) {
		const node = graph.nodesById.get(id);
		if (!node) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		if (depth === 0) {
			point.x = 0;
			point.y = 0;
			point.radius = 0;
			point.angle = -Math.PI / 2;
			continue;
		}
		const visualRadius = nodeRadius(node, maxDegree);
		const labelDemand = labelCollisionPadding(node) + labelArcPadding(node) * clamp(0.58 + Math.min(1, depth / 4) * 0.42, 0.58, 1);
		const arcDemand = visualRadius * 2.75 + labelDemand * 2.7 + Math.max(22, nodeGap * 0.22);
		const currentAngle = normalizeAngle(Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x));
		const parentPoint = node.parentId ? positions.get(node.parentId) : null;
		const parentAngle = parentPoint && Number.isFinite(parentPoint.angle) ? normalizeAngle(parentPoint.angle) : currentAngle;
		const preferred = parentPoint ? blendAngles(currentAngle, parentAngle, 0.68) : currentAngle;
		const list = byDepth.get(depth) ?? [];
		list.push({ id, node, point, depth, parentId: node.parentId ?? null, parentAngle, visualRadius, arcDemand, preferred });
		byDepth.set(depth, list);
	}

	let previousOuterRadius = 0;
	const depths = [...byDepth.keys()].sort((a, b) => a - b);
	const maxDepth = Math.max(...depths, 1);
	for (const depth of depths) {
		const items = byDepth.get(depth);
		if (!items?.length) continue;
		const totalArcDemand = items.reduce((sum, item) => sum + item.arcDemand, 0);
		const maxVisualRadius = Math.max(...items.map((item) => item.visualRadius), 4);
		const baseTarget = ringTargets.get(depth) ?? Math.max(spacing.ringGap * depth, previousOuterRadius + spacing.ringGap * 0.62);
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const outerDensity = Math.pow(depthRatio, 1.35);
		const laneUtilization = clamp(0.72 - outerDensity * 0.16 - Math.min(0.1, items.length / 4200), 0.5, 0.72);
		const baseCapacity = Math.max(1, Math.PI * 2 * baseTarget * laneUtilization);
		const laneCount = clamp(Math.ceil(totalArcDemand / baseCapacity), 1, outerRingLaneLimit(items.length, depthRatio));
		const laneGap = Math.max(
			maxVisualRadius * (2.45 + outerDensity * 0.7) + Math.max(12, nodeGap * (0.13 + outerDensity * 0.04)),
			spacing.ringGap * (0.11 + outerDensity * 0.045),
		);
		const depthJaggedFactor = ringJaggedDepthFactor(depth, baseTarget, spacing.ringGap, items.length, totalArcDemand);
		const firstLaneRadius = Math.max(baseTarget - laneGap * (laneCount - 1) * 0.5, previousOuterRadius + laneGap * 0.86);
		const lanes = Array.from({ length: laneCount }, () => [] as RingItem[]);
		for (const group of orderRingGroupsByParent(items)) {
			const groupItems = orderRingItemsByPreferredGap(group.items);
			if (laneCount === 1) lanes[0]?.push(...groupItems);
			else lanes[chooseRingLaneForGroup(lanes, groupItems, group.parentAngle)]?.push(...groupItems);
		}

		const laneRadii: number[] = [];
		const laneOuterRadii: number[] = [];
		for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
			const laneItems = orderRingItemsByParentThenPreferred(lanes[laneIndex] ?? []);
			if (!laneItems.length) continue;
			let laneRadius = firstLaneRadius + laneIndex * laneGap;
			const laneArcDemand = laneItems.reduce((sum, item) => sum + item.arcDemand, 0);
			const requiredRadius = laneArcDemand / (Math.PI * 2 * laneUtilization);
			laneRadius = Math.max(laneRadius, requiredRadius, previousOuterRadius + laneGap * 0.72);
			const laneJaggedFactor = depthJaggedFactor * ringJaggedDensityFactor(laneItems.length, countRingParents(laneItems), laneArcDemand, laneRadius);
			const candidateJitter = Math.min(
				spacing.ringGap * RING_JAGGED_BAND_FACTOR * laneJaggedFactor,
				laneRadius * RING_JAGGED_MAX_FACTOR * Math.min(1.35, laneJaggedFactor),
			);
			laneRadius = Math.max(laneRadius, previousOuterRadius + candidateJitter * 0.56 + laneGap * 0.68);
			const jitterBand = Math.min(
				candidateJitter,
				Math.max(0, laneRadius - previousOuterRadius - maxVisualRadius * 2.2 - Math.max(12, nodeGap * 0.08)),
			);
			const laneOccupancy = laneArcDemand / Math.max(1, Math.PI * 2 * laneRadius);
			placeItemsOnRingLane(laneItems, laneRadius, {
				jitterBand,
				preservePreferred: laneItems.length < 90 || laneOccupancy < 0.38 || outerDensity < 0.28,
			});
			laneRadii.push(laneRadius);
			laneOuterRadii.push(laneRadius + jitterBand);
		}
		if (laneRadii.length) {
			ringTargets.set(depth, medianNumber(laneRadii, baseTarget));
			previousOuterRadius = Math.max(...laneOuterRadii) + maxVisualRadius * 1.55 + Math.max(12, nodeGap * 0.08);
		}
	}
}

function adaptiveLayoutSpacing(
	graph: VisibleWorldGraph,
	normalIds: Set<string>,
	baseRingGap: number,
	baseNodeGap: number,
): SpacingProfile {
	const incidentPressureByNode = new Map<string, number>();
	let totalPressure = 0;
	let externalPressure = 0;
	for (const edge of graph.linkEdges) {
		const weightScore = Math.min(7, Math.log2((edge.weight || 1) + 1));
		const rawScore = Math.min(6, Math.log2((edge.rawCount || edge.weight || 1) + 1));
		const edgePressure = 0.75 + weightScore * 0.62 + rawScore * 0.28 + (edge.unresolvedCount ? 0.35 : 0) + (edge.externalCount ? 0.85 : 0);
		totalPressure += edgePressure;
		if (edge.externalCount) externalPressure += edgePressure;
		for (const id of [edge.source, edge.target]) incidentPressureByNode.set(id, (incidentPressureByNode.get(id) ?? 0) + edgePressure);
	}
	let maxIncident = 0;
	for (const pressure of incidentPressureByNode.values()) maxIncident = Math.max(maxIncident, pressure);
	const visibleNodeCount = Math.max(1, graph.nodes.length || normalIds.size || 1);
	const density = graphNodeDensityProfile(graph, normalIds);
	const averagePressure = totalPressure / visibleNodeCount;
	const overlayDensity = graph.linkEdges.length / visibleNodeCount;
	const hubPressure = maxIncident / Math.max(1, Math.sqrt(visibleNodeCount) * 1.65);
	const combinedPressure = averagePressure + Math.sqrt(Math.max(0, hubPressure)) * 0.58 + Math.min(1.6, overlayDensity) * 0.3 + (externalPressure / visibleNodeCount) * 0.32;
	const pressureRoot = Math.sqrt(Math.max(0, combinedPressure));
	const nodeFactor = clamp(1.2 + pressureRoot * 0.92 + Math.min(0.86, averagePressure * 0.105), 1.2, 5.8);
	const ringFactor = clamp(1.08 + pressureRoot * 0.34 + Math.min(0.34, averagePressure * 0.044), 1.08, 2.15);
	const fanFactor = clamp(0.62 + pressureRoot * 0.24 + Math.min(0.3, overlayDensity * 0.17), 0.62, 1.35);
	const routeGapFactor = clamp(0.9 + pressureRoot * 0.38 + Math.min(0.42, overlayDensity * 0.2), 0.9, 2.55);
	const countExpansion = Math.max(0, Math.log2(density.normalCount / 520)) * 0.035;
	const ringExpansion = Math.max(0, Math.sqrt(density.maxRingCount / 96) - 1) * 0.16;
	const averageRingExpansion = Math.max(0, Math.sqrt(density.averageRingCount / 64) - 1) * 0.1;
	const pressureExpansion = Math.max(0, pressureRoot - 0.75) * 0.028;
	return {
		baseRingGap,
		baseNodeGap,
		ringGap: clamp(baseRingGap * ringFactor, MIN_RING_SPACING, 4200),
		nodeGap: clamp(baseNodeGap * nodeFactor, 86, 860),
		branchFanSpan: Math.PI * fanFactor,
		routeGapFactor,
		radiusExpansion: clamp(1 + countExpansion + ringExpansion + averageRingExpansion + pressureExpansion, 1, 1.56),
		ringCountsByDepth: density.countsByDepth,
		maxDensityDepth: density.maxDepth,
		incidentPressureByNode,
	};
}

function graphNodeDensityProfile(graph: VisibleWorldGraph, normalIds: Set<string>): {
	normalCount: number;
	maxRingCount: number;
	averageRingCount: number;
	maxDepth: number;
	countsByDepth: Map<number, number>;
} {
	const byDepth = new Map<number, number>();
	for (const node of graph.nodes) {
		if (!normalIds.has(node.id)) continue;
		const depth = Math.max(0, Math.round(node.depth || 0));
		if (depth <= 0) continue;
		byDepth.set(depth, (byDepth.get(depth) ?? 0) + 1);
	}
	let maxRingCount = 0;
	let totalRingCount = 0;
	for (const count of byDepth.values()) {
		maxRingCount = Math.max(maxRingCount, count);
		totalRingCount += count;
	}
	return {
		normalCount: Math.max(1, normalIds.size || 0),
		maxRingCount,
		averageRingCount: byDepth.size ? totalRingCount / byDepth.size : Math.max(1, normalIds.size || 0),
		maxDepth: Math.max(...byDepth.keys(), 1),
		countsByDepth: byDepth,
	};
}

function applyAdaptiveRadiusExpansion(
	positions: Map<string, RadialPoint>,
	ringTargets: Map<number, number>,
	spacing: SpacingProfile,
): void {
	const expansion = clamp(spacing.radiusExpansion, 1, 1.65);
	if (expansion <= 1.001) return;
	const maxDepth = Math.max(1, spacing.maxDensityDepth, ...ringTargets.keys());
	const scaleForDepth = (depth: number) => {
		if (depth <= 0) return 1;
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const outerWeight = Math.pow(depthRatio, 1.42);
		const ringCount = spacing.ringCountsByDepth.get(Math.round(depth)) ?? 0;
		const crowdedBoost = Math.max(0, Math.sqrt(ringCount / 72) - 1) * 0.13 * outerWeight;
		const innerCompression = (1 - outerWeight) * Math.min(0.08, (expansion - 1) * 0.42);
		const adaptiveGrowth = (expansion - 1) * (0.04 + outerWeight * 1.06);
		return clamp(1 - innerCompression + adaptiveGrowth + crowdedBoost, 0.93, 1.68);
	};
	for (const [depth, radius] of [...ringTargets.entries()]) if (depth > 0) ringTargets.set(depth, radius * scaleForDepth(depth));
	for (const point of positions.values()) {
		if (point.radius <= 0.001) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		const depthScale = scaleForDepth(depth);
		const angle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
		const radius = point.radius * depthScale;
		point.radius = radius;
		point.x = Math.cos(angle) * radius;
		point.y = Math.sin(angle) * radius;
		point.angle = angle;
		if (Number.isFinite(point.ringRadius)) point.ringRadius = point.ringRadius! * depthScale;
		if (Number.isFinite(point.ringBandMin)) point.ringBandMin = point.ringBandMin! * depthScale;
		if (Number.isFinite(point.ringBandMax)) point.ringBandMax = point.ringBandMax! * depthScale;
	}
}

function computeLinkRoutes(
	edges: WorldEdge[],
	positions: Map<string, RadialPoint>,
	maxDepth: number,
	ringSpacing: number,
	outerRadius: number,
): { routes: Map<string, RadialRoute>; maxRadius: number } {
	const routes = new Map<string, RadialRoute>();
	const maxRadiusValue = Math.max(outerRadius || 0, 1);
	for (const edge of edges) {
		const source = positions.get(edge.source);
		const target = positions.get(edge.target);
		if (!source || !target) continue;
		const sourceRadius = Number.isFinite(source.radius) ? source.radius : 0;
		const targetRadius = Number.isFinite(target.radius) ? target.radius : 0;
		const sourceAngle = Number.isFinite(source.angle) ? source.angle : Math.atan2(target.y - source.y, target.x - source.x);
		const targetAngle = Number.isFinite(target.angle) ? target.angle : sourceAngle;
		const angleDistance = Math.abs(shortestAngleDelta(sourceAngle, targetAngle));
		const sameOrNearRing = Math.abs(sourceRadius - targetRadius) < ringSpacing * 0.44;
		const touchesOuterRing = Math.max(source.depth || 0, target.depth || 0) >= Math.max(1, maxDepth - 1);
		const isExternal = Boolean(source.external || target.external || edge.externalCount);
		const shouldCurve =
			isExternal ||
			sameOrNearRing ||
			(touchesOuterRing && angleDistance > 0.34) ||
			angleDistance > Math.PI * 0.42;
		if (shouldCurve) {
			routes.set(edge.id, {
				kind: 'curve',
				centerX: 0,
				centerY: 0,
				radius: Math.max(sourceRadius, targetRadius),
				sourceAngle,
				targetAngle,
				curveStrength: isExternal ? 0.3 : sameOrNearRing ? 0.22 : angleDistance > Math.PI * 0.72 ? 0.2 : 0.15,
			});
		}
	}
	return { routes, maxRadius: maxRadiusValue };
}

function computeRings(positions: Map<string, RadialPoint>, ringTargets: Map<number, number>): RadialRing[] {
	if (ringTargets.size > 1) {
		const ringsByKey = new Map<string, { depth: number; radiusTotal: number; count: number }>();
		for (const point of positions.values()) {
			const depth = Math.max(0, Math.round(point.depth || 0));
			if (depth <= 0) continue;
			const radius = Number.isFinite(point.ringRadius) ? point.ringRadius! : ringTargets.get(depth);
			if (!Number.isFinite(radius) || radius! <= 0) continue;
			const key = `${depth}:${Math.round(radius!)}`;
			const existing = ringsByKey.get(key);
			if (existing) {
				existing.count++;
				existing.radiusTotal += radius!;
			} else {
				ringsByKey.set(key, { depth, radiusTotal: radius!, count: 1 });
			}
		}
		return [...ringsByKey.values()]
			.map((ring) => ({ depth: ring.depth, radius: ring.radiusTotal / Math.max(1, ring.count), count: ring.count }))
			.sort((a, b) => a.radius - b.radius);
	}
	const byDepth = new Map<number, { radius: number; count: number }>();
	for (const point of positions.values()) {
		if (point.depth <= 0) continue;
		const radius = point.ringRadius ?? point.radius;
		const entry = byDepth.get(point.depth) ?? { radius: 0, count: 0 };
		entry.radius += radius;
		entry.count++;
		byDepth.set(point.depth, entry);
	}
	return [...byDepth.entries()]
		.map(([depth, entry]) => ({ depth, radius: entry.radius / Math.max(1, entry.count), count: entry.count }))
		.sort((a, b) => a.radius - b.radius);
}

function radialLayoutBounds(positions: Map<string, RadialPoint>, routeMaxRadius: number): RadialLayout['bounds'] {
	let minX = -Math.max(1, routeMaxRadius || 1);
	let minY = -Math.max(1, routeMaxRadius || 1);
	let maxX = Math.max(1, routeMaxRadius || 1);
	let maxY = Math.max(1, routeMaxRadius || 1);
	for (const point of positions.values()) {
		const labelPadX = 170;
		const labelPadTop = 46;
		const labelPadBottom = 126;
		minX = Math.min(minX, point.x - labelPadX);
		minY = Math.min(minY, point.y - labelPadTop);
		maxX = Math.max(maxX, point.x + labelPadX);
		maxY = Math.max(maxY, point.y + labelPadBottom);
	}
	return { minX, minY, maxX, maxY };
}

function shiftRadialLayout(positions: Map<string, RadialPoint>, routes: Map<string, RadialRoute>, offsetX: number, offsetY: number): void {
	for (const point of positions.values()) {
		point.x += offsetX;
		point.y += offsetY;
		point.centerX = offsetX;
		point.centerY = offsetY;
	}
	for (const route of routes.values()) {
		if (!Number.isFinite(route.centerX) || !Number.isFinite(route.centerY)) continue;
		route.centerX += offsetX;
		route.centerY += offsetY;
	}
}

function makePoint(radius: number, angle: number, depth: number, nodeRadiusValue: number, external: boolean): RadialPoint {
	const x = Math.cos(angle) * radius;
	const y = Math.sin(angle) * radius;
	return {
		x,
		y,
		homeX: x,
		homeY: y,
		radius,
		homeRadius: radius,
		angle,
		homeAngle: angle,
		depth,
		nodeRadius: nodeRadiusValue,
		centerX: 0,
		centerY: 0,
		external,
	};
}

function nodeRadius(node: WorldNode | undefined, maxDegree: number): number {
	if (!node) return 3.6;
	const degree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
	const degreeRatio = Math.log1p(degree) / Math.max(1, Math.log1p(maxDegree || 1));
	const clampedRatio = clamp(degreeRatio, 0, 1);
	const degreeCurve = Math.pow(clampedRatio, 0.48);
	const hubCurve = Math.pow(clampedRatio, 1.32);
	const degreeBoost = degreeCurve * 19 + hubCurve * 20 + Math.log2(degree + 1) * 1.35 + Math.sqrt(degree) * 0.32;
	if (node.externalProxy) return node.type === 'unresolved' ? 5.4 : Math.min(27, 5.8 + degreeBoost * 0.62);
	if (node.type === 'folder') {
		const noteSignal = Math.log2((node.noteCount || node.descendantCount || 1) + 1);
		return Math.min(66, 7 + noteSignal * 1.05 + degreeBoost * 1.18);
	}
	if (node.type === 'external') {
		const noteSignal = Math.log2((node.noteCount || 1) + 1);
		return Math.min(38, 5.8 + noteSignal * 0.72 + degreeBoost * 0.9);
	}
	if (node.type === 'unresolved') return Math.min(16, 4.2 + degreeBoost * 0.5);
	return Math.min(58, 3.6 + degreeBoost * 1.05);
}

function maxLinkDegree(nodes: WorldNode[]): number {
	let max = 1;
	for (const node of nodes) max = Math.max(max, (node.linkCount || 0) + (node.backlinkCount || 0));
	return max;
}

function compareLayoutNode(a: WorldNode | undefined, b: WorldNode | undefined): number {
	if (!a || !b) return a ? -1 : b ? 1 : 0;
	const typeRank = (node: WorldNode) => (node.type === 'folder' ? 0 : node.type === 'note' ? 1 : node.type === 'external' ? 2 : 3);
	return typeRank(a) - typeRank(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

function maxRadius(positions: Map<string, RadialPoint>): number {
	let max = 0;
	for (const point of positions.values()) max = Math.max(max, point.radius);
	return max;
}

function preferredAngleForNode(
	node: WorldNode,
	graph: VisibleWorldGraph,
	positions: Map<string, RadialPoint>,
	fallbackAngle: number,
): number {
	const angles: number[] = [];
	for (const edge of graph.linkEdges) {
		const otherId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
		if (!otherId) continue;
		const other = positions.get(otherId);
		if (other && Number.isFinite(other.angle)) angles.push(other.angle);
	}
	return averageAngles(angles, fallbackAngle);
}

function averageAngles(angles: number[], fallbackAngle: number): number {
	if (angles.length === 0) return fallbackAngle;
	const sum = angles.reduce(
		(acc, angle) => {
			acc.x += Math.cos(angle);
			acc.y += Math.sin(angle);
			return acc;
		},
		{ x: 0, y: 0 },
	);
	if (Math.abs(sum.x) < 0.0001 && Math.abs(sum.y) < 0.0001) return fallbackAngle;
	return Math.atan2(sum.y, sum.x);
}

function orderRingItemsByPreferredGap(items: RingItem[]): RingItem[] {
	const sorted = items.slice().sort((a, b) => normalizeAngle(a.preferred) - normalizeAngle(b.preferred));
	if (sorted.length <= 2) return sorted;
	let largestGap = -1;
	let largestGapIndex = 0;
	for (let index = 0; index < sorted.length; index++) {
		const current = normalizeAngle(sorted[index]?.preferred ?? 0);
		const next = normalizeAngle(sorted[(index + 1) % sorted.length]?.preferred ?? 0) + (index === sorted.length - 1 ? Math.PI * 2 : 0);
		const gap = next - current;
		if (gap > largestGap) {
			largestGap = gap;
			largestGapIndex = index;
		}
	}
	const start = (largestGapIndex + 1) % sorted.length;
	return sorted.slice(start).concat(sorted.slice(0, start));
}

function outerRingLaneLimit(itemCount: number, depthRatio: number): number {
	const count = Math.max(0, itemCount || 0);
	const outer = clamp(depthRatio, 0, 1);
	const base =
		count > 1600
			? 14
			: count > 900
				? 12
				: count > 420
					? 10
					: count > 180
						? 8
						: count > 80
							? 6
							: 4;
	const outerBonus = outer > 0.72 ? 3 : outer > 0.48 ? 2 : outer > 0.28 ? 1 : 0;
	return clamp(base + outerBonus, 4, 16);
}

function orderRingGroupsByParent(items: RingItem[]): { parentId: string; parentAngle: number; arcDemand: number; items: RingItem[] }[] {
	const groupsByParent = new Map<string, { parentId: string; parentAngle: number; arcDemand: number; items: RingItem[] }>();
	for (const item of items) {
		const key = item.parentId ?? item.id;
		const group = groupsByParent.get(key) ?? { parentId: key, parentAngle: item.parentAngle, arcDemand: 0, items: [] };
		group.items.push(item);
		group.arcDemand += item.arcDemand || 0;
		group.parentAngle = averageAngles(group.items.map((child) => child.parentAngle), group.parentAngle);
		groupsByParent.set(key, group);
	}
	return [...groupsByParent.values()].sort((a, b) => normalizeAngle(a.parentAngle) - normalizeAngle(b.parentAngle));
}

function chooseRingLaneForGroup(lanes: RingItem[][], groupItems: RingItem[], parentAngle: number): number {
	let bestIndex = 0;
	let bestScore = Infinity;
	const groupArc = groupItems.reduce((sum, item) => sum + (item.arcDemand || 0), 0);
	for (let index = 0; index < lanes.length; index++) {
		const lane = lanes[index] ?? [];
		const laneArc = lane.reduce((sum, item) => sum + (item.arcDemand || 0), 0);
		const last = lane[lane.length - 1];
		const angleCost = last ? Math.abs(shortestAngleDelta(last.parentAngle || last.preferred, parentAngle)) : 0;
		const score = laneArc + groupArc * 0.18 + angleCost * 180;
		if (score < bestScore) {
			bestScore = score;
			bestIndex = index;
		}
	}
	return bestIndex;
}

function orderRingItemsByParentThenPreferred(items: RingItem[]): RingItem[] {
	const ordered: RingItem[] = [];
	for (const group of orderRingGroupsByParent(items)) ordered.push(...orderRingItemsByPreferredGap(group.items));
	return ordered;
}

function placeItemsOnRingLane(items: RingItem[], radius: number, options: { jitterBand: number; preservePreferred: boolean }): void {
	if (!items.length || !Number.isFinite(radius) || radius <= 0) return;
	const fullCircle = Math.PI * 2;
	const arcs = items.map((item) => Math.max(0.003, item.arcDemand / radius));
	const totalArc = arcs.reduce((sum, arc) => sum + arc, 0);
	const jitterBand = clamp(options.jitterBand, 0, Math.max(0, radius * RING_JAGGED_MAX_FACTOR));
	const parentOffsets = parentRadialOffsetsForLane(items, jitterBand);
	const minGap = Math.min(0.11, Math.max(0.012, (totalArc / Math.max(1, items.length)) * 0.18));
	const minDemand = totalArc + minGap * Math.max(0, items.length - 1);
	const canPreserve = options.preservePreferred && items.length <= 640 && minDemand < fullCircle * 0.9;
	if (canPreserve && placeItemsNearPreferredAngles(items, arcs, radius, jitterBand, parentOffsets, minGap)) return;
	const extraGap = Math.max(0, (fullCircle - totalArc) / items.length);
	let cursor = normalizeAngle(items[0]?.preferred ?? 0) - ((arcs[0] ?? 0) + extraGap) * 0.5;
	for (let index = 0; index < items.length; index++) {
		const width = (arcs[index] ?? 0) + extraGap;
		const angle = cursor + width * 0.5;
		const item = items[index];
		if (item) setRingLanePoint(item, radius, angle, jitterBand, parentOffsets);
		cursor += width;
	}
}

function placeItemsNearPreferredAngles(
	items: RingItem[],
	arcs: number[],
	radius: number,
	jitterBand: number,
	parentOffsets: Map<string, number>,
	minGap: number,
): boolean {
	if (!items.length) return true;
	const fullCircle = Math.PI * 2;
	let entries = items
		.map((item, index) => ({ item, arc: arcs[index] ?? 0.003, preferred: normalizeAngle(item.preferred) }))
		.sort((a, b) => a.preferred - b.preferred);
	if (entries.length > 1) {
		let largestGap = -1;
		let largestGapIndex = 0;
		for (let index = 0; index < entries.length; index++) {
			const current = entries[index]?.preferred ?? 0;
			const next = (entries[(index + 1) % entries.length]?.preferred ?? 0) + (index === entries.length - 1 ? fullCircle : 0);
			const gap = next - current;
			if (gap > largestGap) {
				largestGap = gap;
				largestGapIndex = index;
			}
		}
		const start = (largestGapIndex + 1) % entries.length;
		entries = entries.slice(start).concat(entries.slice(0, start));
	}
	const angles: number[] = [];
	let wrapOffset = 0;
	let previous = entries[0]?.preferred ?? 0;
	angles[0] = previous;
	for (let index = 1; index < entries.length; index++) {
		let angle = (entries[index]?.preferred ?? 0) + wrapOffset;
		while (angle <= previous) {
			wrapOffset += fullCircle;
			angle = (entries[index]?.preferred ?? 0) + wrapOffset;
		}
		angles[index] = angle;
		previous = angle;
	}
	const preferredCenter = ((angles[0] ?? 0) + (angles[angles.length - 1] ?? 0)) * 0.5;
	for (let pass = 0; pass < 3; pass++) {
		for (let index = 1; index < entries.length; index++) {
			const minDelta = ((entries[index - 1]?.arc ?? 0) + (entries[index]?.arc ?? 0)) * 0.5 + minGap;
			if ((angles[index] ?? 0) - (angles[index - 1] ?? 0) < minDelta) angles[index] = (angles[index - 1] ?? 0) + minDelta;
		}
	}
	const span =
		(angles[angles.length - 1] ?? 0) +
		(entries[entries.length - 1]?.arc ?? 0) * 0.5 -
		((angles[0] ?? 0) - (entries[0]?.arc ?? 0) * 0.5);
	if (span > fullCircle - minGap) return false;
	const currentCenter = ((angles[0] ?? 0) + (angles[angles.length - 1] ?? 0)) * 0.5;
	const centerShift = preferredCenter - currentCenter;
	for (let index = 0; index < entries.length; index++) {
		setRingLanePoint(entries[index]!.item, radius, normalizeAngle((angles[index] ?? 0) + centerShift), jitterBand, parentOffsets);
	}
	return true;
}

function setRingLanePoint(item: RingItem, radius: number, angle: number, jitterBand: number, parentOffsets: Map<string, number>): void {
	const actualRadius = jaggedRingRadius(item, radius, jitterBand, parentOffsets);
	const point = item.point;
	point.x = Math.cos(angle) * actualRadius;
	point.y = Math.sin(angle) * actualRadius;
	point.radius = actualRadius;
	point.ringRadius = radius;
	point.ringBandMin = radius - jitterBand;
	point.ringBandMax = radius + jitterBand;
	point.angle = angle;
}

function parentRadialOffsetsForLane(items: RingItem[], jitterBand: number): Map<string, number> {
	const offsets = new Map<string, number>();
	if (!items.length || jitterBand <= 0) return offsets;
	const parentOrder: string[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const key = ringParentKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		parentOrder.push(key);
	}
	const lanePattern = [0, -0.96, 0.96, -0.54, 0.54, -0.78, 0.78, -0.28, 0.28];
	for (let index = 0; index < parentOrder.length; index++) {
		const key = parentOrder[index] ?? '';
		const base = lanePattern[index % lanePattern.length] ?? 0;
		const variation = deterministicUnitOffset(key, 'ring-parent-variation') * 0.12;
		offsets.set(key, clamp(base + variation, -1, 1) * jitterBand);
	}
	return offsets;
}

function ringJaggedDepthFactor(depth: number, radius: number, ringGap: number, itemCount: number, arcDemand: number): number {
	const normalizedDepth = Math.max(0, depth || 0);
	const normalizedRadius = Number.isFinite(radius) && ringGap > 0 ? radius / ringGap : normalizedDepth;
	const occupancy = Number.isFinite(radius) && radius > 0 ? arcDemand / Math.max(1, Math.PI * 2 * radius) : 0;
	const outerFactor = clamp(0.82 + normalizedDepth * 0.06 + Math.sqrt(Math.max(0, normalizedRadius)) * 0.13, 0.86, 1.62);
	const densityFactor = itemCount <= 5 ? 0.48 : itemCount <= 10 ? 0.68 : occupancy < 0.12 ? 0.62 : occupancy < 0.24 ? 0.82 : occupancy > 0.52 ? 1.16 : 1;
	return clamp(outerFactor * densityFactor, 0.42, 1.72);
}

function ringJaggedDensityFactor(itemCount: number, parentCount: number, arcDemand: number, radius: number): number {
	const count = Math.max(0, itemCount || 0);
	const parents = Math.max(1, parentCount || 1);
	const occupancy = Number.isFinite(radius) && radius > 0 ? arcDemand / Math.max(1, Math.PI * 2 * radius) : 0;
	const childFactor = count <= 3 ? 0.42 : count <= 7 ? 0.66 : count <= 14 ? 0.86 : 1.05;
	const parentFactor = parents <= 1 ? 0.52 : parents <= 2 ? 0.72 : parents <= 4 ? 0.92 : 1.08;
	const occupancyFactor = occupancy < 0.1 ? 0.56 : occupancy < 0.2 ? 0.78 : occupancy > 0.55 ? 1.14 : 1;
	return clamp(childFactor * parentFactor * occupancyFactor, 0.32, 1.22);
}

function countRingParents(items: RingItem[]): number {
	return new Set(items.map(ringParentKey)).size;
}

function jaggedRingRadius(item: RingItem, radius: number, jitterBand: number, parentOffsets: Map<string, number>): number {
	if (jitterBand <= 0) return radius;
	const parentKey = ringParentKey(item);
	const parentOffset = parentOffsets.get(parentKey) ?? deterministicUnitOffset(parentKey, 'ring-parent') * jitterBand * 0.92;
	const childOffset = deterministicUnitOffset(item.id, 'ring-node') * jitterBand * 0.08;
	return radius + clamp(parentOffset + childOffset, -jitterBand, jitterBand);
}

function ringParentKey(item: RingItem): string {
	return item.parentId ?? item.id;
}

function labelCollisionPadding(node: WorldNode): number {
	const titleLength = Array.from(String(node.title || '')).length;
	const typePad = node.type === 'folder' ? 13 : node.type === 'external' || node.externalProxy ? 9 : 5;
	return clamp(Math.sqrt(Math.max(1, titleLength)) * 4.2 + typePad, 10, 60);
}

function labelArcPadding(node: WorldNode): number {
	const titleLength = Array.from(String(node.title || '')).length;
	const folderPad = node.type === 'folder' ? 14 : 0;
	const externalPad = node.type === 'external' || node.externalProxy ? 9 : 0;
	return clamp(Math.sqrt(Math.max(1, titleLength)) * 7.5 + Math.min(110, titleLength * 1.25) + folderPad + externalPad, 24, 150);
}

function applyRadialSwirl(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, spacing: SpacingProfile, amount: number): void {
	const rootId = graph.rootId || ROOT_ID;
	const direction = deterministicUnitOffset(rootId || 'vault', 'swirl-direction') >= 0 ? 1 : -1;
	for (const [id, point] of positions.entries()) {
		if (point.radius <= 0.001) continue;
		const depth = Math.max(0, point.depth || 0);
		const baseAngle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
		const radialPhase = Math.sqrt(Math.max(0, point.radius) / Math.max(1, spacing.ringGap));
		const armVariation = deterministicUnitOffset(id, 'swirl-arm') * 0.16;
		const wave = Math.sin(baseAngle * 2.35 + depth * 0.78) * 0.11;
		const turn = direction * amount * (depth * 0.32 + radialPhase * 0.22 + armVariation + wave);
		const angle = normalizeAngle(baseAngle + turn);
		point.x = Math.cos(angle) * point.radius;
		point.y = Math.sin(angle) * point.radius;
		point.angle = angle;
	}
}

function anchorHomePositions(positions: Map<string, RadialPoint>): void {
	for (const point of positions.values()) {
		point.homeX = point.x;
		point.homeY = point.y;
		point.homeRadius = point.radius;
		point.homeAngle = point.angle;
	}
}

function blendAngles(from: number, to: number, amount: number): number {
	return normalizeAngle(from + shortestAngleDelta(from, to) * clamp(amount, 0, 1));
}

function normalizeAngle(angle: number): number {
	let next = Number.isFinite(angle) ? angle : 0;
	next %= Math.PI * 2;
	if (next < 0) next += Math.PI * 2;
	return next;
}

function shortestAngleDelta(from: number, to: number): number {
	let delta = normalizeAngle(to) - normalizeAngle(from);
	if (delta > Math.PI) delta -= Math.PI * 2;
	if (delta < -Math.PI) delta += Math.PI * 2;
	return delta;
}

function deterministicPairAngle(a: string, b: string): number {
	const text = `${a}|${b}`;
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

function deterministicUnitOffset(value: string, salt: string): number {
	return Math.sin(deterministicPairAngle(String(value || ''), String(salt || '')));
}

function medianNumber(values: number[], fallback: number): number {
	const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!numbers.length) return fallback;
	const middle = Math.floor(numbers.length / 2);
	return numbers.length % 2 ? (numbers[middle] ?? fallback) : ((numbers[middle - 1] ?? fallback) + (numbers[middle] ?? fallback)) / 2;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}
