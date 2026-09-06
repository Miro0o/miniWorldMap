import type { VisibleWorldGraph, WorldNode } from '../../world/types';
import type { RadialLayoutOptions, RadialLayout, RadialPoint, Metric, SpacingProfile, DepthRingStats, DepthLayoutPolicy, DepthLayoutProfile, RingItem, SectorRingLaneItem } from './types';
import { clamp, maxLinkDegree, makePoint, nodeRadius, setPointSector, compareLayoutNode, maxRadius, computeLinkRoutes, radialLayoutBounds, shiftRadialLayout, anchorHomePositions, computeRings, labelArcPadding, normalizeAngle, smoothstep, labelCollisionPadding, deterministicPairAngle, shortestAngleDelta, blendAngles, medianNumber, deterministicUnitOffset, averageAngles } from './geometry';
import { MIN_RING_SPACING, MAX_RING_SPACING, MIN_NODE_SPACING, MAX_NODE_SPACING, RING_JAGGED_BAND_FACTOR, RING_JAGGED_OUTER_FACTOR, RING_JAGGED_INNER_FACTOR } from './types';
import { ROOT_ID } from '../../world/types';
import { childrenByParentMap, measureSubtree, collectReachable, placeRadialChildren } from './hierarchy';
import { placeOuterCircleNodes, placeExternalShells } from './externalShells';
import { nodeKindKey, angularSpreadAround } from './ringGroups';
import { arrangeHierarchySectors, expandHierarchyFans, separateHierarchyBranches } from './sectorConstraints';
import { spreadRingSiblings, syncFamilySectors } from './ringFanSpacing';
import { spreadRootNotes } from './terminalNoteSpacing';
import { separateDepthBands } from './depthBands';
import { compactHierarchyBands } from './compactBands';
import { ensureBandCapacity } from './bandCapacity';
export { DEFAULT_RING_SPACING, MIN_RING_SPACING, MAX_RING_SPACING, DEFAULT_NODE_SPACING, MIN_NODE_SPACING, MAX_NODE_SPACING } from './types';
export type { RadialPoint, RadialRing, RadialRoute, RadialLayout, RadialLayoutOptions } from './types';

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
	arrangeHierarchySectors(positions, graph, swirlStrength);
	if (!compactHierarchyBands(positions, graph, ringTargets, baseRingGap, baseNodeGap)) {
		const initialOuter = maxRadius(positions);
		enforceOuterHierarchyContinuity(positions, graph, spacing);
		separateHierarchyBranches(positions, graph, spacing.ringGap);
		expandHierarchyFans(positions, graph, spacing.nodeGap);
		const depthBands = separateDepthBands(positions, ringTargets);
		spreadRingSiblings(positions, graph, spacing.nodeGap, depthBands);
		if (maxRadius(positions) > initialOuter * 1.2) compactHierarchyBands(positions, graph, ringTargets, baseRingGap, baseNodeGap);
	}
	spreadRootNotes(positions, graph);
	syncFamilySectors(positions, childrenByParent);
	const capacity = ensureBandCapacity(positions, graph, ringTargets, baseNodeGap);
	outerRadius = Math.max(spacing.ringGap, maxRadius(positions));
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
		readableZoom: capacity.readableZoom,
	};
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
	const depthProfile = buildDepthLayoutProfile(new Map(depths.map((depth) => [depth, byDepth.get(depth)?.count ?? 0])));
	for (const depth of depths) {
		const entry = byDepth.get(depth);
		if (!entry) continue;
		const policy = depthPolicy(depthProfile, depth);
		const density = ringCountDensity(entry.count, depthProfile.averageCount, depthProfile.maxCount);
		const pressureSignal = Math.sqrt(entry.linkPressure / Math.max(1, entry.count));
		const demandRadius = depthRingDemandRadius(entry, nodeGap, density.pressure, pressureSignal, policy);
		const carriedGap = baselineProgressionGap(previousGap, spacing, policy);
		const structuralGap = Math.max(
			minimumBaselineRingGap(entry, spacing, density, pressureSignal, policy),
			carriedGap,
			spacing.ringGap * (0.86 + policy.outerWeight * 0.1 + policy.sparseTail * 0.48),
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
	policy: DepthLayoutPolicy,
): number {
	if (entry.count <= 1) return entry.maxDiameter * 1.18;
	const count = Math.max(1, entry.count);
	const paddingDemand = count * Math.max(10, nodeGap * (0.14 + policy.outerWeight * 0.05 + policy.sparseTail * 0.08 + policy.middleCrowdWeight * 0.115));
	const circumferenceDemand =
		Math.max(entry.diameterTotal, entry.arcDemand * (0.78 + policy.outerWeight * 0.12 + policy.sparseTail * 0.16 + policy.middleCrowdWeight * 0.22)) + paddingDemand;
	const utilization = clamp(
		(0.62 - policy.utilizationDrop) -
			Math.min(0.18 + policy.outerWeight * 0.02 + policy.sparseTail * 0.02, densityPressure * 0.07) -
			Math.min(0.08 + policy.outerWeight * 0.02 + policy.sparseTail * 0.02 + policy.middleCrowdWeight * 0.038, linkPressure * 0.012) -
			(entry.external ? 0.04 : 0),
		0.32 - policy.sparseTail * 0.06 - policy.middleCrowdWeight * 0.06,
		0.62,
	);
	return circumferenceDemand / Math.max(1, Math.PI * 2 * utilization) + entry.maxDiameter * (0.9 + policy.outerWeight * 0.18 + policy.sparseTail * 0.34 + policy.middleCrowdWeight * 0.36);
}

function baselineProgressionGap(previousGap: number, spacing: SpacingProfile, policy: DepthLayoutPolicy): number {
	if (policy.outerWeight <= 0.03 && policy.sparseTail <= 0.03 && policy.middleCrowdWeight <= 0.03) return Math.min(previousGap * 0.82, spacing.ringGap * 1.55);
	return Math.max(
		previousGap * clamp(0.9 + policy.outerWeight * 0.16 + policy.sparseTail * 0.1 + policy.middleCrowdWeight * 0.22, 0.9, 1.34),
		spacing.ringGap * clamp(0.9 + (policy.radialScale - 1) * 0.64 + policy.middleCrowdWeight * 0.48, 0.9, 2.78),
	);
}

function minimumBaselineRingGap(
	entry: DepthRingStats,
	spacing: SpacingProfile,
	density: ReturnType<typeof ringCountDensity>,
	linkPressure: number,
	policy: DepthLayoutPolicy,
): number {
	const sparseRelief = clamp(1 - density.relativeToAverage, 0, 0.32);
	const factor = clamp(
		0.92 +
			density.pressure * 0.18 +
			density.maxPressure * 0.12 +
			policy.outerWeight * 0.08 +
			policy.middleCrowdWeight * 0.52 +
			policy.sparseTail * 0.28 +
			Math.min(0.12, linkPressure * 0.018) +
			(entry.external ? 0.08 : 0) -
			sparseRelief * 0.08,
		0.84,
		2.9,
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

function buildDepthLayoutProfile(countsByDepth: Map<number, number>): DepthLayoutProfile {
	const depths = [...countsByDepth.keys()].filter((depth) => depth > 0).sort((a, b) => a - b);
	const maxDepth = Math.max(1, ...depths);
	const totalCount = depths.reduce((sum, depth) => sum + Math.max(0, countsByDepth.get(depth) ?? 0), 0);
	const averageCount = totalCount / Math.max(1, depths.length);
	const maxCount = Math.max(1, ...depths.map((depth) => Math.max(0, countsByDepth.get(depth) ?? 0)));
	const byDepth = new Map<number, DepthLayoutPolicy>();
	const fallback = makeDepthLayoutPolicy(0, 0, maxDepth, averageCount, maxCount, 0);
	let cumulativeCount = 0;
	for (const depth of depths) {
		const count = Math.max(0, countsByDepth.get(depth) ?? 0);
		cumulativeCount += count;
		const populationRatio = totalCount > 0 ? cumulativeCount / totalCount : 0;
		byDepth.set(depth, makeDepthLayoutPolicy(depth, count, maxDepth, averageCount, maxCount, populationRatio));
	}
	return { maxDepth, averageCount, maxCount, byDepth, fallback };
}

function makeDepthLayoutPolicy(
	depth: number,
	count: number,
	maxDepth: number,
	averageCount: number,
	maxCount: number,
	populationRatio: number,
): DepthLayoutPolicy {
	const normalizedDepth = Math.max(0, depth || 0);
	const depthRatio = normalizedDepth <= 1 ? 0 : clamp((normalizedDepth - 1) / Math.max(1, maxDepth - 1), 0, 1);
	const relativeToAverage = Math.max(0, count || 0) / Math.max(1, averageCount || 1);
	const relativeToMax = Math.max(0, count || 0) / Math.max(1, maxCount || 1);
	const ringPresence = Math.max(
		smoothstep(0.5, 0.95, relativeToAverage),
		smoothstep(0.16, 0.38, relativeToMax),
	);
	const depthOuterWeight = smoothstep(0.38, 0.88, depthRatio);
	const populationOuterWeight = smoothstep(0.62, 0.92, populationRatio) * smoothstep(0.18, 0.42, depthRatio) * ringPresence;
	const outerWeight = clamp(Math.max(depthOuterWeight, populationOuterWeight * 0.72), 0, 1);
	const crowdPressure = clamp(Math.sqrt(relativeToAverage) * 0.62 + Math.sqrt(relativeToMax) * 0.52, 0, 2.2);
	const crowdDominance = smoothstep(0.06, 0.24, depthRatio) * (1 - smoothstep(0.76, 0.98, depthRatio));
	const middleCrowdWeight = clamp(crowdDominance * ringPresence * Math.max(0, crowdPressure - 0.72) * (1 - outerWeight * 0.35), 0, 1.55);
	const sparseAverage = clamp((0.9 - Math.min(0.9, relativeToAverage)) / 0.9, 0, 1);
	const sparseMax = clamp((0.24 - Math.min(0.24, relativeToMax)) / 0.24, 0, 1);
	const sparseTail = outerWeight * Math.max(sparseAverage, sparseMax * 0.86);
	const radialScale = clamp(
		1 + outerWeight * 0.05 + sparseTail * 1.02 + middleCrowdWeight * 0.56 + Math.max(0, crowdPressure - 1.05) * 0.06 * outerWeight,
		1,
		2.58,
	);
	const bandScale = clamp(
		1 + outerWeight * 0.07 + sparseTail * 0.96 + middleCrowdWeight * 0.72 + Math.max(0, crowdPressure - 1.05) * 0.16 * outerWeight,
		1,
		2.86,
	);
	const utilizationDrop = clamp(outerWeight * 0.022 + sparseTail * 0.085 + middleCrowdWeight * 0.09 + Math.max(0, crowdPressure - 1.05) * 0.03 * outerWeight, 0, 0.36);
	return {
		depth,
		count,
		depthRatio,
		outerWeight,
		crowdPressure,
		middleCrowdWeight,
		sparseTail,
		radialScale,
		bandScale,
		utilizationDrop,
	};
}

function depthPolicy(profile: DepthLayoutProfile, depth: number): DepthLayoutPolicy {
	return profile.byDepth.get(Math.max(0, Math.round(depth || 0))) ?? profile.fallback;
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
	const depthProfile = buildDepthLayoutProfile(new Map(depths.map((depth) => [depth, byDepth.get(depth)?.length ?? 0])));
	for (const depth of depths) {
		const items = byDepth.get(depth);
		if (!items?.length) continue;
		const policy = depthPolicy(depthProfile, depth);
		const maxVisualRadius = Math.max(...items.map((item) => item.visualRadius), 4);
		const totalArcDemand = items.reduce((sum, item) => sum + item.arcDemand, 0);
		const targetRadius = ringTargets.get(depth) ?? spacing.ringGap * depth;
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const density = ringCountDensity(items.length, depthProfile.averageCount, depthProfile.maxCount);
		const baseDensityPressure = density.pressure * 0.72 + density.maxPressure * 0.42;
		const outerActivation = Math.max(policy.outerWeight, policy.sparseTail);
		const densityPressure = clamp(baseDensityPressure + Math.max(0, policy.crowdPressure - baseDensityPressure) * Math.max(outerActivation, policy.middleCrowdWeight * 0.82), 0, 2.8);
		const laneGap = Math.max(
			(maxVisualRadius * (2.08 + densityPressure * 0.22 + depthRatio * 0.12) + Math.max(14, nodeGap * (0.12 + densityPressure * 0.018 + depthRatio * 0.018))) *
				clamp(1 + policy.sparseTail * 0.22 + policy.middleCrowdWeight * 0.42, 1, 1.84),
			spacing.ringGap * (0.064 + densityPressure * 0.024 + depthRatio * 0.012) * policy.bandScale,
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
		const outerDemandRadius = policy.outerWeight > 0.04 || policy.sparseTail > 0.04
			? outerBaselineRingDemandRadius(items, positions, spacing, nodeGap, densityPressure, previousOuterRadius, laneGap, policy)
			: 0;
		const jitterScale = clamp(1 + policy.sparseTail * 0.92 + policy.outerWeight * 0.08 - Math.max(0, densityPressure - 1.4) * 0.05, 0.88, 2.1);
		const requestedJitterBand = sectorPreservingJaggedBand(depth, targetRadius, spacing, items.length, totalArcDemand, densityPressure) * jitterScale;
		const jitterReserve = sectorPreservingJitterReserve(targetRadius, items.length, totalArcDemand);
		const baselineRadius = Math.max(
			targetRadius,
			crowdedBaselineRadius,
			outerDemandRadius,
			previousOuterRadius + laneGap * 0.38,
			policy.outerWeight > 0.04 || policy.sparseTail > 0.04 ? previousOuterRadius + outerBandLaneGap(spacing, laneGap, policy) : 0,
			previousOuterRadius + maxVisualRadius * (1.72 + policy.middleCrowdWeight * 0.26) + requestedJitterBand * jitterReserve,
		);
		const jitterBand = Math.min(
			sectorPreservingJaggedBand(depth, baselineRadius, spacing, items.length, totalArcDemand, densityPressure) * jitterScale,
			Math.max(0, baselineRadius - previousOuterRadius - maxVisualRadius * (1.44 - policy.sparseTail * 0.12)),
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
				? parentPoint.radius + routeContinuityGap(parentPoint, spacing, nodeGap, depthRatio, densityPressure, policy)
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
			item.point.ringBandMax = Math.max(baselineRadius + jitterBand, radius);
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

function outerBandLaneGap(spacing: SpacingProfile, laneGap: number, policy: DepthLayoutPolicy): number {
	return Math.max(
		spacing.ringGap * (1.0 + policy.outerWeight * 0.22 + policy.sparseTail * 0.52),
		laneGap * (1.12 + policy.outerWeight * 0.1 + policy.sparseTail * 0.26),
	);
}

function routeContinuityGap(
	parentPoint: RadialPoint,
	spacing: SpacingProfile,
	nodeGap: number,
	depthRatio: number,
	densityPressure: number,
	policy: DepthLayoutPolicy,
): number {
	const parentSector = clamp(parentPoint.sectorSpan ?? Math.PI * 2, 0.024, Math.PI * 2);
	const narrowness = clamp((Math.PI * 0.9 - parentSector) / (Math.PI * 0.9), 0, 1);
	const densityReserve = clamp(densityPressure / 2.6, 0, 1) * 0.08;
	const factor = clamp(0.38 + narrowness * 0.24 + clamp(depthRatio, 0, 1) * 0.12 + densityReserve + policy.sparseTail * 0.48, 0.36, 1.46);
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
	policy: DepthLayoutPolicy,
): number {
	if (items.length === 0) return 0;
	const maxVisualRadius = Math.max(...items.map((item) => item.visualRadius), 4);
	const totalDemand = items.reduce((sum, item) => sum + item.arcDemand, 0) + items.length * Math.max(10, nodeGap * 0.18);
	const fullRingUtilization = clamp(
		(0.52 - policy.outerWeight * 0.035 - policy.sparseTail * 0.055) - densityPressure * 0.035 - Math.min(0.06, items.length / 3600),
		0.3 - policy.sparseTail * 0.022,
		0.52,
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
		const targetSpan = outerBaselineGroupTargetSpan(group.length, parentDepth, parentSectorSpan, policy);
		const groupDemand = group.reduce((sum, item) => sum + item.arcDemand, 0) + Math.max(0, group.length - 1) * Math.max(12, nodeGap * 0.22);
		const utilization = clamp(
			(0.72 - policy.outerWeight * 0.035 - policy.sparseTail * 0.055) - densityPressure * 0.045 - Math.min(0.08, Math.sqrt(group.length) * 0.012),
			0.42 - policy.sparseTail * 0.045,
			0.72,
		);
		demandRadius = Math.max(demandRadius, groupDemand / Math.max(1, targetSpan * utilization) + maxVisualRadius * 2.15);
	}
	return Math.max(
		demandRadius,
		previousOuterRadius +
			Math.max(
				laneGap * (1.06 + policy.outerWeight * 0.1 + policy.sparseTail * 0.24),
				spacing.ringGap * (1.1 + policy.outerWeight * 0.14 + policy.sparseTail * 0.52),
			) +
			maxVisualRadius * 1.2,
	);
}

function finalRingParentPoint(item: SectorRingLaneItem, positions: Map<string, RadialPoint>): RadialPoint | null {
	if (item.node.parentId !== null && item.node.parentId !== undefined) return positions.get(item.node.parentId) ?? null;
	return positions.get(item.parentKey) ?? null;
}

function outerBaselineGroupTargetSpan(count: number, parentDepth: number, parentSectorSpan: number, policy: DepthLayoutPolicy): number {
	if (parentDepth <= 0) return clamp(parentSectorSpan * 0.96, 0.12, Math.PI * 2);
	const controlledSpan = controlledSiblingMaxSpan(count, parentDepth, parentSectorSpan);
	const countSpan = 0.14 + Math.sqrt(Math.max(1, count)) * 0.22;
	const depthTighten = clamp(1 - Math.max(0, parentDepth - 1) * 0.04, 0.66, 0.96);
	const compactSpan = countSpan * depthTighten;
	const inheritedLimit = parentSectorSpan * clamp(0.8 - policy.outerWeight * 0.08 - policy.sparseTail * 0.1, 0.54, 0.8);
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
			Math.max(0, Math.log2(Math.max(1, totalCount) / 420)) * 0.044 +
			Math.max(0, Math.sqrt(maxCount / 72) - 1) * 0.12 +
			Math.max(0, Math.sqrt(averageCount / 48) - 1) * 0.075,
		1,
		1.46,
	);
	const maxDepth = Math.max(...depths, 1);
	const scaleForDepth = (depth: number) => {
		const count = countsByDepth.get(depth) ?? 0;
		const density = ringCountDensity(count, averageCount, maxCount);
		const depthRatio = clamp((depth - 1) / Math.max(1, maxDepth - 1), 0, 1);
		const middleWeight = Math.sin(Math.PI * clamp(depthRatio, 0, 1));
		const innerWeight = clamp(1 - depthRatio * 0.68, 0.28, 1);
		const crowdWeight = clamp(density.pressure * 0.78 + density.maxPressure * 0.88, 0, 2.08);
		const crowdDominance = smoothstep(0.08, 0.28, depthRatio) * (1 - smoothstep(0.72, 0.96, depthRatio));
		const focusedMiddle = middleWeight * 0.7 + crowdDominance * 0.84 + innerWeight * 0.28;
		const relief = (globalScale - 1) * (0.34 + focusedMiddle) * crowdWeight;
		const sparseCarry = count > 0 && density.relativeToAverage < 0.55 ? (globalScale - 1) * 0.12 : 0;
		return clamp(globalScale + relief + sparseCarry, 1, 1.86);
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
	const countsByDepth = new Map<number, number>();
	for (const point of positions.values()) {
		if (point.external || point.radius <= 0.001) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		if (depth > 0) countsByDepth.set(depth, (countsByDepth.get(depth) ?? 0) + 1);
	}
	const depthProfile = buildDepthLayoutProfile(countsByDepth);
	let previousRadius = 0;
	let previousGap = spacing.ringGap;
	for (const depth of depths) {
		const currentRadius = ringTargets.get(depth) ?? 0;
		const policy = depthPolicy(depthProfile, depth);
		const carriedGap = baselineProgressionGap(previousGap, spacing, policy);
		const requiredRadius = previousRadius + Math.max(spacing.ringGap * (0.86 + policy.outerWeight * 0.12 + policy.sparseTail * 0.68), carriedGap);
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
	const countsByDepth = new Map<number, number>();
	for (const point of positions.values()) {
		if (point.external || point.radius <= 0.001) continue;
		const depth = Math.max(0, Math.round(point.depth || 0));
		if (depth > 0) countsByDepth.set(depth, (countsByDepth.get(depth) ?? 0) + 1);
	}
	enforceLocalOuterHierarchyContinuity(positions, graph, spacing, buildDepthLayoutProfile(countsByDepth));
}

function enforceLocalOuterHierarchyContinuity(
	positions: Map<string, RadialPoint>,
	graph: VisibleWorldGraph,
	spacing: SpacingProfile,
	depthProfile: DepthLayoutProfile,
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
				if (targetDepth <= sourceDepth) continue;
				const policy = depthPolicy(depthProfile, targetDepth);
				const activation = Math.max(policy.outerWeight, policy.sparseTail * 0.82);
				if (activation <= 0.18) continue;
				const sourceAngle = Number.isFinite(source.angle) ? source.angle : Math.atan2(source.y, source.x);
				const targetAngle = Number.isFinite(target.angle) ? target.angle : Math.atan2(target.y, target.x);
				const angularJump = Math.abs(shortestAngleDelta(sourceAngle, targetAngle));
				const requiredGap = outerHierarchyRequiredGap(source, target, spacing, angularJump, clamp(0.28 + activation * 0.58, 0.28, 0.86));
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
		spacing.ringGap * (0.9 + outerWeight * 0.32 + angleReserve * 0.22 + narrowSector * 0.14) +
		Math.max(source.nodeRadius, target.nodeRadius) * 2.4;
	if (angularJump <= 0.08) return baselineGap;
	const averageRadius = Math.max(1, (Math.max(0, source.radius) + Math.max(0, target.radius)) * 0.5);
	const arcDistance = averageRadius * angularJump;
	const radialDominanceGap = arcDistance * (0.34 + clamp(outerWeight, 0, 1) * 0.14);
	const dominanceCap =
		spacing.ringGap * (outerWeight >= 0.82 ? 2.3 : 1.76) +
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
