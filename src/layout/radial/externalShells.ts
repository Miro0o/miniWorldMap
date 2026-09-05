import type { WorldNode, VisibleWorldGraph } from '../../world/types';
import type { RadialPoint, SpacingProfile } from './types';
import { indexIncidentEdges } from '../../world/edgeIndex';
import { preferredAngleForNode, normalizeAngle, shortestAngleDelta, makePoint, nodeRadius, labelArcPadding } from './geometry';

export function placeOuterCircleNodes(
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
	const incidentEdges = indexIncidentEdges(graph.linkEdges);
	const items = nodes
		.map((node, index) => ({
			node,
			preferred: preferredAngleForNode(node, incidentEdges.get(node.id) ?? [], positions, fallbackStart + index * slot),
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

export function placeExternalShells(
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
