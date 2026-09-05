import type { WorldEdge, WorldNode } from '../../world/types';
import type { RadialPoint, RadialRoute, RadialRing, RadialLayout } from './types';

export function smoothstep(edge0: number, edge1: number, value: number): number {
	if (edge0 === edge1) return value >= edge1 ? 1 : 0;
	const x = clamp((value - edge0) / (edge1 - edge0), 0, 1);
	return x * x * (3 - 2 * x);
}

export function computeLinkRoutes(
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

export function computeRings(positions: Map<string, RadialPoint>, ringTargets: Map<number, number>): RadialRing[] {
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

export function radialLayoutBounds(positions: Map<string, RadialPoint>, routeMaxRadius: number): RadialLayout['bounds'] {
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

export function shiftRadialLayout(positions: Map<string, RadialPoint>, routes: Map<string, RadialRoute>, offsetX: number, offsetY: number): void {
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

export function makePoint(radius: number, angle: number, depth: number, nodeRadiusValue: number, external: boolean): RadialPoint {
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

export function setPointSector(point: RadialPoint, start: number, end: number): void {
	const span = clamp(Math.max(0, end - start), 0.024, Math.PI * 2);
	const center = start + span / 2;
	point.sectorStart = center - span / 2;
	point.sectorEnd = center + span / 2;
	point.sectorSpan = span;
}

export function nodeRadius(node: WorldNode | undefined, maxDegree: number, incidentPressure = 0): number {
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

export function maxLinkDegree(nodes: WorldNode[]): number {
	let max = 1;
	for (const node of nodes) max = Math.max(max, (node.linkCount || 0) + (node.backlinkCount || 0));
	return max;
}

export function compareLayoutNode(a: WorldNode | undefined, b: WorldNode | undefined): number {
	if (!a || !b) return a ? -1 : b ? 1 : 0;
	const typeRank = (node: WorldNode) => (node.type === 'folder' ? 0 : node.type === 'note' ? 1 : node.type === 'external' ? 2 : 3);
	return typeRank(a) - typeRank(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function maxRadius(positions: Map<string, RadialPoint>): number {
	let max = 0;
	for (const point of positions.values()) max = Math.max(max, point.radius);
	return max;
}

export function preferredAngleForNode(
	node: WorldNode,
	edges: readonly WorldEdge[],
	positions: Map<string, RadialPoint>,
	fallbackAngle: number,
): number {
	const angles: number[] = [];
	for (const edge of edges) {
		const otherId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
		if (!otherId) continue;
		const other = positions.get(otherId);
		if (other && Number.isFinite(other.angle)) angles.push(other.angle);
	}
	return averageAngles(angles, fallbackAngle);
}

export function averageAngles(angles: number[], fallbackAngle: number): number {
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

export function labelCollisionPadding(node: WorldNode): number {
	const titleLength = Array.from(String(node.title || '')).length;
	const typePad = node.type === 'folder' ? 13 : node.type === 'external' || node.externalProxy ? 9 : 5;
	return clamp(Math.sqrt(Math.max(1, titleLength)) * 4.2 + typePad, 10, 60);
}

export function labelArcPadding(node: WorldNode): number {
	const titleLength = Array.from(String(node.title || '')).length;
	const folderPad = node.type === 'folder' ? 14 : 0;
	const externalPad = node.type === 'external' || node.externalProxy ? 9 : 0;
	return clamp(Math.sqrt(Math.max(1, titleLength)) * 7.5 + Math.min(110, titleLength * 1.25) + folderPad + externalPad, 24, 150);
}

export function unwrapAngleNear(angle: number, center: number): number {
	return center + shortestAngleDelta(center, angle);
}

export function setPointAngle(point: RadialPoint, angle: number): void {
	const normalized = normalizeAngle(angle);
	point.x = Math.cos(normalized) * point.radius;
	point.y = Math.sin(normalized) * point.radius;
	point.angle = normalized;
	if (Number.isFinite(point.sectorSpan) && (point.sectorSpan ?? 0) > 0) {
		const span = clamp(point.sectorSpan!, 0.024, Math.PI * 2);
		setPointSector(point, normalized - span / 2, normalized + span / 2);
	}
}

export function anchorHomePositions(positions: Map<string, RadialPoint>): void {
	for (const point of positions.values()) {
		point.homeX = point.x;
		point.homeY = point.y;
		point.homeRadius = point.radius;
		point.homeAngle = point.angle;
	}
}

export function blendAngles(from: number, to: number, amount: number): number {
	return normalizeAngle(from + shortestAngleDelta(from, to) * clamp(amount, 0, 1));
}

export function normalizeAngle(angle: number): number {
	let next = Number.isFinite(angle) ? angle : 0;
	next %= Math.PI * 2;
	if (next < 0) next += Math.PI * 2;
	return next;
}

export function shortestAngleDelta(from: number, to: number): number {
	let delta = normalizeAngle(to) - normalizeAngle(from);
	if (delta > Math.PI) delta -= Math.PI * 2;
	if (delta < -Math.PI) delta += Math.PI * 2;
	return delta;
}

export function deterministicPairAngle(a: string, b: string): number {
	const text = `${a}|${b}`;
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return ((hash >>> 0) / 4294967296) * Math.PI * 2;
}

export function deterministicUnitOffset(value: string, salt: string): number {
	return Math.sin(deterministicPairAngle(String(value || ''), String(salt || '')));
}

export function medianNumber(values: number[], fallback: number): number {
	const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!numbers.length) return fallback;
	const middle = Math.floor(numbers.length / 2);
	return numbers.length % 2 ? (numbers[middle] ?? fallback) : ((numbers[middle - 1] ?? fallback) + (numbers[middle] ?? fallback)) / 2;
}

export function weightedAverage(values: number[], weights: number[]): number {
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

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Number.isFinite(value) ? value : min, min), max);
}
