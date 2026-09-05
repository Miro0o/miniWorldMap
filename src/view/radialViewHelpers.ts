import type { VisibleWorldGraph, WorldEdge, WorldNode } from '../world/types';

export function animationFrames(count: number): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		let timer = 0;
		const finish = () => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			resolve();
		};
		timer = window.setTimeout(finish, 96);
		let remaining = Math.max(0, count);
		const step = () => {
			if (done) return;
			remaining--;
			if (remaining <= 0) {
				finish();
				return;
			}
			window.requestAnimationFrame(step);
		};
		if (remaining <= 0) finish();
		else window.requestAnimationFrame(step);
	});
}

export function filterLegendGraph(graph: VisibleWorldGraph, hidden: Set<string>): VisibleWorldGraph {
	if (hidden.size === 0) return graph;
	const keepNode = (node: WorldNode) => {
		if (node.id === graph.rootId && hidden.has('root')) return false;
		if (node.externalProxy && hidden.has('outside-file')) return false;
		if (node.type === 'external' && !node.externalProxy && hidden.has('outside')) return false;
		if (node.type === 'unresolved' && hidden.has('missing')) return false;
		if (node.type === 'folder' && node.representativeFile && hidden.has('folder-meta')) return false;
		if (node.type === 'folder' && !node.representativeFile && hidden.has('folder')) return false;
		if (node.type === 'note' && hidden.has('file')) return false;
		return true;
	};
	const nodes = graph.nodes.filter(keepNode);
	const ids = new Set(nodes.map((node) => node.id));
	const keepEdge = (edge: WorldEdge) => ids.has(edge.source) && ids.has(edge.target);
	const hierarchyEdges = hidden.has('tree') ? [] : graph.hierarchyEdges.filter(keepEdge);
	const keepLinkEdge = (edge: WorldEdge) => {
		if (!keepEdge(edge)) return false;
		if (edge.externalCount && hidden.has('outside-link')) return false;
		if (edge.unresolvedCount && hidden.has('dashed-link')) return false;
		return Boolean(edge.externalCount) || !hidden.has('link');
	};
	const keepHoverLinkEdge = (edge: WorldEdge) => {
		if (!keepEdge(edge)) return false;
		if (edge.externalCount && hidden.has('outside-link')) return false;
		if (edge.unresolvedCount && hidden.has('dashed-link')) return false;
		return true;
	};
	const linkEdges = graph.linkEdges.filter(keepLinkEdge);
	const hoverLinkEdges = graph.hoverLinkEdges.filter(keepHoverLinkEdge);
	return { ...graph, nodes, nodesById: new Map(nodes.map((node) => [node.id, node])), hierarchyEdges, linkEdges, hoverLinkEdges };
}
