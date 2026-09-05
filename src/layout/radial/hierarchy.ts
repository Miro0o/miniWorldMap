import type { VisibleWorldGraph, WorldNode } from '../../world/types';
import { compareLayoutNode, clamp, makePoint, nodeRadius, setPointSector, smoothstep } from './geometry';
import type { SpacingProfile, Metric, RadialPoint } from './types';
import { LEAF_SPAN_DEMAND } from './types';

export function childrenByParentMap(
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

export function measureSubtree(
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

export function collectReachable(id: string | null | undefined, childrenByParent: Map<string, string[]>, reachable: Set<string>): void {
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

export function placeRadialChildren(
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

	const baseChildWeights = children.map((childId) => subtreeAllocationWeight(childId, depth + 1, childrenByParent, metrics));
	const childWeights = densityBalancedSubtreeAllocationWeights(children, depth + 1, childrenByParent, metrics, baseChildWeights);
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

export function subtreeFanWeight(
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
	const earlyDepthWeight = clamp(1 - Math.max(0, depth - 1) * 0.34, 0, 1);
	const subtreeDensity = Math.pow(Math.max(1, metric.count), 0.62);
	const depthReserve = Math.sqrt(Math.max(1, metric.maxDepth - depth + 1));
	const denseSectorWeight = earlyDepthWeight * (subtreeDensity * 0.72 + depthReserve * 0.48 + spanDemand * 2.2);
	return Math.max(0.18, demandWeight + structuralWeight + denseSectorWeight);
}

function densityBalancedSubtreeAllocationWeights(
	children: string[],
	depth: number,
	childrenByParent: Map<string, string[]>,
	metrics: Map<string, Metric>,
	baseWeights: number[],
): number[] {
	if (children.length <= 1) return baseWeights;
	const childMetrics = children.map((childId) => metrics.get(childId) ?? { count: 1, weight: 1, maxDepth: depth, spanDemand: LEAF_SPAN_DEMAND });
	const counts = childMetrics.map((metric) => Math.max(1, metric.count));
	const totalCount = counts.reduce((sum, count) => sum + count, 0);
	const averageCount = totalCount / Math.max(1, counts.length);
	const maxCount = Math.max(1, ...counts);
	const spanDemands = childMetrics.map((metric) => Math.max(LEAF_SPAN_DEMAND, metric.spanDemand ?? LEAF_SPAN_DEMAND));
	const averageSpanDemand = spanDemands.reduce((sum, demand) => sum + demand, 0) / Math.max(1, spanDemands.length);
	const depthEmphasis = clamp(1 - Math.max(0, depth - 1) * 0.16, 0.32, 1);
	const siblingContrast = clamp(Math.sqrt(maxCount / Math.max(1, averageCount)) - 1, 0, 1.9);
	if (siblingContrast <= 0.04 && maxCount < averageCount * 1.18) return baseWeights;
	return baseWeights.map((baseWeight, index) => {
		const metric = childMetrics[index] ?? { count: 1, weight: 1, maxDepth: depth, spanDemand: LEAF_SPAN_DEMAND };
		const count = counts[index] ?? 1;
		const countRatio = count / Math.max(1, averageCount);
		const maxRatio = count / Math.max(1, maxCount);
		const demandRatio = Math.max(LEAF_SPAN_DEMAND, metric.spanDemand ?? LEAF_SPAN_DEMAND) / Math.max(LEAF_SPAN_DEMAND, averageSpanDemand);
		const directChildren = childrenByParent.get(children[index] ?? '')?.length ?? 0;
		const densityLift =
			1 +
			smoothstep(1.06, 2.85, countRatio) * (0.34 + depthEmphasis * 0.46 + siblingContrast * 0.1) +
			smoothstep(0.42, 0.78, maxRatio) * (0.12 + depthEmphasis * 0.18);
		const demandLift = 1 + smoothstep(1.05, 2.25, demandRatio) * (0.16 + depthEmphasis * 0.24);
		const branchLift = 1 + smoothstep(2, 10, directChildren) * (0.08 + depthEmphasis * 0.14);
		const sparseBrake = countRatio < 0.72 ? clamp(0.9 + countRatio * 0.14, 0.84, 1) : 1;
		return Math.max(0.12, baseWeight * clamp(densityLift * demandLift * branchLift * sparseBrake, 0.72, 2.38));
	});
}
