import { hoverHierarchyMode, type HoverHighlightMode } from '../settings';
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
	const hierarchy = hoverHierarchyMode(mode);
	if (!hierarchy) return;
	const { parentByChild, childrenByParent } = index;
	const addEdge = (edge: WorldEdge) => {
		state.highlightedEdges.add(edge.id);
		state.relatedNodes.add(edge.source);
		state.relatedNodes.add(edge.target);
		state.labelNodes.add(edge.source);
		state.labelNodes.add(edge.target);
	};
	if (hierarchy === 'hierarchy-parents' || hierarchy === 'hierarchy-parents-direct' || hierarchy === 'hierarchy-all') {
		let edge = parentByChild.get(nodeId);
		while (edge) {
			addEdge(edge);
			edge = parentByChild.get(edge.source);
		}
	}
	if (hierarchy === 'hierarchy-direct-children' || hierarchy === 'hierarchy-parents-direct' || hierarchy === 'hierarchy-all') {
		for (const edge of childrenByParent.get(nodeId) ?? []) addEdge(edge);
	}
	if (hierarchy === 'hierarchy-descendants' || hierarchy === 'hierarchy-all') {
		const stack = [...(childrenByParent.get(nodeId) ?? [])];
		while (stack.length > 0) {
			const edge = stack.pop();
			if (!edge) continue;
			addEdge(edge);
			stack.push(...(childrenByParent.get(edge.target) ?? []));
		}
	}
}
