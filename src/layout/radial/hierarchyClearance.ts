import { SpatialIndex, type SpatialBounds } from '../../render/SpatialIndex';
import type { VisibleWorldGraph } from '../../world/types';
import type { RadialPoint } from './types';

interface NodeItem { id: string; point: RadialPoint }
interface Segment { id: string; source: string; target: string; a: RadialPoint; b: RadialPoint }
type Collision = { kind: 'nodes' | 'edges' | 'node-edge'; a: string; b: string };

/** A static index plus a small changed set supports local subtree proposals
 * without rebuilding the complete spatial index for every moved endpoint.
 */
export class HierarchyClearance {
	private nodes: Map<string, NodeItem>;
	private edges: Map<string, Segment>;
	private incident = new Map<string, Set<string>>();
	private parentOf = new Map<string, string>();
	private nodeIndex: SpatialIndex<NodeItem>;
	private edgeIndex: SpatialIndex<Segment>;
	private changedNodes = new Set<string>();
	private changedEdges = new Set<string>();
	private collisions: Collision[] = [];

	private clearanceRadius = (point: RadialPoint) => Math.max(point.nodeRadius * this.nodeRadiusScale, this.spacingRadius?.(point) ?? 0);
	private nodeBounds = (item: NodeItem) => nodeBounds(item, this.clearanceRadius(item.point));

	constructor(private positions: Map<string, RadialPoint>, graph: VisibleWorldGraph, private nodeGap = 4, private nodeRadiusScale = 1, private spacingRadius?: (point: RadialPoint) => number, private branchGap: (point: RadialPoint) => number = () => 0) {
		this.nodes = new Map([...positions].map(([id, point]) => [id, { id, point }]));
		this.edges = new Map();
		for (const edge of graph.hierarchyEdges) {
			const a = positions.get(edge.source), b = positions.get(edge.target);
			if (edge.type !== 'hierarchy' || !a || !b) continue;
			this.parentOf.set(edge.target, edge.source);
			this.edges.set(edge.id, { id: edge.id, source: edge.source, target: edge.target, a, b });
			for (const id of [edge.source, edge.target]) {
				const group = this.incident.get(id) ?? new Set<string>();
				group.add(edge.id);
				this.incident.set(id, group);
			}
		}
		this.nodeIndex = new SpatialIndex([...this.nodes.values()], this.nodeBounds);
		this.edgeIndex = new SpatialIndex([...this.edges.values()], edgeBounds);
	}

