import type { RadialSettings } from '../settings';
import type { LinkTable, WorldEdge, WorldFileRecord, WorldModel, WorldNode, WorldStats } from './types';
import { ROOT_ID, ROOT_TITLE } from './types';

export function buildWorldMap(
	records: WorldFileRecord[],
	resolvedLinks: LinkTable,
	unresolvedLinks: LinkTable,
	settings: Pick<RadialSettings, 'includeUnresolvedLinks' | 'ignoreFolders'>,
): WorldModel {
	const nodes = new Map<string, WorldNode>();
	const hierarchyEdges: WorldEdge[] = [];
	const linkEdges: WorldEdge[] = [];
	const childrenByParent = new Map<string, string[]>();
	const linkEdgesBySource = new Map<string, WorldEdge[]>();
	const linkEdgesByTarget = new Map<string, WorldEdge[]>();
	const folderRepresentatives = new Map<string, string>();
	let loadedEntries = 0;
	let scannedMarkdown = 0;

	const ignored = (path: string) => shouldIgnorePath(path, settings.ignoreFolders);
	const addNode = (node: WorldNode) => {
		if (nodes.has(node.id) || ignored(node.id)) return;
		nodes.set(node.id, node);
	};

	addNode({
		id: ROOT_ID,
		path: ROOT_ID,
		title: ROOT_TITLE,
		type: 'folder',
		parentId: null,
		depth: 0,
		noteCount: 0,
		linkCount: 0,
		backlinkCount: 0,
		descendantCount: 0,
	});

	const ensureFolder = (folderPath: string): string => {
		const normalized = normalizeVaultPath(folderPath);
		if (!normalized) return ROOT_ID;
		let current = ROOT_ID;
		for (const part of normalized.split('/').filter(Boolean)) {
			const next = current ? `${current}/${part}` : part;
			if (ignored(next)) return current;
			if (!nodes.has(next)) {
				addNode({
					id: next,
					path: next,
					title: basename(next),
					type: 'folder',
					parentId: current,
					depth: depthOfPath(next),
					noteCount: 0,
					linkCount: 0,
					backlinkCount: 0,
					descendantCount: 0,
				});
			}
			current = next;
		}
		return current;
	};

	for (const record of records) {
		loadedEntries++;
		const path = normalizeVaultPath(record.path);
		if (!path || ignored(path)) continue;
		if (record.kind === 'folder') {
			ensureFolder(path);
			continue;
		}
		scannedMarkdown++;
		const parentId = ensureFolder(parentPath(path));
		addNode({
			id: path,
			path,
			title: record.basename || basename(path).replace(/\.md$/i, ''),
			type: 'note',
			parentId,
			depth: depthOfPath(path),
			noteCount: 1,
			linkCount: 0,
			backlinkCount: 0,
			descendantCount: 0,
		});
	}

	identifyFolderRepresentatives(nodes, folderRepresentatives);

	const addLink = (source: string, target: string, weight: number, type: 'link' | 'unresolved-link') => {
		if (source === target || !nodes.has(source) || !nodes.has(target)) return;
		const edge: WorldEdge = {
			id: `${type}:${source}->${target}:${linkEdges.length}`,
			type,
			source,
			target,
			weight,
		};
		linkEdges.push(edge);
		const sourceNode = nodes.get(source);
		const targetNode = nodes.get(target);
		if (sourceNode) sourceNode.linkCount += weight;
		if (targetNode) targetNode.backlinkCount += weight;
		pushMapArray(linkEdgesBySource, source, edge);
		pushMapArray(linkEdgesByTarget, target, edge);
	};

	for (const [source, targets] of Object.entries(resolvedLinks)) {
		if (!nodes.has(source) || ignored(source)) continue;
		for (const [target, count] of Object.entries(targets ?? {})) {
			if (!nodes.has(target) || ignored(target)) continue;
			addLink(source, target, Math.max(1, Number(count) || 1), 'link');
		}
	}

	if (settings.includeUnresolvedLinks) {
		for (const [source, targets] of Object.entries(unresolvedLinks)) {
			if (!nodes.has(source) || ignored(source)) continue;
			for (const [linkText, count] of Object.entries(targets ?? {})) {
				const id = `unresolved:${source}:${linkText}`;
				if (!nodes.has(id)) {
					const sourceNode = nodes.get(source);
					addNode({
						id,
						path: linkText,
						title: linkText,
						type: 'unresolved',
						parentId: sourceNode?.parentId ?? ROOT_ID,
						depth: (sourceNode?.depth ?? 0) + 1,
						noteCount: 0,
						linkCount: 0,
						backlinkCount: 0,
						descendantCount: 0,
					});
				}
				addLink(source, id, Math.max(1, Number(count) || 1), 'unresolved-link');
			}
		}
	}

	buildHierarchy(nodes, hierarchyEdges, childrenByParent);
	computeFolderCounts(nodes);
	const stats: WorldStats = {
		loadedEntries,
		scannedMarkdown,
		folders: [...nodes.values()].filter((node) => node.type === 'folder').length,
		notes: [...nodes.values()].filter((node) => node.type === 'note').length,
		unresolved: [...nodes.values()].filter((node) => node.type === 'unresolved').length,
		hierarchyEdges: hierarchyEdges.length,
		linkEdges: linkEdges.length,
		maxDepth: Math.max(0, ...[...nodes.values()].map((node) => node.depth)),
	};

	return { nodes, hierarchyEdges, linkEdges, childrenByParent, linkEdgesBySource, linkEdgesByTarget, folderRepresentatives, stats };
}

