import { LEGEND_ITEM_DEFINITIONS } from '../settings';
import type { RadialNodeColorKind } from '../render/RadialRenderer';

export type RadialNodeLegendItemId = 'root' | 'folder' | 'folder-meta' | 'file' | 'outside' | 'outside-file' | 'missing';

const LEGEND_ID_BY_NODE_KIND: Record<RadialNodeColorKind, RadialNodeLegendItemId> = {
	root: 'root',
	folder: 'folder',
	'folder-note': 'folder-meta',
	note: 'file',
	'outside-group': 'outside',
	'outside-note': 'outside-file',
	unresolved: 'missing',
};

export function radialNodeLegendItemId(kind: RadialNodeColorKind): RadialNodeLegendItemId {
	return LEGEND_ID_BY_NODE_KIND[kind];
}

export function radialNodeLegendLabelKey(kind: RadialNodeColorKind): string {
	const id = radialNodeLegendItemId(kind);
	return LEGEND_ITEM_DEFINITIONS.find(([legendId]) => legendId === id)?.[1] ?? 'legend.note';
}