	accept(proposed: Map<string, RadialPoint>, protectBranches = true): boolean {
		// Consecutive lane offers often fail on the same pairs. Recheck them
		// against the new coordinates before building any temporary indexes.
		if (this.stillBlocked(proposed, protectBranches)) return false;
		const touchedEdges = new Set<string>();
		for (const id of proposed.keys()) for (const edge of this.incident.get(id) ?? []) touchedEdges.add(edge);
		const nodes = [...proposed].map(([id, point]) => ({ id, point }));
		const edges = [...touchedEdges].map((id) => {
			const edge = this.edges.get(id)!;
			return { ...edge, a: proposed.get(edge.source) ?? edge.a, b: proposed.get(edge.target) ?? edge.b };
		});
		const localNodes = new SpatialIndex(nodes, this.nodeBounds);
		const localEdges = new SpatialIndex(edges, edgeBounds);
		const pendingNodes = new SpatialIndex([...this.changedNodes].filter((id) => !proposed.has(id)).map((id) => this.nodes.get(id)!), this.nodeBounds);
		const pendingEdges = new SpatialIndex([...this.changedEdges].filter((id) => !touchedEdges.has(id)).map((id) => this.edges.get(id)!), edgeBounds);
		const blockedByNode = (bounds: SpatialBounds, test: (node: NodeItem) => boolean, segment?: Segment, padding = 0) =>
			(proposed.size !== this.nodes.size && some(this.nodeIndex, bounds, (n) => !proposed.has(n.id) && !this.changedNodes.has(n.id) && test(n), segment, padding))
			|| some(pendingNodes, bounds, test, segment, padding) || some(localNodes, bounds, test, segment, padding);
		const blockedByEdge = (bounds: SpatialBounds, test: (edge: Segment) => boolean, segment?: Segment, padding = 0) =>
			(touchedEdges.size !== this.edges.size && some(this.edgeIndex, bounds, (e) => !touchedEdges.has(e.id) && !this.changedEdges.has(e.id) && test(e), segment, padding))
			|| some(pendingEdges, bounds, test, segment, padding) || some(localEdges, bounds, test, segment, padding);
		for (const node of nodes) {
			const p = node.point;
			// Whole-family lane moves only protect physical clearance. Match the
			// broad phase to the exact check instead of searching the much wider
			// branch corridor even when branch protection is disabled.
			const branchGap = protectBranches ? this.branchGap(p) : 0;
			if (blockedByNode(expandBounds(pointBounds(p), this.clearanceRadius(p) + Math.max(this.nodeGap, branchGap)), (other) => {
				if (node.id === other.id) return false;
				if (proposed.has(other.id) && node.id > other.id) return false;
				if (this.nodesClear(node, other, protectBranches)) return false;
				this.remember({ kind: 'nodes', a: node.id, b: other.id });
				return true;
			})) return false;
			if (blockedByEdge(expandBounds(pointBounds(p), p.nodeRadius + 2 + branchGap / 2), (edge) =>
				node.id !== edge.source && node.id !== edge.target && !this.nodeEdgeClear(node, edge, protectBranches))) return false;
		}
		for (const edge of edges) {
			// Long radial edges need their narrow rectangle, not a square whose
			// sides both span the edge's length. Exact clearance tests are unchanged.
			const padding = 2 + (protectBranches ? this.branchGap(edge.b) / 2 : 0);
			const bounds = expandBounds(edgeBounds(edge), padding);
			if (blockedByNode(bounds, (node) => {
				// Moving nodes were already checked against every nearby edge above.
				return !proposed.has(node.id) && node.id !== edge.source && node.id !== edge.target && !this.nodeEdgeClear(node, edge, protectBranches);
			}, edge, padding)) return false;
			if (blockedByEdge(bounds, (other) => {
				if (edge.id === other.id || edge.source === other.source || edge.source === other.target || edge.target === other.source || edge.target === other.target) return false;
				if (touchedEdges.has(other.id) && edge.id > other.id) return false;
				if (this.edgesClear(edge, other, protectBranches)) return false;
				this.remember({ kind: 'edges', a: edge.id, b: other.id });
				return true;
			}, edge, padding)) return false;
		}
		for (const [id, point] of proposed) {
			Object.assign(this.positions.get(id)!, point);
			this.changedNodes.add(id);
		}
		for (const id of touchedEdges) this.changedEdges.add(id);
		if (this.changedNodes.size + this.changedEdges.size > Math.max(128, Math.sqrt(this.nodes.size) * 4)) {
			this.nodeIndex = new SpatialIndex([...this.nodes.values()], this.nodeBounds);
			this.edgeIndex = new SpatialIndex([...this.edges.values()], edgeBounds);
			this.changedNodes.clear();
			this.changedEdges.clear();
		}
		return true;
	}

	private nodeEdgeClear(node: NodeItem, edge: Segment, protectBranches: boolean): boolean {
		const distance = distanceToEdge(node.point, edge);
		const body = node.point.nodeRadius + 2;
		const gap = protectBranches ? Math.min(this.branchGap(node.point), this.branchGap(edge.b)) / 2 : 0;
		const clear = distance >= body && (distance >= body + gap || distance + 1e-6 >= distanceToEdge(this.positions.get(node.id)!, this.edges.get(edge.id)!));
		if (!clear) this.remember({ kind: 'node-edge', a: node.id, b: edge.id });
		return clear;
	}

