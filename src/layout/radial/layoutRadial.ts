import type { VisibleWorldGraph, WorldEdge, WorldNode } from '../../world/types';
import { ROOT_ID } from '../../world/types';

export const DEFAULT_RING_SPACING = 1160;
export const MIN_RING_SPACING = 620;
export const MAX_RING_SPACING = 2800;
export const DEFAULT_NODE_SPACING = 144;
export const MIN_NODE_SPACING = 72;
export const MAX_NODE_SPACING = 360;

const RING_JAGGED_BAND_FACTOR = 0.3;
const RING_JAGGED_INNER_FACTOR = 0.15;
const RING_JAGGED_OUTER_FACTOR = 0.34;
const LEAF_SPAN_DEMAND = 0.045;

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
	sectorStart?: number;
	sectorEnd?: number;
	sectorSpan?: number;
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
	spanDemand: number;
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
	parentSectorSpan: number;
	sectorSpan: number;
	fanWeight: number;
	parentIsRoot: boolean;
}

interface FanPlacement {
	item: RingItem;
	angle: number;
	sectorStart: number;
	sectorEnd: number;
}

interface ParentRingGroup {
	parentId: string;
	parentAngle: number;
	preferred: number;
	arcDemand: number;
	fanWeight: number;
	span: number;
	center: number;
	sectorSpan: number;
	items: RingItem[];
}

interface ParentRingSectorEntry {
	group: ParentRingGroup;
	anchor: number;
	minSpan: number;
	desiredSpan: number;
	maxSpan: number;
	weight: number;
	parentAnchored: boolean;
	anchorPull: number;
}

interface DepthRingStats {
	count: number;
	diameterTotal: number;
	maxDiameter: number;
	external: number;
	linkPressure: number;
	arcDemand: number;
}

interface SectorRingLaneItem {
	id: string;
	node: WorldNode;
	point: RadialPoint;
	visualRadius: number;
	arcDemand: number;
	kind: string;
	parentKey: string;
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
		const rootPoint = makePoint(0, -Math.PI / 2, 0, nodeRadius(nodesById.get(rootId), maxDegree, spacing.incidentPressureByNode.get(rootId) ?? 0), false);
		setPointSector(rootPoint, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2);
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
			placeOuterCircleNodes(orphanNodes, positions, graph, nodesById, outerRadius + spacing.ringGap * 0.64, spacing.nodeGap, -Math.PI / 2, maxTreeDepth + 1, false, maxDegree, spacing.incidentPressureByNode),
		);
	}

	const externalGroups = graph.nodes.filter((node) => node.type === 'external' && !node.externalProxy).sort(compareLayoutNode);
	const externalFiles = graph.nodes.filter((node) => node.externalProxy).sort(compareLayoutNode);

	const ringTargets = assignDepthRingTargets(positions, graph, spacing, spacing.nodeGap, maxDegree);
	applySectorPreservingRingLanes(positions, graph, spacing, spacing.nodeGap, ringTargets, maxDegree);
	if (spacing.radiusExpansion > 1.001) applyAdaptiveRadiusExpansion(positions, ringTargets, spacing);
	applyMiddleRingRadiusRelief(positions, ringTargets);
	enforceDepthBaselineProgression(positions, ringTargets, spacing);
	const spinSpeed = clamp(options.swirlStrength, 0, 100) / 100;
	const swirlStrength = spinSpeed > 0.001 ? clamp(0.24 + spinSpeed * 0.34, 0.24, 0.58) : 0;
	if (swirlStrength > 0.001) applyRadialSwirl(positions, graph, spacing, swirlStrength);
	preserveHierarchyRouteOrder(positions, graph);
	enforceOuterHierarchyContinuity(positions, graph, spacing);
	outerRadius = Math.max(outerRadius, maxRadius(positions));
	outerRadius = Math.max(
		outerRadius,
		placeExternalShells(externalGroups, externalFiles, positions, graph, nodesById, outerRadius, maxTreeDepth, spacing, maxDegree),
	);
	const routeMaxDepth = Math.max(1, ...[...positions.values()].map((point) => Math.max(0, Math.round(point.depth || 0))));
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
		const fallback = { weight: 1, count: 1, maxDepth: depth, spanDemand: LEAF_SPAN_DEMAND };
		metrics.set(id, fallback);
		return fallback;
	}
	visiting.add(id);
	const incidentPressure = spacing.incidentPressureByNode.get(id) ?? 0;
	let weight = Math.min(9, incidentPressure * 0.24);
	let count = 1;
	let maxDepth = depth;
	const childMetrics: Metric[] = [];
	for (const childId of childrenByParent.get(id) ?? []) {
		const child = measureSubtree(childId, depth + 1, childrenByParent, spacing, metrics, visiting);
		childMetrics.push(child);
		weight += child.weight;
		count += child.count;
		maxDepth = Math.max(maxDepth, child.maxDepth);
	}
	visiting.delete(id);
	const metric = {
		weight: Math.max(1, weight || 1),
		count,
		maxDepth,
		spanDemand: subtreeSpanDemand(childMetrics),
	};
	metrics.set(id, metric);
	return metric;
}

function collectReachable(id: string | null | undefined, childrenByParent: Map<string, string[]>, reachable: Set<string>): void {
	if (id === null || id === undefined || reachable.has(id)) return;
	reachable.add(id);
	for (const childId of childrenByParent.get(id) ?? []) collectReachable(childId, childrenByParent, reachable);
}

function subtreeSpanDemand(children: Metric[]): number {
	if (children.length === 0) return LEAF_SPAN_DEMAND;
	if (children.length === 1) {
		return clamp((children[0]?.spanDemand ?? LEAF_SPAN_DEMAND) * 0.985, LEAF_SPAN_DEMAND, Math.PI * 1.94);
	}
	const directFanDemand = directChildFanDemand(children.length);
	const carriedDemand = children.reduce((sum, child) => sum + Math.max(LEAF_SPAN_DEMAND, child.spanDemand), 0);
	const gapDemand = Math.max(0, children.length - 1) * 0.018;
	const compactedCarriedDemand = Math.pow(Math.max(0, carriedDemand + gapDemand), 0.92) * 1.04;
	return clamp(Math.max(directFanDemand, compactedCarriedDemand), LEAF_SPAN_DEMAND, Math.PI * 1.96);
}

