import { describe, expect, it } from 'vitest';
import { radialNodeLegendItemId, radialNodeLegendLabelKey } from '../src/view/radialNodeLegend';

describe('2D detail node types', () => {
	it.each([
		['root', 'root', 'legend.root'],
		['folder', 'folder', 'legend.folder'],
		['folder-note', 'folder-meta', 'legend.folderMeta'],
		['note', 'file', 'legend.note'],
		['outside-group', 'outside', 'legend.outsideGroup'],
		['outside-note', 'outside-file', 'legend.outsideNote'],
		['unresolved', 'missing', 'legend.unresolvedNote'],
	] as const)('uses the legend entry for %s nodes', (kind, itemId, labelKey) => {
		expect(radialNodeLegendItemId(kind)).toBe(itemId);
		expect(radialNodeLegendLabelKey(kind)).toBe(labelKey);
	});
});