	private nodesClear(node: NodeItem, other: NodeItem, protectBranches: boolean): boolean {
		const p = node.point;
		const distance = Math.hypot(p.x - other.point.x, p.y - other.point.y);
		const sameFamily = this.parentOf.get(node.id) === this.parentOf.get(other.id)
			|| this.parentOf.get(node.id) === other.id || this.parentOf.get(other.id) === node.id;
		const gap = sameFamily || !protectBranches ? this.nodeGap : Math.max(this.nodeGap, Math.min(this.branchGap(p), this.branchGap(other.point)));
		if (distance >= this.clearanceRadius(p) + this.clearanceRadius(other.point) + gap) return true;
		const before = this.positions.get(node.id)!, otherBefore = this.positions.get(other.id)!;
		// Existing overlaps may move intact until their own family is opened.
		return distance + 1e-6 >= Math.hypot(before.x - otherBefore.x, before.y - otherBefore.y);
	}

	private edgesClear(edge: Segment, other: Segment, protectBranches: boolean): boolean {
		if (cross(edge.a, edge.b, other.a) * cross(edge.a, edge.b, other.b) < -1e-6 && cross(other.a, other.b, edge.a) * cross(other.a, other.b, edge.b) < -1e-6) return false;
		const gap = protectBranches ? Math.min(this.branchGap(edge.b), this.branchGap(other.b)) / 2 : 0;
		if (gap > 0) {
			const distance = edgeDistance(edge, other);
			if (distance < gap && distance + 1e-6 < edgeDistance(this.edges.get(edge.id)!, this.edges.get(other.id)!)) return false;
		}
		return true;
	}

	private stillBlocked(proposed: Map<string, RadialPoint>, protectBranches: boolean): boolean {
		return this.collisions.some((collision) => this.collisionBlocks(collision, proposed, protectBranches));
	}

	private remember(collision: Collision): void {
		const index = this.collisions.findIndex((item) => item.kind === collision.kind && item.a === collision.a && item.b === collision.b);
		if (index >= 0) this.collisions.splice(index, 1);
		this.collisions.unshift(collision);
		if (this.collisions.length > 8) this.collisions.pop();
	}

	private collisionBlocks(collision: Collision, proposed: Map<string, RadialPoint>, protectBranches: boolean): boolean {
		const node = (id: string): NodeItem => ({ id, point: proposed.get(id) ?? this.positions.get(id)! });
		const edge = (id: string): Segment => {
			const original = this.edges.get(id)!;
			return { ...original, a: node(original.source).point, b: node(original.target).point };
		};
		const moved = (segment: Segment) => proposed.has(segment.source) || proposed.has(segment.target);
		if (collision.kind === 'nodes') {
			return (proposed.has(collision.a) || proposed.has(collision.b)) && !this.nodesClear(node(collision.a), node(collision.b), protectBranches);
		}
		if (collision.kind === 'node-edge') {
			const segment = edge(collision.b);
			return (proposed.has(collision.a) || moved(segment)) && !this.nodeEdgeClear(node(collision.a), segment, protectBranches);
		}
		const a = edge(collision.a), b = edge(collision.b);
		return (moved(a) || moved(b)) && !this.edgesClear(a, b, protectBranches);
	}
}

function pointBounds(p: RadialPoint): SpatialBounds {
	return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
}

function expandBounds(bounds: SpatialBounds, padding: number): SpatialBounds {
	return { minX: bounds.minX - padding, minY: bounds.minY - padding, maxX: bounds.maxX + padding, maxY: bounds.maxY + padding };
}

function edgeDistance(a: Segment, b: Segment): number {
	return Math.min(distanceToEdge(a.a, b), distanceToEdge(a.b, b), distanceToEdge(b.a, a), distanceToEdge(b.b, a));
}

function nodeBounds({ point: p }: NodeItem, radius: number) {
	const r = radius + 4;
	return { minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r };
}

function edgeBounds({ a, b }: Segment) {
	return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
}

function cross(a: RadialPoint, b: RadialPoint, c: RadialPoint): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function distanceToEdge(p: RadialPoint, { a, b }: Segment): number {
	const dx = b.x - a.x, dy = b.y - a.y;
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-12, dx * dx + dy * dy)));
	return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function some<T>(index: SpatialIndex<T>, bounds: SpatialBounds, test: (item: T) => boolean, segment?: Segment, padding = 0): boolean {
	return segment ? index.someAlongSegment(segment.a, segment.b, padding, test) : index.some(bounds, test);
}