function directChildFanDemand(count: number): number {
	if (count <= 1) return LEAF_SPAN_DEMAND;
	if (count <= 2) return 0.16;
	if (count <= 4) return 0.28 + (count - 2) * 0.09;
	if (count <= 8) return 0.52 + (count - 4) * 0.13;
	if (count <= 14) return 1.06 + (count - 8) * 0.18;
	if (count <= 24) return 2.16 + (count - 14) * 0.17;
	if (count <= 48) return 3.88 + (count - 24) * 0.062;
	return Math.min(Math.PI * 1.84, 5.4 + Math.log2(count / 48) * 0.34);
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

	if (children.length === 1) {
		const localSpan = parentId === rootId ? Math.PI * 2 : span;
		start = parentAngle - localSpan / 2;
		end = parentAngle + localSpan / 2;
		span = localSpan;
	} else if (parentId !== rootId) {
		const localSpan = childFanSpanForParent(parentId, depth, children, span, childRadius, nodeGap, childrenByParent, metrics);
		start = parentAngle - localSpan / 2;
		end = parentAngle + localSpan / 2;
		span = localSpan;
	}

	if (children.length > 1) {
		const requiredRadius = ((children.length - 1) * nodeGap) / Math.max(0.16, span * 0.64);
		const maxExtra = spacing.ringGap * (parentId === rootId ? 1.8 : 2.8);
		childRadius = Math.max(childRadius, Math.min(parentPoint.radius + maxExtra, requiredRadius));
	}

	const childWeights = children.map((childId) => subtreeAllocationWeight(childId, depth + 1, childrenByParent, metrics));
	const totalWeight = Math.max(1, childWeights.reduce((sum, weight) => sum + weight, 0));
	const siblingGapScale = children.length > 8 ? clamp(2.2 / Math.sqrt(children.length), 0.28, 0.82) : 1;
	const gapBudgetFactor =
		children.length > 8 ? clamp(0.28 - Math.min(0.14, (children.length - 8) * 0.0065), 0.14, 0.28) : 0.38;
	const localGap = children.length > 1 ? Math.min((nodeGap / childRadius) * siblingGapScale, (span * gapBudgetFactor) / (children.length - 1)) : 0;
	const usableSpan = Math.max(0.001, span - localGap * Math.max(0, children.length - 1));
	let cursor = start;

	for (let index = 0; index < children.length; index++) {
		const childId = children[index]!;
		const childSpan = children.length === 1 ? usableSpan : usableSpan * ((childWeights[index] ?? 1) / totalWeight);
		const childStart = cursor;
		const childEnd = cursor + childSpan;
		const angle = childStart + childSpan / 2;
		const node = nodesById.get(childId);
		const childPoint = makePoint(childRadius, angle, depth + 1, nodeRadius(node, maxDegree, spacing.incidentPressureByNode.get(childId) ?? 0), false);
		setPointSector(childPoint, childStart, childEnd);
		positions.set(childId, childPoint);
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
	let factor = 0.48 + depth * 0.068 + childRoot * 0.096 + subtreeSignal * 0.062 + pressureSignal * 0.052;
	if (parentId === rootId) factor *= 0.96;
	if (childCount <= 4) factor = Math.min(factor, parentId === rootId ? 0.78 : 0.92);
	if (childCount >= 14) factor = Math.max(factor, 1.02 + Math.min(0.78, childRoot * 0.068));
	if (childCount >= 40) factor = Math.max(factor, 1.28 + Math.min(1.02, childRoot * 0.064));
	return clamp(spacing.baseRingGap * factor, parentId === rootId ? 220 : 250, 3400);
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

function childFanSpanForParent(
	parentId: string,
	depth: number,
	children: string[],
	inheritedSpan: number,
	childRadius: number,
	nodeGap: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
): number {
	if (children.length <= 1) return inheritedSpan;
	const demandSpan = ((children.length - 1) * nodeGap) / Math.max(1, childRadius) + 0.08;
	const parentMetric = metrics.get(parentId) ?? {
		count: children.length + 1,
		weight: children.length + 1,
		maxDepth: depth + 1,
		spanDemand: directChildFanDemand(children.length),
	};
	const maxChildFanWeight = Math.max(...children.map((childId) => subtreeFanWeight(childId, depth + 1, childrenByParent, metrics)), 1);
	const totalChildFanWeight = children.reduce((sum, childId) => sum + subtreeFanWeight(childId, depth + 1, childrenByParent, metrics), 0);
	const branchSignal = Math.log2(Math.max(2, children.length + 1));
	const subtreeSignal = Math.log2(Math.max(2, parentMetric.count || children.length + 1));
	const balance = maxChildFanWeight / Math.max(1, totalChildFanWeight);
	const hasBroadSubtree = parentMetric.count > children.length * 2 || children.some((childId) => (childrenByParent.get(childId)?.length ?? 0) > 2);
	const baseUse = hasBroadSubtree ? 0.965 : 0.88;
	let fill = clamp(baseUse + branchSignal * 0.018 + subtreeSignal * 0.012 - balance * 0.045, 0.84, 0.97);
	if (children.length <= 4 && !hasBroadSubtree) {
		fill = Math.min(fill, clamp(0.38 + children.length * 0.095 + subtreeSignal * 0.018, 0.48, 0.74));
	}
	const desiredSpan = Math.max(demandSpan, inheritedSpan * fill, childFanComfortSpan(children, childrenByParent));
	const leafFan = children.every((childId) => (childrenByParent.get(childId)?.length ?? 0) === 0);
	const maxSpan =
		leafFan && inheritedSpan < Math.PI * 1.98
			? Math.max(0.08, inheritedSpan * 0.985)
			: maxExpandedChildFanSpan(parentId, depth, children, inheritedSpan, childRadius, nodeGap, childrenByParent, metrics);
	const minSpan = children.length <= 4 ? Math.min(maxSpan, 0.08) : Math.min(inheritedSpan, maxSpan);
	return clamp(desiredSpan, minSpan, maxSpan);
}

function childFanComfortSpan(children: string[], childrenByParent: Map<string, string[]>): number {
	const count = children.length;
	if (count <= 1) return 0;
	const directChildCounts = children.map((childId) => childrenByParent.get(childId)?.length ?? 0);
	const branchyChildren = directChildCounts.filter((childCount) => childCount > 0).length;
	const maxDirectChildren = Math.max(0, ...directChildCounts);
	const base =
		count >= 48
			? Math.PI * 1.68
			: count >= 24
				? Math.PI * 1.26
				: count >= 14
					? Math.PI * 1.1
					: count >= 9
						? Math.PI * 0.82
						: count >= 5
							? Math.PI * 0.56
							: count >= 3
								? Math.PI * 0.34
								: Math.PI * 0.2;
	const branchPenalty = branchyChildren > 0 ? clamp(1 - Math.sqrt(branchyChildren) * 0.095 - Math.sqrt(maxDirectChildren) * 0.03, 0.56, 0.92) : 1;
	return base * branchPenalty;
}

function maxExpandedChildFanSpan(
	parentId: string,
	depth: number,
	children: string[],
	inheritedSpan: number,
	childRadius: number,
	nodeGap: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
): number {
	const count = children.length;
	const directChildCounts = children.map((childId) => childrenByParent.get(childId)?.length ?? 0);
	const maxDirectChildren = Math.max(0, ...directChildCounts);
	const branchyChildren = directChildCounts.filter((childCount) => childCount > 0).length;
	const parentMetric = metrics.get(parentId) ?? {
		count: count + 1,
		weight: count + 1,
		maxDepth: depth + 1,
		spanDemand: directChildFanDemand(count),
	};
	const relativeDepth = Math.max(0, parentMetric.maxDepth - depth);
	const demandSpan = ((count - 1) * nodeGap) / Math.max(1, childRadius) + 0.08;
	const countLimit =
		count >= 48
			? Math.PI * 1.82
			: count >= 24
				? Math.PI * 1.68
				: count >= 14
					? Math.PI * 1.5
					: count >= 9
						? Math.PI * 1.16
						: count >= 5
							? Math.PI * 0.72
							: Math.PI * 0.48;
	const branchPenalty = branchyChildren > 0 ? clamp(1 - Math.sqrt(branchyChildren) * 0.08 - Math.sqrt(maxDirectChildren) * 0.025, 0.62, 0.94) : 1;
	const depthLift = clamp(1 + Math.max(0, depth - 1) * 0.035 + Math.sqrt(relativeDepth) * 0.026, 1, 1.22);
	const demandLift = demandSpan > inheritedSpan ? clamp(demandSpan / Math.max(0.08, inheritedSpan), 1, 1.35) : 1;
	const expandedLimit = countLimit * branchPenalty * depthLift * demandLift;
	const inheritedAllowance = inheritedSpan * (count >= 9 ? 1.45 : count >= 5 ? 1.28 : 1.14);
	return clamp(Math.max(inheritedAllowance, expandedLimit, demandSpan * 1.04), 0.12, Math.PI * 1.88);
}

function subtreeFanWeight(
	id: string,
	depth: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
): number {
	const metric = metrics.get(id) ?? { count: 1, weight: 1, maxDepth: depth, spanDemand: LEAF_SPAN_DEMAND };
	const directChildren = childrenByParent.get(id)?.length ?? 0;
	const relativeDepth = Math.max(0, metric.maxDepth - depth);
	const breadth = directChildren > 0 ? Math.pow(directChildren, 1.12) * 1.35 : 0;
	const mass = Math.pow(Math.max(1, metric.count), 0.78);
	const depthReserve = relativeDepth > 0 ? Math.sqrt(relativeDepth + 1) * 0.72 : 0;
	const linkReserve = Math.pow(Math.max(1, metric.weight), 0.58) * 0.34;
	return Math.max(1, mass + breadth + depthReserve + linkReserve);
}

function subtreeAllocationWeight(
	id: string,
	depth: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
): number {
	const metric = metrics.get(id) ?? { count: 1, weight: 1, maxDepth: depth, spanDemand: LEAF_SPAN_DEMAND };
	const structural = subtreeFanWeight(id, depth, childrenByParent, metrics);
	const spanDemand = clamp(metric.spanDemand ?? LEAF_SPAN_DEMAND, LEAF_SPAN_DEMAND, Math.PI * 1.98);
	const demandWeight = Math.pow(spanDemand, 1.62) * 18;
	const structuralWeight = Math.pow(Math.max(1, structural), 0.58) * 0.18;
	return Math.max(0.18, demandWeight + structuralWeight);
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
	incidentPressureByNode = new Map<string, number>(),
): number {
	if (nodes.length === 0) return radius;
	radius = Math.max(radius, outerCircleDemandRadius(nodes, nodesById, nodeGap, maxDegree, incidentPressureByNode));
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
		const point = makePoint(radius, angle, depth || item.node.depth || 1, nodeRadius(nodesById.get(item.node.id), maxDegree, incidentPressureByNode.get(item.node.id) ?? 0), external);
		point.ringRadius = radius;
		point.ringBandMin = radius;
		point.ringBandMax = radius;
		positions.set(item.node.id, point);
	}
	return radius;
}

function outerCircleDemandRadius(
	nodes: WorldNode[],
	nodesById: Map<string, WorldNode>,
	nodeGap: number,
	maxDegree: number,
	incidentPressureByNode: Map<string, number>,
): number {
	if (nodes.length <= 1) return 0;
	const demand = nodes.reduce((sum, node) => {
		const visualRadius = nodeRadius(nodesById.get(node.id), maxDegree, incidentPressureByNode.get(node.id) ?? 0);
		return sum + visualRadius * 2.6 + labelArcPadding(node) * 1.35 + Math.max(18, nodeGap * 0.18);
	}, 0);
	const utilization = nodes.length > 80 ? 0.48 : nodes.length > 28 ? 0.42 : 0.36;
	return demand / Math.max(1, Math.PI * 2 * utilization);
}

function placeExternalShells(
	externalGroups: WorldNode[],
	externalFiles: WorldNode[],
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	nodesById: Map<string, WorldNode>,
	regularOuterRadius: number,
	maxTreeDepth: number,
	spacing: SpacingProfile,
	maxDegree: number,
): number {
	let outerRadius = regularOuterRadius;
	const hasGroups = externalGroups.length > 0;
	const hasFiles = externalFiles.length > 0;
	if (!hasGroups && !hasFiles) return outerRadius;
	const baseGap = externalShellGap(regularOuterRadius, spacing, hasFiles ? 1.1 : 1);
	if (hasGroups) {
		outerRadius = placeOuterCircleNodes(
			externalGroups,
			positions,
			graph,
			nodesById,
			regularOuterRadius + baseGap,
			spacing.nodeGap * 1.18,
			-Math.PI / 3,
			maxTreeDepth + 1,
			true,
			maxDegree,
			spacing.incidentPressureByNode,
		);
	}
	if (hasFiles) {
		const fileBase =
			Math.max(outerRadius, regularOuterRadius) +
			(hasGroups
				? externalShellGap(regularOuterRadius, spacing, 0.58)
				: externalShellGap(regularOuterRadius, spacing, 1.08));
		outerRadius = placeOuterCircleNodes(
			externalFiles,
			positions,
			graph,
			nodesById,
			fileBase,
			spacing.nodeGap,
			-Math.PI / 5,
			maxTreeDepth + (hasGroups ? 2 : 1),
			true,
			maxDegree,
			spacing.incidentPressureByNode,
		);
	}
	return outerRadius;
}

function externalShellGap(regularOuterRadius: number, spacing: SpacingProfile, factor: number): number {
	const radiusScaledGap = Math.max(0, regularOuterRadius) * 0.1;
	return Math.max(spacing.ringGap * 1.05, spacing.nodeGap * 2.15, radiusScaledGap, 720) * factor;
}

function assignDepthRingTargets(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	nodeGap: number,
	maxDegree: number,
): Map<number, number> {
	const ringTargets = new Map<number, number>([[0, 0]]);
	const byDepth = new Map<number, DepthRingStats>();
	for (const [id, point] of positions.entries()) {
		const depth = Math.max(0, Math.round(point.depth || 0));
		const node = graph.nodesById.get(id);
		const visualRadius = nodeRadius(node, maxDegree, spacing.incidentPressureByNode.get(id) ?? 0);
		const diameter = visualRadius * 2 + Math.max(18, nodeGap * 0.36);
		const arcDemand = visualRadius * 2.55 + (node ? labelArcPadding(node) : 24) * 1.42 + Math.max(18, nodeGap * 0.2);
		const entry = byDepth.get(depth) ?? { count: 0, diameterTotal: 0, maxDiameter: 0, external: 0, linkPressure: 0, arcDemand: 0 };
		entry.count++;
		entry.diameterTotal += diameter;
		entry.maxDiameter = Math.max(entry.maxDiameter, diameter);
		entry.linkPressure += spacing.incidentPressureByNode.get(id) ?? 0;
		entry.arcDemand += arcDemand;
		if (point.external || node?.externalProxy || node?.type === 'external') entry.external++;
		byDepth.set(depth, entry);
	}

	let previousRadius = 0;
	let previousGap = spacing.ringGap;
	const depths = [...byDepth.keys()].filter((depth) => depth > 0).sort((a, b) => a - b);
	const totalNodes = [...byDepth.values()].reduce((sum, entry) => sum + entry.count, 0);
	const averageRingCount = totalNodes / Math.max(1, depths.length);
	const maxRingCount = Math.max(1, ...depths.map((depth) => byDepth.get(depth)?.count ?? 0));
	const outerDepth = depths[depths.length - 1] ?? 0;
	const outerBaselineStartDepth = depths[Math.max(0, depths.length - 2)] ?? outerDepth;
	for (const depth of depths) {
		const entry = byDepth.get(depth);
		if (!entry) continue;
		const isOuterDepth = depth === outerDepth;
		const outerBandWeight = isOuterDepth ? 1 : depth >= outerBaselineStartDepth ? 0.65 : 0;
		const density = ringCountDensity(entry.count, averageRingCount, maxRingCount);
		const pressureSignal = Math.sqrt(entry.linkPressure / Math.max(1, entry.count));
		const demandRadius = depthRingDemandRadius(entry, nodeGap, density.pressure, pressureSignal, outerBandWeight);
		const carriedGap = baselineProgressionGap(previousGap, spacing, outerBandWeight);
		const structuralGap = Math.max(
			minimumBaselineRingGap(entry, spacing, density, pressureSignal),
			carriedGap,
			spacing.ringGap * (0.88 + outerBandWeight * 0.1),
		);
		const structuralRadius = previousRadius + structuralGap;
		const radius = Math.max(structuralRadius, demandRadius);
		ringTargets.set(depth, radius);
		previousGap = radius - previousRadius;
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

function depthRingDemandRadius(
	entry: DepthRingStats,
	nodeGap: number,
	densityPressure: number,
	linkPressure: number,
	outerBandWeight = 0,
): number {
	if (entry.count <= 1) return entry.maxDiameter * 1.18;
	const outerWeight = clamp(outerBandWeight, 0, 1);
	const count = Math.max(1, entry.count);
	const paddingDemand = count * Math.max(10, nodeGap * (0.14 + outerWeight * 0.06));
	const circumferenceDemand = Math.max(entry.diameterTotal, entry.arcDemand * (0.78 + outerWeight * 0.16)) + paddingDemand;
	const utilization = clamp(
		(0.62 - outerWeight * 0.08) -
			Math.min(0.18 + outerWeight * 0.02, densityPressure * 0.07) -
			Math.min(0.08 + outerWeight * 0.02, linkPressure * 0.012) -
			(entry.external ? 0.04 : 0),
		0.38 - outerWeight * 0.1,
		0.62 - outerWeight * 0.08,
	);
	return circumferenceDemand / Math.max(1, Math.PI * 2 * utilization) + entry.maxDiameter * (0.9 + outerWeight * 0.3);
}

function baselineProgressionGap(previousGap: number, spacing: SpacingProfile, outerBandWeight: number): number {
	const outerWeight = clamp(outerBandWeight, 0, 1);
	if (outerWeight <= 0) return Math.min(previousGap * 0.82, spacing.ringGap * 1.55);
	return Math.max(
		previousGap * (1.08 + outerWeight * 0.16),
		spacing.ringGap * (1.24 + outerWeight * 0.42),
	);
}

function minimumBaselineRingGap(
	entry: DepthRingStats,
	spacing: SpacingProfile,
	density: ReturnType<typeof ringCountDensity>,
	linkPressure: number,
): number {
	const sparseRelief = clamp(1 - density.relativeToAverage, 0, 0.32);
	const factor = clamp(
		0.92 +
			density.pressure * 0.18 +
			density.maxPressure * 0.12 +
			Math.min(0.12, linkPressure * 0.018) +
			(entry.external ? 0.08 : 0) -
			sparseRelief * 0.08,
		0.84,
		1.68,
	);
	return spacing.ringGap * factor + entry.maxDiameter * 0.62;
}

function ringCountDensity(count: number, averageCount: number, maxCount: number): {
	relativeToAverage: number;
	pressure: number;
	maxPressure: number;
} {
	const normalizedCount = Math.max(0, count || 0);
	const relativeToAverage = normalizedCount / Math.max(1, averageCount || 1);
	const relativeToMax = normalizedCount / Math.max(1, maxCount || normalizedCount || 1);
	return {
		relativeToAverage,
		pressure: clamp(Math.sqrt(relativeToAverage), 0, 2.8),
		maxPressure: clamp(Math.sqrt(relativeToMax), 0, 1),
	};
}

export function resolveRadialCollisions(
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
		const visualRadius = nodeRadius(node, maxDegree, spacing.incidentPressureByNode.get(id) ?? 0) * 1.72;
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

export function enforceDepthRingBands(
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
		const visualRadius = nodeRadius(node, maxDegree, spacing.incidentPressureByNode.get(id) ?? 0);
		const labelDemand = labelCollisionPadding(node) + labelArcPadding(node) * clamp(0.58 + Math.min(1, depth / 4) * 0.42, 0.58, 1);
		const arcDemand = visualRadius * 2.75 + labelDemand * 2.7 + Math.max(22, nodeGap * 0.22);
		const currentAngle = normalizeAngle(Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x));
		const parentPoint = node.parentId !== null && node.parentId !== undefined ? positions.get(node.parentId) : null;
		const parentAngle = parentPoint && Number.isFinite(parentPoint.angle) ? normalizeAngle(parentPoint.angle) : currentAngle;
		const preferred = parentPoint ? blendAngles(currentAngle, parentAngle, 0.68) : currentAngle;
		const list = byDepth.get(depth) ?? [];
		list.push({
			id,
			node,
			point,
			depth,
			parentId: node.parentId ?? null,
			parentAngle,
			visualRadius,
			arcDemand,
			preferred,
			parentSectorSpan: clamp(parentPoint?.sectorSpan ?? Math.PI * 2, 0.024, Math.PI * 2),
			sectorSpan: clamp(point.sectorSpan ?? 0, 0, Math.PI * 2),
			fanWeight: 1,
			parentIsRoot: false,
		});
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
				laneRadius * RING_JAGGED_OUTER_FACTOR * Math.min(1.35, laneJaggedFactor),
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

function applySectorPreservingRingLanes(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	nodeGap: number,
	ringTargets: Map<number, number>,
	maxDegree: number,
): void {
	const byDepth = new Map<number, SectorRingLaneItem[]>();
	for (const [id, point] of positions.entries()) {
		const node = graph.nodesById.get(id);
		if (!node) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		if (depth === 0) {
			point.x = 0;
			point.y = 0;
			point.radius = 0;
			point.ringRadius = 0;
			point.ringBandMin = 0;
			point.ringBandMax = 0;
			point.angle = -Math.PI / 2;
			continue;
		}
		const visualRadius = nodeRadius(node, maxDegree, spacing.incidentPressureByNode.get(id) ?? 0);
		const arcDemand = visualRadius * 2.4 + labelArcPadding(node) * 1.55 + Math.max(18, nodeGap * 0.18);
		const parentKey = node.parentId ?? graph.rootId ?? ROOT_ID;
		const list = byDepth.get(depth) ?? [];
		list.push({ id, node, point, visualRadius, arcDemand, kind: nodeKindKey(node), parentKey });
		byDepth.set(depth, list);
	}

	let previousOuterRadius = 0;
	const depths = [...byDepth.keys()].sort((a, b) => a - b);
	const maxDepth = Math.max(...depths, 1);
	const outerDepth = depths[depths.length - 1] ?? 0;
	const outerBaselineStartDepth = depths[Math.max(0, depths.length - 2)] ?? outerDepth;
	const totalDepthItems = depths.reduce((sum, depth) => sum + (byDepth.get(depth)?.length ?? 0), 0);
	const averageDepthItems = totalDepthItems / Math.max(1, depths.length);
	const maxDepthItems = Math.max(1, ...depths.map((depth) => byDepth.get(depth)?.length ?? 0));
	for (const depth of depths) {
		const items = byDepth.get(depth);
		if (!items?.length) continue;
		const isOuterDepth = depth === outerDepth;
		const outerBandWeight = isOuterDepth ? 1 : depth >= outerBaselineStartDepth ? 0.55 : 0;
		const maxVisualRadius = Math.max(...items.map((item) => item.visualRadius), 4);
		const totalArcDemand = items.reduce((sum, item) => sum + item.arcDemand, 0);
		const targetRadius = ringTargets.get(depth) ?? spacing.ringGap * depth;
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const density = ringCountDensity(items.length, averageDepthItems, maxDepthItems);
		const densityPressure = clamp(density.pressure * 0.72 + density.maxPressure * 0.42, 0, 2.6);
		const laneGap = Math.max(
			maxVisualRadius * (2.08 + densityPressure * 0.22 + depthRatio * 0.12) + Math.max(14, nodeGap * (0.12 + densityPressure * 0.018 + depthRatio * 0.018)),
			spacing.ringGap * (0.064 + densityPressure * 0.024 + depthRatio * 0.012),
		);
		const crowdedBaselineRadius = sectorPreservingCrowdedBaselineRadius(
			targetRadius,
			depth,
			depthRatio,
			densityPressure,
			items.length,
			totalArcDemand,
			spacing,
			nodeGap,
		);
		const outerDemandRadius = outerBandWeight > 0
			? outerBaselineRingDemandRadius(items, positions, spacing, nodeGap, densityPressure, previousOuterRadius, laneGap, isOuterDepth)
			: 0;
		const jitterScale = 1 - outerBandWeight * 0.32;
		const requestedJitterBand = sectorPreservingJaggedBand(depth, targetRadius, spacing, items.length, totalArcDemand, densityPressure) * jitterScale;
		const jitterReserve = sectorPreservingJitterReserve(targetRadius, items.length, totalArcDemand);
		const baselineRadius = Math.max(
			targetRadius,
			crowdedBaselineRadius,
			outerDemandRadius,
			previousOuterRadius + laneGap * 0.38,
			outerBandWeight > 0 ? previousOuterRadius + outerBandLaneGap(spacing, laneGap, outerBandWeight) : 0,
			previousOuterRadius + maxVisualRadius * 1.72 + requestedJitterBand * jitterReserve,
		);
		const jitterBand = Math.min(
			sectorPreservingJaggedBand(depth, baselineRadius, spacing, items.length, totalArcDemand, densityPressure) * jitterScale,
			Math.max(0, baselineRadius - previousOuterRadius - maxVisualRadius * 1.62),
		);
		ringTargets.set(depth, baselineRadius);
		const laneIndexes = sectorPreservingLaneIndexes(items, baselineRadius, nodeGap);
		let depthOuterRadius = baselineRadius;
		for (const item of items) {
			const angle = normalizeAngle(Number.isFinite(item.point.angle) ? item.point.angle : Math.atan2(item.point.y, item.point.x));
			const kindOffset = sectorPreservingKindOffset(item.kind);
			const parentOffset = deterministicUnitOffset(item.parentKey, `depth-${depth}-parent-lane`) * (0.24 + depthRatio * 0.08);
			const laneIndex = laneIndexes.get(item.id) ?? 0;
			const laneDirection = item.kind === 'folder' ? -1 : 1;
			const laneStep = 0.38 + Math.min(0.16, laneIndex * 0.025) + depthRatio * 0.05;
			const laneOffset = clamp(
				kindOffset + parentOffset + laneIndex * laneStep * laneDirection,
				-1.22 - depthRatio * 0.2,
				1.3 + depthRatio * 0.24,
			);
			const parentPoint = item.node.parentId !== null && item.node.parentId !== undefined ? positions.get(item.node.parentId) : null;
			const routeMinRadius = parentPoint
				? parentPoint.radius + routeContinuityGap(parentPoint, spacing, nodeGap, depthRatio, densityPressure)
				: 0;
			const radius = sectorPreservingRadiusForLaneBucket(
				item.id,
				item.parentKey,
				item.kind,
				laneIndex,
				laneOffset,
				baselineRadius,
				laneGap,
				jitterBand,
				depth,
				Math.max(previousOuterRadius + maxVisualRadius * 1.58, routeMinRadius),
			);
			item.point.x = Math.cos(angle) * radius;
			item.point.y = Math.sin(angle) * radius;
			item.point.radius = radius;
			item.point.ringRadius = baselineRadius;
			item.point.ringBandMin = baselineRadius - jitterBand;
			item.point.ringBandMax = baselineRadius + jitterBand;
			item.point.angle = angle;
			depthOuterRadius = Math.max(depthOuterRadius, radius + maxVisualRadius * 0.96);
		}
		previousOuterRadius = depthOuterRadius + Math.max(10, nodeGap * 0.038);
	}
}

function sectorPreservingLaneIndexes(
	items: { id: string; point: RadialPoint; arcDemand: number; kind: string; parentKey: string }[],
	radius: number,
	nodeGap: number,
): Map<string, number> {
	const laneIndexes = new Map<string, number>();
	const groups = new Map<string, typeof items>();
	for (const item of items) {
		const key = `${item.parentKey}:${item.kind}`;
		const list = groups.get(key);
		if (list) list.push(item);
		else groups.set(key, [item]);
	}
	for (const group of groups.values()) {
		if (group.length <= 5) continue;
		const ordered = group.slice().sort((a, b) => normalizeAngle(a.point.angle) - normalizeAngle(b.point.angle));
		const span = Math.max(0.001, angularSpreadAround(ordered[0]?.point.angle ?? 0, ordered.map((item) => item.point.angle)));
		if (span > Math.PI * 1.45) continue;
		const demand = ordered.reduce((sum, item) => sum + item.arcDemand + Math.max(6, nodeGap * 0.08), 0);
		const capacity = Math.max(nodeGap * 1.85, radius * Math.max(span, 0.14) * 0.66);
		const laneCount = clamp(Math.ceil(demand / Math.max(1, capacity)), 1, 6);
		if (laneCount <= 1) continue;
		for (let index = 0; index < ordered.length; index++) laneIndexes.set(ordered[index]!.id, index % laneCount);
	}
	return laneIndexes;
}

function sectorPreservingKindOffset(kind: string): number {
	if (kind === 'folder') return -0.34;
	if (kind === 'unresolved') return 0.5;
	if (kind === 'external') return 0.62;
	return 0.14;
}

function outerBandLaneGap(spacing: SpacingProfile, laneGap: number, outerBandWeight: number): number {
	const outerWeight = clamp(outerBandWeight, 0, 1);
	return Math.max(
		spacing.ringGap * (1.02 + outerWeight * 0.56),
		laneGap * (1.16 + outerWeight * 0.32),
	);
}

function routeContinuityGap(
	parentPoint: RadialPoint,
	spacing: SpacingProfile,
	nodeGap: number,
	depthRatio: number,
	densityPressure: number,
): number {
	const parentSector = clamp(parentPoint.sectorSpan ?? Math.PI * 2, 0.024, Math.PI * 2);
	const narrowness = clamp((Math.PI * 0.9 - parentSector) / (Math.PI * 0.9), 0, 1);
	const densityReserve = clamp(densityPressure / 2.6, 0, 1) * 0.08;
	const factor = clamp(0.38 + narrowness * 0.24 + clamp(depthRatio, 0, 1) * 0.12 + densityReserve, 0.36, 0.82);
	return spacing.ringGap * factor + Math.max(12, nodeGap * 0.04);
}

function outerBaselineRingDemandRadius(
	items: SectorRingLaneItem[],
	positions: Map<string, RadialPoint>,
	spacing: SpacingProfile,
	nodeGap: number,
	densityPressure: number,
	previousOuterRadius: number,
	laneGap: number,
	isFinalDepth: boolean,
): number {
	if (items.length === 0) return 0;
	const maxVisualRadius = Math.max(...items.map((item) => item.visualRadius), 4);
	const totalDemand = items.reduce((sum, item) => sum + item.arcDemand, 0) + items.length * Math.max(10, nodeGap * 0.18);
	const fullRingUtilization = clamp(
		(isFinalDepth ? 0.48 : 0.52) - densityPressure * 0.035 - Math.min(0.06, items.length / 3600),
		isFinalDepth ? 0.3 : 0.34,
		isFinalDepth ? 0.48 : 0.52,
	);
	let demandRadius = totalDemand / Math.max(1, Math.PI * 2 * fullRingUtilization) + maxVisualRadius * 1.3;
	const groups = new Map<string, SectorRingLaneItem[]>();
	for (const item of items) {
		const group = groups.get(item.parentKey);
		if (group) group.push(item);
		else groups.set(item.parentKey, [item]);
	}
	for (const group of groups.values()) {
		if (group.length <= 1) continue;
		const parentPoint = finalRingParentPoint(group[0]!, positions);
		const parentDepth = Math.max(0, Math.round(parentPoint?.depth ?? 0));
		const parentSectorSpan = clamp(parentPoint?.sectorSpan ?? Math.PI * 2, 0.08, Math.PI * 2);
		const targetSpan = outerBaselineGroupTargetSpan(group.length, parentDepth, parentSectorSpan, isFinalDepth);
		const groupDemand = group.reduce((sum, item) => sum + item.arcDemand, 0) + Math.max(0, group.length - 1) * Math.max(12, nodeGap * 0.22);
		const utilization = clamp(
			(isFinalDepth ? 0.68 : 0.72) - densityPressure * 0.045 - Math.min(0.08, Math.sqrt(group.length) * 0.012),
			isFinalDepth ? 0.42 : 0.46,
			isFinalDepth ? 0.68 : 0.72,
		);
		demandRadius = Math.max(demandRadius, groupDemand / Math.max(1, targetSpan * utilization) + maxVisualRadius * 2.15);
	}
	return Math.max(
		demandRadius,
		previousOuterRadius +
			Math.max(laneGap * (isFinalDepth ? 1.34 : 1.08), spacing.ringGap * (isFinalDepth ? 1.46 : 1.24)) +
			maxVisualRadius * 1.2,
	);
}

function finalRingParentPoint(item: SectorRingLaneItem, positions: Map<string, RadialPoint>): RadialPoint | null {
	if (item.node.parentId !== null && item.node.parentId !== undefined) return positions.get(item.node.parentId) ?? null;
	return positions.get(item.parentKey) ?? null;
}

function outerBaselineGroupTargetSpan(count: number, parentDepth: number, parentSectorSpan: number, isFinalDepth: boolean): number {
	if (parentDepth <= 0) return clamp(parentSectorSpan * 0.96, 0.12, Math.PI * 2);
	const controlledSpan = controlledSiblingMaxSpan(count, parentDepth, parentSectorSpan);
	const countSpan = 0.14 + Math.sqrt(Math.max(1, count)) * 0.22;
	const depthTighten = clamp(1 - Math.max(0, parentDepth - 1) * 0.04, 0.66, 0.96);
	const compactSpan = countSpan * depthTighten;
	const inheritedLimit = parentSectorSpan * (isFinalDepth ? 0.72 : 0.78);
	return clamp(Math.min(controlledSpan, compactSpan, inheritedLimit), 0.08, parentSectorSpan);
}

function sectorPreservingJaggedBand(
	depth: number,
	radius: number,
	spacing: SpacingProfile,
	itemCount: number,
	arcDemand: number,
	densityPressure: number,
): number {
	if (depth <= 0 || !Number.isFinite(radius) || radius <= 0) return 0;
	const maxFactor = adaptiveJaggednessFactor(depth, radius, spacing.ringGap, densityPressure);
	const densityFactor = ringJaggedDepthFactor(depth, radius, spacing.ringGap, itemCount, arcDemand);
	const pressureFactor = clamp(0.94 + clamp(densityPressure, 0, 2.6) * 0.035, 0.94, 1.03);
	const strength = clamp(0.78 + densityFactor * 0.1 + clamp(densityPressure, 0, 2.6) * 0.08, 0.86, 1.04);
	const maxBand = radius * maxFactor;
	return clamp(maxBand * pressureFactor * strength, 0, maxBand);
}

function sectorPreservingCrowdedBaselineRadius(
	targetRadius: number,
	depth: number,
	depthRatio: number,
	densityPressure: number,
	itemCount: number,
	arcDemand: number,
	spacing: SpacingProfile,
	nodeGap: number,
): number {
	if (depth <= 0 || !Number.isFinite(targetRadius) || targetRadius <= 0 || itemCount <= 1) return targetRadius;
	const count = Math.max(1, itemCount);
	const paddingDemand = count * Math.max(8, nodeGap * 0.12);
	const totalDemand = arcDemand + paddingDemand;
	const desiredUtilization = clamp(0.5 - Math.min(0.14, densityPressure * 0.045) - Math.min(0.06, count / 3600), 0.34, 0.5);
	const demandRadius = totalDemand / Math.max(1, Math.PI * 2 * desiredUtilization);
	if (demandRadius <= targetRadius) return targetRadius;
	const pressure = clamp((demandRadius - targetRadius) / Math.max(1, spacing.ringGap), 0, 1);
	const localLift = clamp(0.46 + densityPressure * 0.18 + pressure * 0.14 - clamp(depthRatio, 0, 1) * 0.04, 0.46, 0.88);
	const maxLift = spacing.ringGap * clamp(0.16 + densityPressure * 0.2 + pressure * 0.24, 0.16, 0.72);
	const delta = demandRadius - targetRadius;
	const limitedLift = Math.min(delta, maxLift);
	const overflowLift = Math.max(0, delta - maxLift) * clamp(0.16 + densityPressure * 0.08 + pressure * 0.12, 0.16, 0.42);
	return Math.max(targetRadius, targetRadius + (limitedLift + overflowLift) * localLift);
}

function adaptiveJaggednessFactor(depth: number, radius: number, ringGap: number, densityPressure: number): number {
	if (depth <= 1) return RING_JAGGED_INNER_FACTOR;
	const radiusDepth = Number.isFinite(radius) && ringGap > 0 ? Math.max(0, radius / ringGap - 1) : Math.max(0, depth - 1);
	const radiusRatio = clamp(radiusDepth / 7, 0, 1);
	const densityWeight = clamp(densityPressure / 2.6, 0, 1);
	const outerWeight = Math.max(densityWeight, Math.pow(radiusRatio, 0.92) * 0.48);
	return clamp(
		RING_JAGGED_INNER_FACTOR + (RING_JAGGED_OUTER_FACTOR - RING_JAGGED_INNER_FACTOR) * outerWeight,
		RING_JAGGED_INNER_FACTOR,
		RING_JAGGED_OUTER_FACTOR,
	);
}

function sectorPreservingJitterReserve(radius: number, itemCount: number, arcDemand: number): number {
	const occupancy = Number.isFinite(radius) && radius > 0 ? arcDemand / Math.max(1, Math.PI * 2 * radius) : 0;
	const occupancyPressure = clamp((occupancy - 0.28) / 0.28, 0, 1);
	const countPressure = clamp((Math.sqrt(Math.max(0, itemCount)) - 8) / 10, 0, 1);
	return clamp(0.12 + Math.max(occupancyPressure, countPressure) * 0.74, 0.12, 0.86);
}

function sectorPreservingRadiusForLaneBucket(
	id: string,
	parentKey: string,
	kind: string,
	laneIndex: number,
	laneOffset: number,
	baselineRadius: number,
	laneGap: number,
	jitterBand: number,
	depth: number,
	minRadius: number,
): number {
	const fallbackRadius = Math.max(minRadius, baselineRadius + laneOffset * laneGap);
	if (jitterBand <= 0) return fallbackRadius;
	const compactRing = clamp(laneGap * 1.8 / Math.max(1, baselineRadius), 0, 1);
	const kindBias: Record<string, number> = {
		folder: -0.58 + compactRing * 0.22,
		note: 0.08 + compactRing * 0.02,
		unresolved: 0.55 - compactRing * 0.19,
		external: 0.68 - compactRing * 0.24,
	};
	const direction = kind === 'folder' ? -1 : 1;
	const parentSpread = deterministicUnitOffset(parentKey, `depth-${depth}-parent-radius`) * (0.2 - compactRing * 0.1);
	const nodeSpread = deterministicUnitOffset(id, `depth-${depth}-node-radius`) * (0.32 - compactRing * 0.16);
	const laneSpread = laneIndex * (0.24 - compactRing * 0.12) * direction;
	const offset = clamp((kindBias[kind] ?? 0.08) + laneOffset * 0.28 + laneSpread + parentSpread + nodeSpread, -1, 1);
	const fineLaneOffset = clamp(laneOffset, -1, 1) * Math.min(laneGap * 0.24, jitterBand * 0.12);
	return Math.max(minRadius, baselineRadius + offset * jitterBand + fineLaneOffset);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Alternate lane strategy kept for layout tuning.
function placeParentAlignedRingLanes(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	nodeGap: number,
	ringTargets: Map<number, number>,
	maxDegree: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
): void {
	const idsByDepth = new Map<number, string[]>();
	for (const [id, point] of positions.entries()) {
		const node = graph.nodesById.get(id);
		if (!node) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		if (depth === 0) {
			point.x = 0;
			point.y = 0;
			point.radius = 0;
			point.ringRadius = 0;
			point.angle = -Math.PI / 2;
			continue;
		}
		const list = idsByDepth.get(depth) ?? [];
		list.push(id);
		idsByDepth.set(depth, list);
	}

	let previousOuterRadius = 0;
	const depths = [...idsByDepth.keys()].sort((a, b) => a - b);
	const maxDepth = Math.max(...depths, 1);
	for (const depth of depths) {
		const items = buildDepthRingItems(idsByDepth.get(depth) ?? [], positions, graph, nodeGap, maxDegree, spacing.incidentPressureByNode, childrenByParent, metrics);
		if (items.length === 0) continue;
		const maxVisualRadius = Math.max(...items.map((item) => item.visualRadius), 4);
		const targetRadius = ringTargets.get(depth) ?? spacing.ringGap * depth;
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const laneGap = Math.max(
			maxVisualRadius * (2.05 + depthRatio * 0.36) + Math.max(14, nodeGap * (0.12 + depthRatio * 0.028)),
			spacing.ringGap * (0.064 + depthRatio * 0.024),
		);
		const baselineRadius = Math.max(targetRadius, previousOuterRadius + laneGap * 0.52);
		ringTargets.set(depth, baselineRadius);
		const groups = buildParentRingGroups(items, baselineRadius, nodeGap);
		assignParentRingSectors(groups, baselineRadius, nodeGap);

		let depthOuterRadius = baselineRadius;
		for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
			const group = groups[groupIndex];
			if (!group) continue;
			depthOuterRadius = Math.max(
				depthOuterRadius,
				placeAlignedGroupItems(group, groupIndex, baselineRadius, laneGap, spacing, nodeGap),
			);
		}
		previousOuterRadius = depthOuterRadius + maxVisualRadius * 0.98 + Math.max(12, nodeGap * 0.07);
	}
}

function buildDepthRingItems(
	ids: string[],
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	nodeGap: number,
	maxDegree: number,
	incidentPressureByNode: Map<string, number>,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
): RingItem[] {
	const items: RingItem[] = [];
	for (const id of ids) {
		const point = positions.get(id);
		const node = graph.nodesById.get(id);
		if (!point || !node) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		const visualRadius = nodeRadius(node, maxDegree, incidentPressureByNode.get(id) ?? 0);
		const labelDemand = labelCollisionPadding(node) + labelArcPadding(node) * clamp(0.56 + Math.min(1, depth / 5) * 0.44, 0.56, 1);
		const arcDemand = visualRadius * 2.9 + labelDemand * 2.85 + Math.max(26, nodeGap * 0.26);
		const currentAngle = normalizeAngle(Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x));
		const parentPoint = node.parentId !== null && node.parentId !== undefined ? positions.get(node.parentId) : null;
		const parentDepth = parentPoint ? Math.max(0, Math.round(parentPoint.depth || 0)) : -1;
		const parentAngle = parentPoint && Number.isFinite(parentPoint.angle) ? normalizeAngle(parentPoint.angle) : currentAngle;
		const parentIsRoot = Boolean(parentPoint && parentDepth <= 0);
		const parentId = node.parentId ?? null;
		const preferred = parentPoint && parentDepth > 0 ? blendAngles(currentAngle, parentAngle, 0.16) : currentAngle;
		const parentSectorSpan = clamp(parentPoint?.sectorSpan ?? Math.PI * 2, 0.024, Math.PI * 2);
		const sectorSpan = clamp(point.sectorSpan ?? 0, 0, Math.PI * 2);
		const fanWeight = subtreeFanWeight(id, depth, childrenByParent, metrics);
		items.push({ id, node, point, depth, parentId, parentAngle, visualRadius, arcDemand, preferred, parentSectorSpan, sectorSpan, fanWeight, parentIsRoot });
	}
	return items;
}

function buildParentRingGroups(items: RingItem[], radius: number, nodeGap: number): ParentRingGroup[] {
	const groupsByParent = new Map<string, RingItem[]>();
	for (const item of items) {
		const key = item.parentId ?? item.id;
		const list = groupsByParent.get(key);
		if (list) list.push(item);
		else groupsByParent.set(key, [item]);
	}

	const groups: ParentRingGroup[] = [];
	for (const [parentId, groupItems] of groupsByParent.entries()) {
		const rawParentAngle = averageAngles(groupItems.map((item) => item.parentAngle), groupItems[0]?.parentAngle ?? 0);
		const preferredFanCenter = averageAngles(groupItems.map((item) => item.preferred), rawParentAngle);
		const rootLevelSpread = isRootLevelSpreadGroup(groupItems);
		const parentAngle = rootLevelSpread ? preferredFanCenter : rawParentAngle;
		const preferred = rootLevelSpread ? preferredFanCenter : blendAngles(preferredFanCenter, parentAngle, 0.68);
		const sectorSpan = rootLevelSpread ? Math.PI * 2 : clamp(groupItems[0]?.parentSectorSpan ?? Math.PI * 0.86, 0.024, Math.PI * 2);
		const arcDemand = groupItems.reduce((sum, item) => sum + item.arcDemand, 0);
		const fanWeight = groupItems.reduce((sum, item) => sum + Math.max(1, item.fanWeight || 1), 0);
		const group: ParentRingGroup = {
			parentId,
			parentAngle,
			preferred,
			arcDemand,
			fanWeight,
			span: estimateParentGroupSpan(groupItems, radius, nodeGap, parentAngle, sectorSpan),
			center: preferred,
			sectorSpan,
			items: groupItems.slice().sort((a, b) => compareLayoutNode(a.node, b.node)),
		};
		groups.push(group);
	}
	return rotateGroupsByLargestGap(groups.sort((a, b) => normalizeAngle(a.preferred) - normalizeAngle(b.preferred)));
}

function estimateParentGroupSpan(items: RingItem[], radius: number, nodeGap: number, parentAngle: number, availableSpan: number): number {
	const totalDemand = items.reduce((sum, item) => sum + item.arcDemand, 0);
	const itemGap = Math.max(0, items.length - 1) * Math.max(8, nodeGap * 0.18);
	const rawSpan = (totalDemand + itemGap) / Math.max(1, radius);
	const inheritedSpread = angularSpreadAround(parentAngle, items.map((item) => item.preferred));
	const minSpan = items.length <= 1 ? 0.045 : items.length <= 4 ? 0.12 : 0.18;
	return clamp(Math.max(rawSpan * 1.08, inheritedSpread * 1.14), minSpan, maxParentAlignedSpan(items, availableSpan));
}

function rotateGroupsByLargestGap(groups: ParentRingGroup[]): ParentRingGroup[] {
	if (groups.length <= 2) return groups;
	let largestGap = -1;
	let largestGapIndex = 0;
	for (let index = 0; index < groups.length; index++) {
		const current = normalizeAngle(groups[index]?.preferred ?? 0);
		const next = normalizeAngle(groups[(index + 1) % groups.length]?.preferred ?? 0) + (index === groups.length - 1 ? Math.PI * 2 : 0);
		const gap = next - current;
		if (gap > largestGap) {
			largestGap = gap;
			largestGapIndex = index;
		}
	}
	const start = (largestGapIndex + 1) % groups.length;
	return groups.slice(start).concat(groups.slice(0, start));
}

function assignParentRingSectors(groups: ParentRingGroup[], radius: number, nodeGap: number): void {
	if (groups.length === 0) return;
	const fullCircle = Math.PI * 2;
	const gap = groups.length > 1 ? clamp(nodeGap / Math.max(1, radius) * 0.34, 0.012, 0.07) : 0;
	if (groups.length === 1) {
		const group = groups[0]!;
		const anchor = parentRingGroupAnchor(group);
		const inheritedSpread = angularSpreadAround(anchor, group.items.map((item) => item.preferred));
		const densitySpan = group.span * clamp(Math.sqrt(group.items.length || 1), 1, 1.18);
		const subtreeUse = group.sectorSpan * (isRootLevelSpreadGroup(group.items) ? 0.995 : sectorUseForGroup(group.items));
		group.span = clamp(Math.max(group.span, densitySpan, inheritedSpread * 1.16, subtreeUse), 0.08, maxSingleParentAlignedSpan(group.items, group.sectorSpan));
		group.center = normalizeAngle(anchor);
		return;
	}
	assignParentAnchoredRingSectors(groups, gap, fullCircle);
}

function placeAlignedGroupItems(
	group: ParentRingGroup,
	groupIndex: number,
	baselineRadius: number,
	laneGap: number,
	spacing: SpacingProfile,
	nodeGap: number,
): number {
	const sectorStart = group.center - group.span / 2;
	const sectorEnd = group.center + group.span / 2;
	const placements = fanGroupItemAngles(group.items, group.center, sectorStart, sectorEnd, baselineRadius, nodeGap);
	const rootLevelSpread = isRootLevelSpreadGroup(group.items);
	const laneIndexes = rootLevelSpread ? new Map<string, number>() : assignFanLaneIndexes(placements, baselineRadius, group.span, nodeGap);
	const parentOffsets = [0, -0.22, 0.22, -0.38, 0.38, -0.1, 0.1];
	const parentOffset = rootLevelSpread ? 0 : (parentOffsets[groupIndex % parentOffsets.length] ?? 0);
	let outerRadius = baselineRadius;
	for (const placement of placements) {
		const kind = nodeKindKey(placement.item.node);
		const laneIndex = laneIndexes.get(placement.item.id) ?? 0;
		const radius = radiusForLaneBucket(kind, laneIndex, parentOffset, baselineRadius, laneGap, spacing);
		outerRadius = Math.max(outerRadius, radius);
		setAlignedPoint(placement.item, radius, placement.angle, placement.sectorStart, placement.sectorEnd);
	}
	return outerRadius;
}

function fanGroupItemAngles(
	items: RingItem[],
	center: number,
	sectorStart: number,
	sectorEnd: number,
	radius: number,
	nodeGap: number,
): FanPlacement[] {
	if (!items.length) return [];
	const span = Math.max(0.018, sectorEnd - sectorStart);
	const pad = Math.min(span * 0.1, clamp(nodeGap / Math.max(1, radius) * 0.28, 0.008, 0.07));
	const start = sectorStart + pad;
	const end = sectorEnd - pad;
	const available = Math.max(0.012, end - start);
	const ordered = orderGroupItemsForFan(items, center);
	if (ordered.length === 1) return [{ item: ordered[0]!, angle: normalizeAngle(center), sectorStart, sectorEnd }];

	const visualWidths = ordered.map((item) => Math.max(0.004, item.arcDemand / Math.max(1, radius)));
	const fanWeights = ordered.map((item, index) =>
		Math.max(
			visualWidths[index] ?? 0.004,
			item.sectorSpan > 0 ? item.sectorSpan : 0,
			Math.pow(Math.max(1, item.fanWeight || 1), 1.12),
		),
	);
	const visualDemand = visualWidths.reduce((sum, width) => sum + width, 0);
	const minGap = clamp(nodeGap / Math.max(1, radius) * 0.16, 0.006, 0.04);
	const gapTotal = minGap * Math.max(0, ordered.length - 1);
	const availableForItems = Math.max(0.012, available - gapTotal);
	if (visualDemand <= availableForItems) {
		const totalFanWeight = Math.max(1, fanWeights.reduce((sum, width) => sum + width, 0));
		const extra = Math.max(0, availableForItems - visualDemand);
		const placements: FanPlacement[] = [];
		let cursor = start;
		for (let index = 0; index < ordered.length; index++) {
			const width = (visualWidths[index] ?? 0.004) + extra * ((fanWeights[index] ?? 1) / totalFanWeight);
			const slotStart = cursor;
			const slotEnd = cursor + width;
			placements.push({
				item: ordered[index]!,
				angle: normalizeAngle(cursor + width / 2),
				sectorStart: index === 0 ? sectorStart : Math.max(sectorStart, slotStart - minGap / 2),
				sectorEnd: index === ordered.length - 1 ? sectorEnd : Math.min(sectorEnd, slotEnd + minGap / 2),
			});
			cursor += width + minGap;
		}
		return placements;
	}

	return assignPlacementSectors(
		ordered.map((item, index) => ({
			item,
			angle: start + (available * (index + 0.5)) / ordered.length,
		})),
		sectorStart,
		sectorEnd,
	);
}

function assignPlacementSectors(
	placements: { item: RingItem; angle: number }[],
	sectorStart: number,
	sectorEnd: number,
): FanPlacement[] {
	if (!placements.length) return [];
	const ordered = placements.slice().sort((a, b) => a.angle - b.angle);
	return ordered.map((placement, index) => {
		const previousAngle = ordered[index - 1]?.angle;
		const nextAngle = ordered[index + 1]?.angle;
		const start = index === 0 || !Number.isFinite(previousAngle) ? sectorStart : ((previousAngle as number) + placement.angle) / 2;
		const end = index === ordered.length - 1 || !Number.isFinite(nextAngle) ? sectorEnd : (placement.angle + (nextAngle as number)) / 2;
		return {
			item: placement.item,
			angle: normalizeAngle(placement.angle),
			sectorStart: Math.max(sectorStart, Math.min(start, sectorEnd)),
			sectorEnd: Math.max(sectorStart, Math.min(end, sectorEnd)),
		};
	});
}

function orderGroupItemsForFan(items: RingItem[], center: number): RingItem[] {
	return items.slice().sort((a, b) => {
		const aSectorStart = Number.isFinite(a.point.sectorStart) ? a.point.sectorStart! : a.preferred;
		const bSectorStart = Number.isFinite(b.point.sectorStart) ? b.point.sectorStart! : b.preferred;
		const sectorOrder = aSectorStart - bSectorStart;
		if (Math.abs(sectorOrder) > 0.0001) return sectorOrder;
		const angleOrder = shortestAngleDelta(center, a.preferred) - shortestAngleDelta(center, b.preferred);
		return angleOrder || compareLayoutNode(a.node, b.node);
	});
}

function assignFanLaneIndexes(
	placements: { item: RingItem; angle: number }[],
	radius: number,
	sectorSpan: number,
	nodeGap: number,
): Map<string, number> {
	const laneIndexes = new Map<string, number>();
	const byKind = new Map<string, { item: RingItem; angle: number }[]>();
	for (const placement of placements) {
		const kind = nodeKindKey(placement.item.node);
		const list = byKind.get(kind);
		if (list) list.push(placement);
		else byKind.set(kind, [placement]);
	}
	for (const kindPlacements of byKind.values()) {
		const laneCapacity = Math.max(nodeGap * 2.2, radius * Math.max(0.18, sectorSpan * 0.82));
		let laneIndex = 0;
		let laneDemand = 0;
		for (const placement of kindPlacements) {
			const itemDemand = placement.item.arcDemand + Math.max(8, nodeGap * 0.14);
			if (laneDemand > 0 && laneDemand + itemDemand > laneCapacity) {
				laneIndex++;
				laneDemand = 0;
			}
			laneIndexes.set(placement.item.id, laneIndex);
			laneDemand += itemDemand;
		}
	}
	return laneIndexes;
}

function maxParentAlignedSpan(items: RingItem[], availableSpan = Math.PI * 0.86): number {
	if (isRootLevelSpreadGroup(items)) return Math.PI * 2;
	const count = Math.max(1, items.length);
	const base = count <= 1 ? 0.42 : count <= 4 ? 0.86 : 1.02;
	const densityLift = Math.log2(count) * 0.22;
	const inheritedMax = clamp(availableSpan * 0.98, Math.PI * 0.86, Math.PI * 2);
	const sectorDemand = availableSpan * sectorUseForGroup(items);
	return clamp(Math.max(base + densityLift, sectorDemand), base, inheritedMax);
}

function maxSingleParentAlignedSpan(items: RingItem[], availableSpan = Math.PI * 2): number {
	if (isRootLevelSpreadGroup(items)) return Math.PI * 2;
	const count = Math.max(1, items.length);
	if (availableSpan > Math.PI * 1.16 && count > 3) return Math.min(Math.PI * 2, availableSpan * 0.98);
	const extra = count > 48 ? 1.38 : count > 18 ? 1.22 : count > 8 ? 1.12 : 1.04;
	return clamp(maxParentAlignedSpan(items, availableSpan) * extra, 0.46, Math.min(Math.PI * 2, availableSpan * 0.98));
}

function angularSpreadAround(center: number, angles: number[]): number {
	if (!angles.length) return 0;
	let min = Infinity;
	let max = -Infinity;
	for (const angle of angles) {
		const delta = shortestAngleDelta(center, angle);
		min = Math.min(min, delta);
		max = Math.max(max, delta);
	}
	if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
	return Math.max(0, max - min);
}

function assignParentAnchoredRingSectors(groups: ParentRingGroup[], gap: number, fullCircle: number): void {
	const ordered = orderParentRingSectorEntries(groups, fullCircle);
	const usableCircle = Math.max(0.12, fullCircle - gap * groups.length);
	const totalWeight = Math.max(1, ordered.reduce((sum, entry) => sum + entry.weight, 0));
	for (const entry of ordered) {
		if (entry.parentAnchored) continue;
		const fairSpan = usableCircle * (entry.weight / totalWeight);
		entry.desiredSpan = clamp(Math.max(entry.desiredSpan, fairSpan * 0.92), entry.minSpan, entry.maxSpan);
	}

	const desiredTotal = ordered.reduce((sum, entry) => sum + entry.desiredSpan, 0);
	if (desiredTotal > usableCircle) {
		const minTotal = ordered.reduce((sum, entry) => sum + entry.minSpan, 0);
		const shrinkable = Math.max(0.001, desiredTotal - minTotal);
		const budget = Math.max(minTotal, usableCircle);
		for (const entry of ordered) {
			const extra = Math.max(0, entry.desiredSpan - entry.minSpan);
			entry.group.span = entry.minSpan + extra * ((budget - minTotal) / shrinkable);
		}
	} else {
		for (const entry of ordered) entry.group.span = entry.desiredSpan;
		let spare = usableCircle - desiredTotal;
		for (let pass = 0; pass < 3 && spare > 0.001; pass++) {
			const expandable = ordered.filter((entry) => !entry.parentAnchored && entry.group.span < entry.maxSpan - 0.001);
			if (!expandable.length) break;
			const expandableWeight = Math.max(1, expandable.reduce((sum, entry) => sum + entry.weight, 0));
			let spent = 0;
			for (const entry of expandable) {
				const add = Math.min(entry.maxSpan - entry.group.span, spare * (entry.weight / expandableWeight));
				entry.group.span += add;
				spent += add;
			}
			spare -= spent;
			if (spent <= 0.001) break;
		}
	}

	const allocatedTotal = ordered.reduce((sum, entry) => sum + entry.group.span, 0);
	const distributedGap = Math.max(gap, (fullCircle - allocatedTotal) / groups.length);
	const relativeCenters: number[] = [];
	let cursor = distributedGap / 2;
	for (const entry of ordered) {
		cursor += entry.group.span / 2;
		relativeCenters.push(cursor);
		cursor += entry.group.span / 2 + distributedGap;
	}
	const anchors = unwrapAngles(ordered.map((entry) => entry.anchor), fullCircle);
	const offset = weightedAverage(
		ordered.map((entry, index) => (anchors[index] ?? entry.anchor) - (relativeCenters[index] ?? 0)),
		ordered.map((entry) => entry.weight),
	);
	for (let index = 0; index < ordered.length; index++) {
		const entry = ordered[index];
		if (!entry) continue;
		const allocatedCenter = normalizeAngle(offset + (relativeCenters[index] ?? 0));
		entry.group.center = entry.anchorPull > 0 ? blendAngles(allocatedCenter, entry.anchor, entry.anchorPull) : allocatedCenter;
	}
}

function orderParentRingSectorEntries(groups: ParentRingGroup[], fullCircle: number): ParentRingSectorEntry[] {
	const sorted = groups
		.map((group) => ({ group, anchor: normalizeAngle(parentRingGroupAnchor(group)) }))
		.sort((a, b) => a.anchor - b.anchor);
	if (sorted.length > 2) {
		let largestGap = -1;
		let largestGapIndex = 0;
		for (let index = 0; index < sorted.length; index++) {
			const current = sorted[index]?.anchor ?? 0;
			const next = (sorted[(index + 1) % sorted.length]?.anchor ?? 0) + (index === sorted.length - 1 ? fullCircle : 0);
			const angleGap = next - current;
			if (angleGap > largestGap) {
				largestGap = angleGap;
				largestGapIndex = index;
			}
		}
		const start = (largestGapIndex + 1) % sorted.length;
		sorted.splice(0, sorted.length, ...sorted.slice(start).concat(sorted.slice(0, start)));
	}
	const totalFanWeight = Math.max(1, sorted.reduce((sum, entry) => sum + Math.max(1, entry.group.fanWeight || 1), 0));
	return sorted.map((entry) => {
		const group = entry.group;
		const inheritedSpread = angularSpreadAround(entry.anchor, group.items.map((item) => item.preferred));
		const count = Math.max(1, group.items.length);
		const parentAnchored = shouldKeepGroupParentAnchored(group);
		const minSpan = count <= 1 ? 0.045 : count <= 4 ? 0.1 : 0.15;
		const weight = parentAnchored ? Math.max(0.08, group.arcDemand / 620) : Math.max(1, group.fanWeight || 1, group.arcDemand / 140);
		const fairSpan = fullCircle * (Math.max(1, group.fanWeight || 1) / totalFanWeight);
		const carriedSpan = Math.max(group.sectorSpan, fairSpan * 1.42, group.span * 1.24);
		const compactMaxSpan = compactLocalGroupMaxSpan(group);
		const fairUse = Number.isFinite(compactMaxSpan) ? 0.54 : 0.86;
		const desiredSpan = parentAnchored ? Math.max(group.span, inheritedSpread * 1.02, minSpan) : Math.max(
			group.span * (count > 8 ? 1.1 : 1.04),
			inheritedSpread * 1.12,
			fairSpan * fairUse,
			group.sectorSpan * sectorUseForGroup(group.items),
		);
		const broadMaxSpan = clamp(
			Math.max(maxSingleParentAlignedSpan(group.items, carriedSpan), fairSpan * 1.52, group.span * 1.36),
			minSpan,
			sorted.length <= 2 ? fullCircle * 0.985 : fullCircle * 0.92,
		);
		const maxSpan = parentAnchored
			? clamp(Math.max(minSpan, group.span * 1.08, inheritedSpread * 1.08), minSpan, Math.PI * 0.42)
			: Math.min(broadMaxSpan, compactMaxSpan);
		return {
			group,
			anchor: entry.anchor,
			minSpan: Math.min(minSpan, maxSpan),
			desiredSpan: clamp(desiredSpan, Math.min(minSpan, maxSpan), maxSpan),
			maxSpan,
			weight,
			parentAnchored,
			anchorPull: parentAnchored ? 1 : Number.isFinite(compactMaxSpan) ? 0.82 : 0,
		};
	});
}

function compactLocalGroupMaxSpan(group: ParentRingGroup): number {
	const count = group.items.length;
	if (count <= 1 || count > 8) return Infinity;
	const maxItemFan = Math.max(...group.items.map((item) => Math.max(1, item.fanWeight || 1)));
	const averageFan = group.fanWeight / Math.max(1, count);
	if (maxItemFan > 7.2 || averageFan > 5.8) return Infinity;
	if (count <= 3) return Math.PI * 0.46;
	if (count <= 4) return Math.PI * 0.54;
	return Math.PI * 0.68;
}

function shouldKeepGroupParentAnchored(group: ParentRingGroup): boolean {
	if (group.items.length !== 1) return false;
	const item = group.items[0];
	if (!item) return false;
	if (item.fanWeight > 2.35) return false;
	if ((item.sectorSpan ?? 0) > Math.PI * 0.44) return false;
	return true;
}

function sectorUseForGroup(items: RingItem[]): number {
	const count = Math.max(1, items.length);
	if (isRootLevelSpreadGroup(items)) return count <= 1 ? 0.08 : 0.92;
	if (count <= 1) {
		const fanWeight = Math.max(1, items[0]?.fanWeight ?? 1);
		if (fanWeight > 12) return 0.96;
		if (fanWeight > 5) return 0.82;
		if (fanWeight > 2.4) return 0.52;
		return 0.16;
	}
	if (count <= 2) return 0.82;
	if (count <= 4) return 0.9;
	return 0.96;
}

function parentRingGroupAnchor(group: ParentRingGroup): number {
	return isRootLevelSpreadGroup(group.items) ? group.preferred : group.parentAngle;
}

function unwrapAngles(angles: number[], fullCircle: number): number[] {
	if (!angles.length) return [];
	const unwrapped = [normalizeAngle(angles[0] ?? 0)];
	for (let index = 1; index < angles.length; index++) {
		let angle = normalizeAngle(angles[index] ?? 0);
		while (angle < (unwrapped[index - 1] ?? 0)) angle += fullCircle;
		unwrapped.push(angle);
	}
	return unwrapped;
}

function isRootLevelSpreadGroup(items: RingItem[]): boolean {
	const maxDepth = Math.max(...items.map((item) => item.depth), 1);
	return maxDepth <= 1 && items.every((item) => item.parentIsRoot);
}

function radiusForLaneBucket(
	kind: string,
	laneIndex: number,
	parentOffset: number,
	baselineRadius: number,
	laneGap: number,
	spacing: SpacingProfile,
): number {
	const kindOffsets: Record<string, number> = {
		folder: -0.34,
		note: 0.08,
		unresolved: 0.42,
		external: 0.58,
	};
	const kindOffset = kindOffsets[kind] ?? 0.12;
	const direction = kind === 'folder' ? -1 : 1;
	const laneOffset = kindOffset + parentOffset * 0.72 + laneIndex * 0.54 * direction;
	const minRadius = Math.max(1, baselineRadius - spacing.ringGap * 0.22);
	return Math.max(minRadius, baselineRadius + laneOffset * laneGap);
}

function setAlignedPoint(item: RingItem, radius: number, angle: number, sectorStart?: number, sectorEnd?: number): void {
	const normalized = normalizeAngle(angle);
	const point = item.point;
	point.x = Math.cos(normalized) * radius;
	point.y = Math.sin(normalized) * radius;
	point.radius = radius;
	point.ringRadius = radius;
	point.ringBandMin = radius;
	point.ringBandMax = radius;
	point.angle = normalized;
	if (Number.isFinite(sectorStart) && Number.isFinite(sectorEnd) && (sectorEnd as number) > (sectorStart as number)) {
		setPointSector(point, sectorStart as number, sectorEnd as number);
	} else if (point.sectorSpan && point.sectorSpan > 0) {
		const span = clamp(point.sectorSpan, 0.024, Math.PI * 2);
		setPointSector(point, normalized - span / 2, normalized + span / 2);
	}
}

function nodeKindKey(node: WorldNode): string {
	if (node.type === 'external' || node.externalProxy) return 'external';
	if (node.type === 'unresolved') return 'unresolved';
	if (node.type === 'folder') return 'folder';
	return 'note';
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
	const ringFactor = clamp(0.84 + pressureRoot * 0.24 + Math.min(0.24, averagePressure * 0.032), 0.72, 1.72);
	const fanFactor = clamp(0.62 + pressureRoot * 0.24 + Math.min(0.3, overlayDensity * 0.17), 0.62, 1.35);
	const routeGapFactor = clamp(0.9 + pressureRoot * 0.38 + Math.min(0.42, overlayDensity * 0.2), 0.9, 2.55);
	const countExpansion = Math.max(0, Math.log2(density.normalCount / 520)) * 0.035;
	const ringExpansion = Math.max(0, Math.sqrt(density.maxRingCount / 96) - 1) * 0.16;
	const averageRingExpansion = Math.max(0, Math.sqrt(density.averageRingCount / 64) - 1) * 0.1;
	const pressureExpansion = Math.max(0, pressureRoot - 0.75) * 0.028;
	return {
		baseRingGap,
		baseNodeGap,
		ringGap: clamp(baseRingGap * ringFactor, MIN_RING_SPACING, 3400),
		nodeGap: clamp(baseNodeGap * nodeFactor, 86, 860),
		branchFanSpan: Math.PI * fanFactor,
		routeGapFactor,
		radiusExpansion: clamp(1 + countExpansion * 0.72 + ringExpansion * 0.68 + averageRingExpansion * 0.64 + pressureExpansion, 1, 1.36),
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
	const ringCounts = [...spacing.ringCountsByDepth.values()].filter((count) => count > 0);
	const averageRingCount = ringCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, ringCounts.length);
	const maxRingCount = Math.max(1, ...ringCounts);
	const scaleForDepth = (depth: number) => {
		if (depth <= 0) return 1;
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const ringCount = spacing.ringCountsByDepth.get(Math.round(depth)) ?? 0;
		const density = ringCountDensity(ringCount, averageRingCount, maxRingCount);
		const localWeight = clamp(density.pressure * 0.62 + density.maxPressure * 0.44, 0, 1.35);
		const adaptiveGrowth = (expansion - 1) * (0.08 + localWeight * 0.86 + depthRatio * 0.08);
		const crowdedBoost = Math.max(0, density.pressure - 1) * 0.1 + Math.max(0, density.maxPressure - 0.72) * 0.06;
		return clamp(1 + adaptiveGrowth + crowdedBoost, 1, 1.68);
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

function applyMiddleRingRadiusRelief(
	positions: Map<string, RadialPoint>,
	ringTargets: Map<number, number>,
): void {
	const depths = [...ringTargets.keys()].filter((depth) => depth > 0).sort((a, b) => a - b);
	if (depths.length === 0) return;
	const countsByDepth = new Map<number, number>();
	for (const point of positions.values()) {
		if (point.external || point.radius <= 0.001) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		if (depth <= 0) continue;
		countsByDepth.set(depth, (countsByDepth.get(depth) ?? 0) + 1);
	}
	const totalCount = [...countsByDepth.values()].reduce((sum, count) => sum + count, 0);
	const maxCount = Math.max(1, ...countsByDepth.values());
	const averageCount = totalCount / Math.max(1, countsByDepth.size);
	const globalScale = clamp(
		1 +
			Math.max(0, Math.log2(Math.max(1, totalCount) / 420)) * 0.032 +
			Math.max(0, Math.sqrt(maxCount / 72) - 1) * 0.07 +
			Math.max(0, Math.sqrt(averageCount / 48) - 1) * 0.045,
		1,
		1.28,
	);
	const maxDepth = Math.max(...depths, 1);
	const scaleForDepth = (depth: number) => {
		const count = countsByDepth.get(depth) ?? 0;
		const density = ringCountDensity(count, averageCount, maxCount);
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const middleWeight = Math.sin(Math.PI * clamp(depthRatio, 0, 1));
		const innerWeight = clamp(1 - depthRatio * 0.68, 0.28, 1);
		const crowdWeight = clamp(density.pressure * 0.54 + density.maxPressure * 0.62, 0, 1.5);
		const relief = (globalScale - 1) * (0.28 + middleWeight * 0.62 + innerWeight * 0.36) * crowdWeight;
		const sparseCarry = count > 0 && density.relativeToAverage < 0.55 ? (globalScale - 1) * 0.24 : 0;
		return clamp(globalScale + relief + sparseCarry, 1, 1.46);
	};
	if (globalScale <= 1.001 && depths.every((depth) => scaleForDepth(depth) <= 1.001)) return;
	for (const [depth, radius] of [...ringTargets.entries()]) {
		if (depth <= 0) continue;
		ringTargets.set(depth, radius * scaleForDepth(depth));
	}
	for (const point of positions.values()) {
		if (point.external || point.radius <= 0.001) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		const scale = scaleForDepth(depth);
		if (scale <= 1.001) continue;
		const angle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
		point.radius *= scale;
		point.x = Math.cos(angle) * point.radius;
		point.y = Math.sin(angle) * point.radius;
		point.angle = normalizeAngle(angle);
		if (Number.isFinite(point.ringRadius)) point.ringRadius = point.ringRadius! * scale;
		if (Number.isFinite(point.ringBandMin)) point.ringBandMin = point.ringBandMin! * scale;
		if (Number.isFinite(point.ringBandMax)) point.ringBandMax = point.ringBandMax! * scale;
	}
}

function enforceDepthBaselineProgression(
	positions: Map<string, RadialPoint>,
	ringTargets: Map<number, number>,
	spacing: SpacingProfile,
): void {
	const depths = [...ringTargets.keys()].filter((depth) => depth > 0).sort((a, b) => a - b);
	const outerDepth = depths[depths.length - 1] ?? 0;
	const outerBaselineStartDepth = depths[Math.max(0, depths.length - 2)] ?? outerDepth;
	let previousRadius = 0;
	let previousGap = spacing.ringGap;
	for (const depth of depths) {
		const currentRadius = ringTargets.get(depth) ?? 0;
		const isOuterDepth = depth === outerDepth;
		const outerBandWeight = isOuterDepth ? 1 : depth >= outerBaselineStartDepth ? 0.65 : 0;
		const carriedGap = baselineProgressionGap(previousGap, spacing, outerBandWeight);
		const requiredRadius = previousRadius + Math.max(spacing.ringGap * (0.88 + outerBandWeight * 0.1), carriedGap);
		const delta = requiredRadius > currentRadius ? requiredRadius - currentRadius : 0;
		const nextRadius = currentRadius + delta;
		if (delta > 0) {
			ringTargets.set(depth, nextRadius);
			for (const point of positions.values()) {
				if (Math.max(0, Math.round(point.depth || 0)) !== depth || point.radius <= 0.001) continue;
				point.radius += delta;
				if (Number.isFinite(point.ringRadius)) point.ringRadius = point.ringRadius! + delta;
				if (Number.isFinite(point.ringBandMin)) point.ringBandMin = point.ringBandMin! + delta;
				if (Number.isFinite(point.ringBandMax)) point.ringBandMax = point.ringBandMax! + delta;
				const angle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
				point.x = Math.cos(angle) * point.radius;
				point.y = Math.sin(angle) * point.radius;
				point.angle = normalizeAngle(angle);
			}
		}
		previousGap = nextRadius - previousRadius;
		previousRadius = nextRadius;
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

function setPointSector(point: RadialPoint, start: number, end: number): void {
	const span = clamp(Math.max(0, end - start), 0.024, Math.PI * 2);
	const center = start + span / 2;
	point.sectorStart = center - span / 2;
	point.sectorEnd = center + span / 2;
	point.sectorSpan = span;
}

function nodeRadius(node: WorldNode | undefined, maxDegree: number, incidentPressure = 0): number {
	if (!node) return 3.6;
	const storedDegree = Math.max(0, (node.linkCount || 0) + (node.backlinkCount || 0));
	const pressureDegree = Math.max(0, incidentPressure * 0.62);
	const degree = Math.max(storedDegree, pressureDegree);
	const degreeScale = Math.max(1, maxDegree || 1, degree);
	const degreeRatio = Math.log1p(degree) / Math.max(1, Math.log1p(degreeScale));
	const clampedRatio = clamp(degreeRatio, 0, 1);
	const degreeCurve = degree > 0 ? Math.pow(clampedRatio, 0.58) : 0;
	const hubCurve = Math.pow(clampedRatio, 1.82);
	const degreeBoost = degreeCurve * 22 + hubCurve * 30 + Math.log2(degree + 1) * 2.15 + Math.sqrt(degree) * 0.42;
	if (node.externalProxy) return node.type === 'unresolved' ? Math.min(17, 4.5 + degreeBoost * 0.42) : Math.min(30, 4.8 + degreeBoost * 0.58);
	if (node.type === 'folder') {
		const noteSignal = Math.log2((node.noteCount || node.descendantCount || 1) + 1);
		const contextBoost = Math.min(5.8, noteSignal * 0.54);
		return Math.min(64, 5.8 + contextBoost + degreeBoost * 0.94);
	}
	if (node.type === 'external') {
		const noteSignal = Math.log2((node.noteCount || 1) + 1);
		const contextBoost = Math.min(4.2, noteSignal * 0.42);
		return Math.min(42, 4.8 + contextBoost + degreeBoost * 0.82);
	}
	if (node.type === 'unresolved') return Math.min(17, 3.8 + degreeBoost * 0.48);
	return Math.min(62, 3.4 + degreeBoost * 1.02);
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
	const jitterBand = clamp(options.jitterBand, 0, Math.max(0, radius * RING_JAGGED_OUTER_FACTOR));
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

function enforceOuterHierarchyContinuity(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
): void {
	const depths = [...new Set([...positions.values()]
		.filter((point) => !point.external && point.radius > 0.001)
		.map((point) => Math.max(0, Math.round(point.depth || 0)))
		.filter((depth) => depth > 0))]
		.sort((a, b) => a - b);
	if (depths.length === 0) return;
	const maxDepth = depths[depths.length - 1] ?? 0;
	const outerStartDepth = depths[Math.max(0, depths.length - 2)] ?? maxDepth;
	enforceLocalOuterHierarchyContinuity(positions, graph, spacing, outerStartDepth, maxDepth);
}

function enforceLocalOuterHierarchyContinuity(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	outerStartDepth: number,
	maxDepth: number,
): void {
	const childrenByParent = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (!positions.has(edge.source) || !positions.has(edge.target)) continue;
		const children = childrenByParent.get(edge.source);
		if (children) children.push(edge.target);
		else childrenByParent.set(edge.source, [edge.target]);
	}
	const orderedEdges = graph.hierarchyEdges
		.filter((edge) => positions.has(edge.source) && positions.has(edge.target))
		.sort((a, b) => (positions.get(a.source)?.depth ?? 0) - (positions.get(b.source)?.depth ?? 0));
	for (let pass = 0; pass < 2; pass++) {
		let moved = false;
		for (const edge of orderedEdges) {
			const source = positions.get(edge.source);
			const target = positions.get(edge.target);
			if (!source || !target || source.external || target.external) continue;
			const sourceDepth = Math.max(0, Math.round(source.depth || 0));
			const targetDepth = Math.max(0, Math.round(target.depth || 0));
			if (targetDepth < outerStartDepth || targetDepth <= sourceDepth) continue;
			const sourceAngle = Number.isFinite(source.angle) ? source.angle : Math.atan2(source.y, source.x);
			const targetAngle = Number.isFinite(target.angle) ? target.angle : Math.atan2(target.y, target.x);
			const angularJump = Math.abs(shortestAngleDelta(sourceAngle, targetAngle));
			const requiredGap = outerHierarchyRequiredGap(source, target, spacing, angularJump, targetDepth >= maxDepth ? 1 : 0.68);
			const delta = source.radius + requiredGap - target.radius;
			if (delta <= Math.max(2, spacing.ringGap * 0.012)) continue;
			for (const id of collectOuterSubtreeIds(edge.target, childrenByParent, positions, targetDepth)) {
				const point = positions.get(id);
				if (!point || point.external || point.radius <= 0.001) continue;
				liftPointWithinRingBand(point, delta);
			}
			moved = true;
		}
		if (!moved) break;
	}
}

function outerHierarchyRequiredGap(
	source: RadialPoint,
	target: RadialPoint,
	spacing: SpacingProfile,
	angularJump: number,
	outerWeight: number,
): number {
	const angleReserve = clamp((angularJump - 0.42) / 1.18, 0, 0.36);
	const narrowSector = clamp((Math.PI * 0.72 - clamp(source.sectorSpan ?? Math.PI * 2, 0.024, Math.PI * 2)) / (Math.PI * 0.72), 0, 1);
	const baselineGap =
		spacing.ringGap * (0.92 + outerWeight * 0.44 + angleReserve * 0.3 + narrowSector * 0.18) +
		Math.max(source.nodeRadius, target.nodeRadius) * 2.4;
	if (angularJump <= 0.08) return baselineGap;
	const averageRadius = Math.max(1, (Math.max(0, source.radius) + Math.max(0, target.radius)) * 0.5);
	const arcDistance = averageRadius * angularJump;
	const radialDominanceGap = arcDistance * (0.42 + clamp(outerWeight, 0, 1) * 0.2);
	const dominanceCap =
		spacing.ringGap * (outerWeight >= 0.99 ? 2.85 : 2.12) +
		Math.max(source.nodeRadius, target.nodeRadius) * 3.2;
	return Math.max(
		baselineGap,
		Math.min(radialDominanceGap, dominanceCap),
	);
}

function collectOuterSubtreeIds(
	rootId: string,
	childrenByParent: Map<string, string[]>,
	positions: Map<string, RadialPoint>,
	minDepth: number,
): string[] {
	const ids: string[] = [];
	const stack = [rootId];
	const seen = new Set<string>();
	while (stack.length) {
		const id = stack.pop()!;
		if (seen.has(id)) continue;
		seen.add(id);
		const point = positions.get(id);
		if (point && Math.max(0, Math.round(point.depth || 0)) >= minDepth) ids.push(id);
		for (const childId of childrenByParent.get(id) ?? []) stack.push(childId);
	}
	return ids;
}

function liftPointWithinRingBand(point: RadialPoint, delta: number): void {
	point.radius += delta;
	if (Number.isFinite(point.ringRadius)) {
		const baseline = point.ringRadius!;
		if (!Number.isFinite(point.ringBandMin)) point.ringBandMin = baseline;
		point.ringBandMax = Math.max(Number.isFinite(point.ringBandMax) ? point.ringBandMax! : baseline, point.radius);
	}
	const angle = Number.isFinite(point.angle) ? point.angle : Math.atan2(point.y, point.x);
	point.x = Math.cos(angle) * point.radius;
	point.y = Math.sin(angle) * point.radius;
	point.angle = normalizeAngle(angle);
}

function preserveHierarchyRouteOrder(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph): void {
	const childrenByParent = new Map<string, string[]>();
	for (const edge of graph.hierarchyEdges) {
		if (!positions.has(edge.source) || !positions.has(edge.target)) continue;
		const children = childrenByParent.get(edge.source);
		if (children) children.push(edge.target);
		else childrenByParent.set(edge.source, [edge.target]);
	}
	const maxVisibleDepth = Math.max(0, ...[...positions.values()].map((point) => Math.max(0, Math.round(point.depth || 0))));
	const parentIds = [...childrenByParent.keys()].sort(
		(a, b) => (positions.get(a)?.depth ?? 0) - (positions.get(b)?.depth ?? 0),
	);
	for (const parentId of parentIds) {
		const parent = positions.get(parentId);
		const childIds = childrenByParent.get(parentId) ?? [];
		if (!parent || childIds.length === 0) continue;
		const childPoints = childIds
			.map((id) => ({ id, point: positions.get(id), node: graph.nodesById.get(id) }))
			.filter((entry): entry is { id: string; point: RadialPoint; node: WorldNode | undefined } => Boolean(entry.point));
		if (childPoints.length <= 1) continue;
		const parentAngle = Number.isFinite(parent.angle) ? parent.angle : Math.atan2(parent.y, parent.x);
		const parentDepth = Math.max(0, Math.round(parent.depth || 0));
		const inheritedSpan = clamp(parent.sectorSpan ?? Math.PI * 2, 0.024, Math.PI * 2);
		const guardSpan = inheritedSpan >= Math.PI * 2 - 0.001 ? Math.PI * 2 : inheritedSpan * 0.985;
		const pad = childPoints.length > 1 && guardSpan < Math.PI * 2 ? Math.min(guardSpan * 0.04, 0.035) : 0;
		const start = parentAngle - guardSpan / 2 + pad;
		const end = parentAngle + guardSpan / 2 - pad;
		const span = Math.max(0.001, end - start);
		const minGap = childPoints.length > 1 ? Math.min(0.045, Math.max(0.003, span / (childPoints.length * 18))) : 0;
		const ordered = childPoints
			.map((entry) => ({
				...entry,
				angle: unwrapAngleNear(entry.point.angle, parentAngle),
			}))
			.sort((a, b) => a.angle - b.angle || a.id.localeCompare(b.id));
		const finalVisibleFan = ordered.every((entry) => Math.max(0, Math.round(entry.point.depth || 0)) >= maxVisibleDepth);
		if (parentDepth > 1 && applyControlledSiblingFan(ordered, parent, parentAngle, start, end, finalVisibleFan)) continue;
		let previousAngle = start - minGap;
		for (let index = 0; index < ordered.length; index++) {
			const entry = ordered[index];
			if (!entry) continue;
			const remaining = ordered.length - index - 1;
			const minAllowed = previousAngle + minGap;
			const maxAllowed = end - remaining * minGap;
			const nextAngle = clamp(entry.angle, minAllowed, Math.max(minAllowed, maxAllowed));
			setPointAngle(entry.point, nextAngle);
			previousAngle = nextAngle;
		}
	}
}

function applyControlledSiblingFan(
	ordered: { id: string; point: RadialPoint; node?: WorldNode; angle: number }[],
	parent: RadialPoint,
	parentAngle: number,
	sectorStart: number,
	sectorEnd: number,
	finalVisibleFan = false,
): boolean {
	if (ordered.length <= 1) return false;
	const currentSpread = Math.max(0, (ordered[ordered.length - 1]?.angle ?? parentAngle) - (ordered[0]?.angle ?? parentAngle));
	const sectorSpan = Math.max(0.001, sectorEnd - sectorStart);
	const demandSpan = finalVisibleFan ? finalSiblingFanDemandSpan(ordered) : 0;
	const baseMinSpan = controlledSiblingMinSpan(ordered.length, sectorSpan);
	const baseMaxSpan = controlledSiblingMaxSpan(ordered.length, parent.depth, sectorSpan);
	const minSpan = finalVisibleFan
		? clamp(
				Math.max(finalSiblingFanArcFloor(ordered.length, sectorSpan), demandSpan * 1.02),
				Math.min(0.08, sectorSpan),
				Math.min(baseMinSpan, sectorSpan),
			)
		: baseMinSpan;
	const maxSpan = finalVisibleFan
		? Math.max(minSpan, Math.min(baseMaxSpan, Math.max(minSpan, demandSpan * 1.32 + 0.05), sectorSpan * 0.72))
		: baseMaxSpan;
	const targetSpan = finalVisibleFan
		? clamp(Math.min(currentSpread, Math.max(minSpan, demandSpan * 1.14 + 0.035)), minSpan, maxSpan)
		: clamp(currentSpread, minSpan, maxSpan);
	if (Math.abs(targetSpan - currentSpread) < 0.018) return false;
	const fanStart = clamp(parentAngle - targetSpan / 2, sectorStart, Math.max(sectorStart, sectorEnd - targetSpan));
	const step = ordered.length > 1 ? targetSpan / (ordered.length - 1) : 0;
	for (let index = 0; index < ordered.length; index++) {
		const entry = ordered[index];
		if (!entry) continue;
		const angle = ordered.length === 1 ? parentAngle : fanStart + step * index;
		setPointAngle(entry.point, angle);
	}
	for (let index = 1; index < ordered.length; index++) {
		const prev = ordered[index - 1]?.point;
		const point = ordered[index]?.point;
		if (!prev || !point) continue;
		const prevAngle = unwrapAngleNear(prev.angle, parentAngle);
		const angle = unwrapAngleNear(point.angle, parentAngle);
		if (angle <= prevAngle) setPointAngle(point, prevAngle + 0.003);
	}
	return true;
}

function finalSiblingFanDemandSpan(ordered: { point: RadialPoint; node?: WorldNode }[]): number {
	if (ordered.length <= 1) return 0;
	const radius = Math.max(1, medianNumber(ordered.map((entry) => entry.point.radius), ordered[0]?.point.radius ?? 1));
	const arcDemand =
		ordered.reduce((sum, entry) => {
			const labelDemand = entry.node ? labelArcPadding(entry.node) * 1.28 : 28;
			return sum + entry.point.nodeRadius * 2.6 + labelDemand + 18;
		}, 0) + Math.max(0, ordered.length - 1) * 16;
	return arcDemand / radius;
}

function finalSiblingFanArcFloor(count: number, sectorSpan: number): number {
	if (count <= 1) return 0;
	const countFloor = 0.18 + Math.log2(count + 1) * 0.125;
	return clamp(countFloor, 0.18, Math.min(sectorSpan * 0.55, Math.PI * 0.36));
}

function controlledSiblingMinSpan(count: number, sectorSpan: number): number {
	if (count <= 1) return 0;
	const countSpan = 0.1 + Math.log2(count + 1) * 0.17;
	return clamp(countSpan, 0.16, Math.min(sectorSpan * 0.55, Math.PI * 0.42));
}

function controlledSiblingMaxSpan(count: number, depth: number, sectorSpan: number): number {
	const countSpan = 0.38 + Math.sqrt(Math.max(1, count)) * 0.24;
	const depthTighten = clamp(1 - Math.max(0, depth - 1) * 0.045, 0.68, 1);
	const maxSpan = countSpan * depthTighten;
	const minSpan = controlledSiblingMinSpan(count, sectorSpan);
	const cap = Math.max(minSpan, Math.min(sectorSpan * 0.74, Math.PI * 0.9));
	return clamp(maxSpan, minSpan, cap);
}

function unwrapAngleNear(angle: number, center: number): number {
	return center + shortestAngleDelta(center, angle);
}

function setPointAngle(point: RadialPoint, angle: number): void {
	const normalized = normalizeAngle(angle);
	point.x = Math.cos(normalized) * point.radius;
	point.y = Math.sin(normalized) * point.radius;
	point.angle = normalized;
	if (Number.isFinite(point.sectorSpan) && (point.sectorSpan ?? 0) > 0) {
		const span = clamp(point.sectorSpan!, 0.024, Math.PI * 2);
		setPointSector(point, normalized - span / 2, normalized + span / 2);
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

function weightedAverage(values: number[], weights: number[]): number {
	let total = 0;
	let weighted = 0;
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (!Number.isFinite(value)) continue;
		const weight = Math.max(0.001, Number.isFinite(weights[index]) ? weights[index]! : 1);
		weighted += value! * weight;
		total += weight;
	}
	return total > 0 ? weighted / total : 0;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}
