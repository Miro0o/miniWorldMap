import type { HoverHighlightMode } from '../settings';
import type { RadialActiveState } from '../render/RadialRenderer';
import type { VisibleWorldGraph, WorldEdge } from '../world/types';
import { indexIncidentEdges } from '../world/edgeIndex';

export interface HighlightIndex {
	incidentLinks: Map<string, WorldEdge[]>;
	parentByChild: Map<string, WorldEdge>;
	childrenByParent: Map<string, WorldEdge[]>;
}

export function createHighlightIndex(graph: VisibleWorldGraph): HighlightIndex {
	const parentByChild = new Map(graph.hierarchyEdges.map((edge) => [edge.target, edge]));
	const childrenByParent = new Map<string, WorldEdge[]>();
	for (const edge of graph.hierarchyEdges) {
		const list = childrenByParent.get(edge.source);
		if (list) list.push(edge);
		else childrenByParent.set(edge.source, [edge]);
	}
	return {
		incidentLinks: indexIncidentEdges([...graph.linkEdges, ...graph.hoverLinkEdges]),
		parentByChild,
		childrenByParent,
	};
}

export function addHierarchyHighlights(
	index: HighlightIndex,
	nodeId: string,
	mode: HoverHighlightMode,
	state: RadialActiveState,
): void {
	if (mode === 'none' || mode === 'note-links') return;
	const { parentByChild, childrenByParent } = index;
	const addEdge = (edge: WorldEdge) => {
		state.highlightedEdges.add(edge.id);
		state.relatedNodes.add(edge.source);
		state.relatedNodes.add(edge.target);
		state.labelNodes.add(edge.source);
		state.labelNodes.add(edge.target);
	};
	if (mode === 'hierarchy-parents' || mode === 'hierarchy-parents-direct' || mode === 'hierarchy-all' || mode === 'all-links') {
		let edge = parentByChild.get(nodeId);
		while (edge) {
			addEdge(edge);
			edge = parentByChild.get(edge.source);
		}
	}
	if (mode === 'hierarchy-direct-children' || mode === 'hierarchy-parents-direct' || mode === 'hierarchy-all' || mode === 'all-links') {
		for (const edge of childrenByParent.get(nodeId) ?? []) addEdge(edge);
	}
	if (mode === 'hierarchy-descendants' || mode === 'hierarchy-all' || mode === 'all-links') {
		const stack = [...(childrenByParent.get(nodeId) ?? [])];
		while (stack.length > 0) {
			const edge = stack.pop();
			if (!edge) continue;
			addEdge(edge);
			stack.push(...(childrenByParent.get(edge.target) ?? []));
		}
	}
}

