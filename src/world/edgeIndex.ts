import type { WorldEdge } from './types';

/** Preserve input order, including duplicate edges, for identical traversal results. */
export function indexIncidentEdges(edges: readonly WorldEdge[]): Map<string, WorldEdge[]> {
	const index = new Map<string, WorldEdge[]>();
	const add = (id: string, edge: WorldEdge) => {
		const list = index.get(id);
		if (list) list.push(edge);
		else index.set(id, [edge]);
	};
	for (const edge of edges) {
		add(edge.source, edge);
		if (edge.target !== edge.source) add(edge.target, edge);
	}
	return index;
}
