import { ROOT_ID, type VisibleWorldGraph, type WorldModel } from './types';
import { visualNodeId } from './visibleGraph';

/** Full subtree totals in map-node units, independent of display budgets.
 * Folder notes share their folder's node. Keep file/reference counts separate
 * so changing the statistics cannot affect layout weights or geometry.
 */
export function buildSubtreeNodeCounts(model: WorldModel): Map<string, number> {
	const counts = new Map([...model.nodes.keys()].map((id) => [id, 1]));
	const nodes = [...model.nodes.values()].sort((a, b) => b.depth - a.depth);
	for (const node of nodes) {
		if (node.parentId === null || !counts.has(node.parentId)) continue;
		const contribution = visualNodeId(model, node.id) === node.parentId ? 0 : counts.get(node.id)!;
		counts.set(node.parentId, counts.get(node.parentId)! + contribution);
	}
	return counts;
}

/** Count the filtered graph passed to the renderer, including synthetic nodes.
 * Missing targets belong to their source's folder, not their link-text path.
 */
export function renderedNodeCounts(graph: VisibleWorldGraph | null, rootId = graph?.rootId ?? ROOT_ID) {
	const counts = { inside: 0, outside: 0, folders: 0, notes: 0, missing: 0 };
	for (const node of graph?.nodes ?? []) {
		const path = node.type === 'unresolved' ? node.parentId : node.id;
		const inside = !node.externalProxy && node.type !== 'external' && path !== null
			&& (rootId === ROOT_ID || path === rootId || path.startsWith(`${rootId}/`));
		if (!inside) { counts.outside++; continue; }
		counts.inside++;
		if (node.type === 'folder') counts.folders++;
		else if (node.type === 'note') counts.notes++;
		else if (node.type === 'unresolved') counts.missing++;
	}
	return counts;
}
