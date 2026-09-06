import { SpatialIndex } from '../../render/SpatialIndex';
import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';
import { siblingDistance, siblingSpacingUnit } from './siblingDistance';

/** Final capacity guard shared by every root and layout path. Similarity
 * expansion preserves angles, tree shape, band separation and planarity. */
export function ensureBandCapacity(positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, ringTargets: Map<number, number>, nodeGap: number): { scale: number; readableZoom: number } {
	const entries = [...positions].filter(([, point]) => !point.external).map(([id, point]) => ({ id, point }));
	if (entries.length < 2) return { scale: 1, readableZoom: 0 };
	const unit = siblingSpacingUnit(positions, nodeGap);
	const distance = siblingDistance(positions, nodeGap);
	const parents = new Map(graph.hierarchyEdges.filter((edge) => edge.type === 'hierarchy').map((edge) => [edge.target, edge.source]));
	const diameter = ({ id, point }: typeof entries[number]) => (8 + Math.max(0, point.nodeRadius - 6) * 0.25) * (id === graph.rootId ? 1.35 : graph.nodesById.get(id)?.type === 'folder' ? 1.1 : 1);
	const maxPixelDistance = Math.max(...entries.map(diameter)) + 6;
	const maxWorldDistance = Math.max(...entries.map(({ point }) => distance(point, point))) * 1.35;
	let scale = 1, readableZoom = 0;
	const measure = (a: typeof entries[number], b: typeof entries[number]) => {
		const actual = Math.max(1e-9, Math.hypot(a.point.x - b.point.x, a.point.y - b.point.y));
		const family = parents.get(a.id) === parents.get(b.id) || parents.get(a.id) === b.id || parents.get(b.id) === a.id;
		scale = Math.max(scale, distance(a.point, b.point) * (family ? 1 : 1.35) / actual);
		readableZoom = Math.max(readableZoom, ((diameter(a) + diameter(b)) / 2 + 6) / actual);
	};
	// Seed a lower bound cheaply. Only pairs within the resulting search radii
	// can increase either maximum, so the spatial pass remains exact.
	const ordered = entries.slice().sort((a, b) => a.point.x - b.point.x || a.point.y - b.point.y);
	for (let i = 1; i < ordered.length; i++) measure(ordered[i - 1]!, ordered[i]!);
	const index = new SpatialIndex(entries, ({ point }) => ({ minX: point.x, maxX: point.x, minY: point.y, maxY: point.y }));
	for (const a of entries) {
		const radius = Math.max(maxWorldDistance / scale, maxPixelDistance / readableZoom);
		for (const b of index.query(a.point.x, a.point.y, radius)) if (a.id < b.id) measure(a, b);
	}
	scale = scale > 1 + 1e-6 ? scale * 1.01 : 1;
	for (const point of positions.values()) {
		point.siblingSpacing = unit;
		point.radius *= scale; point.x *= scale; point.y *= scale;
		if (point.ringRadius !== undefined) point.ringRadius *= scale;
		if (point.ringBandMin !== undefined) point.ringBandMin *= scale;
		if (point.ringBandMax !== undefined) point.ringBandMax *= scale;
	}
	for (const [depth, radius] of ringTargets) ringTargets.set(depth, radius * scale);
	return { scale, readableZoom: readableZoom / scale };
}
