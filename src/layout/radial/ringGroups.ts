import type { RadialPoint, SpacingProfile, Metric, RingItem, ParentRingGroup, FanPlacement, ParentRingSectorEntry } from './types';
import type { VisibleWorldGraph, WorldNode } from '../../world/types';
import { clamp, nodeRadius, labelCollisionPadding, labelArcPadding, normalizeAngle, blendAngles, averageAngles, compareLayoutNode, shortestAngleDelta, weightedAverage, setPointSector } from './geometry';
import { subtreeFanWeight } from './hierarchy';

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

export function angularSpreadAround(center: number, angles: number[]): number {
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

export function nodeKindKey(node: WorldNode): string {
	if (node.type === 'external' || node.externalProxy) return 'external';
	if (node.type === 'unresolved') return 'unresolved';
	if (node.type === 'folder') return 'folder';
	return 'note';
}