export function compareWorldNodes(a: WorldNode | undefined, b: WorldNode | undefined): number {
	if (!a || !b) return a ? -1 : b ? 1 : 0;
	const typeRank = (node: WorldNode) => (node.type === 'folder' ? 0 : node.type === 'note' ? 1 : node.type === 'external' ? 2 : 3);
	return a.depth - b.depth || typeRank(a) - typeRank(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

export function normalizeVaultPath(path: string): string {
	return String(path || '')
		.trim()
		.replace(/^\/+|\/+$/g, '');
}

export function parentPath(path: string): string {
	const normalized = normalizeVaultPath(path);
	const index = normalized.lastIndexOf('/');
	return index === -1 ? ROOT_ID : normalized.slice(0, index);
}

export function basename(path: string): string {
	const normalized = normalizeVaultPath(path);
	const index = normalized.lastIndexOf('/');
	return index === -1 ? normalized : normalized.slice(index + 1);
}

export function depthOfPath(path: string): number {
	const normalized = normalizeVaultPath(path);
	return normalized ? normalized.split('/').filter(Boolean).length : 0;
}

export function shouldIgnorePath(path: string, ignoreFolders: string[]): boolean {
	const normalized = normalizeVaultPath(path);
	if (!normalized) return false;
	return ignoreFolders.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function identifyFolderRepresentatives(nodes: Map<string, WorldNode>, folderRepresentatives: Map<string, string>): void {
	const notesByParent = new Map<string, WorldNode[]>();
	for (const node of nodes.values()) {
		if (node.type === 'note' && node.parentId !== null) pushMapArray(notesByParent, node.parentId, node);
	}
	for (const folder of nodes.values()) {
		if (folder.type !== 'folder' || folder.id === ROOT_ID) continue;
		const folderTitle = comparableTitle(folder.title);
		const representative = (notesByParent.get(folder.id) ?? []).find((note) => comparableTitle(note.title) === folderTitle);
		if (!representative) continue;
		folder.representativeFile = representative.id;
		representative.isRepresentativeFile = true;
		representative.representativeFor = folder.id;
		folderRepresentatives.set(folder.id, representative.id);
	}
}

function buildHierarchy(
	nodes: Map<string, WorldNode>,
	hierarchyEdges: WorldEdge[],
	childrenByParent: Map<string, string[]>,
): void {
	for (const node of nodes.values()) {
		if (node.parentId === null || !nodes.has(node.parentId)) continue;
		hierarchyEdges.push({
			id: `hierarchy:${node.parentId}->${node.id}`,
			type: 'hierarchy',
			source: node.parentId,
			target: node.id,
			weight: 1,
		});
		pushMapArray(childrenByParent, node.parentId, node.id);
	}
	for (const children of childrenByParent.values()) {
		children.sort((a, b) => compareWorldNodes(nodes.get(a), nodes.get(b)));
	}
}

function computeFolderCounts(nodes: Map<string, WorldNode>): void {
	const sorted = [...nodes.values()].sort((a, b) => b.depth - a.depth);
	for (const node of sorted) {
		node.descendantCount = node.type === 'note' ? 1 : node.noteCount;
		if (!node.parentId || !nodes.has(node.parentId)) continue;
		const parent = nodes.get(node.parentId);
		if (!parent) continue;
		const subtreeNotes = node.type === 'note' ? 1 : node.noteCount;
		parent.descendantCount += subtreeNotes;
		parent.noteCount += subtreeNotes;
		parent.linkCount += node.linkCount;
		parent.backlinkCount += node.backlinkCount;
	}
}

function comparableTitle(value: string): string {
	return value.replace(/\.md$/i, '').trim().toLowerCase();
}

function pushMapArray<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const values = map.get(key);
	if (values) values.push(value);
	else map.set(key, [value]);
}
