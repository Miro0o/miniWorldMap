import {
	DEFAULT_RADIAL_SETTINGS,
	MAX_EXTERNAL_LINK_ANCHOR_LIMIT,
	MAX_LINK_LIMIT,
	MAX_RENDER_NODE_LIMIT,
	clampNumber,
	hoverHighlightsNoteLinks,
	type RadialSettings,
} from '../settings';
import { basename, compareWorldNodes, parentPath } from './buildWorldMap';
import type { VisibleGraphState, VisibleWorldGraph, WorldEdge, WorldModel, WorldNode } from './types';
import { ROOT_ID } from './types';

export function defaultVisibleGraphState(settings: RadialSettings): VisibleGraphState {
	const hiddenLegendItems = settings.hiddenLegendItems.slice();
	const hidden = new Set(hiddenLegendItems);
	return {
		mode: 'atlas',
		rootPath: ROOT_ID,
		focusPath: null,
		search: '',
		atlasDepth: settings.atlasDepth,
		focusSiblingLimit: settings.focusSiblingLimit,
		nodeLimit: settings.renderNodeLimit,
		linkLimit: settings.linkLimit,
		externalLinkAnchorLimit: settings.externalLinkAnchorLimit,
		showLinkOverlay: settings.showLinkOverlay || !hidden.has('link'),
		showExternalLinks: settings.showExternalLinks,
		externalDetailMode: settings.externalDetailMode,
		showCompleteRoot: false,
		hoverHighlightMode: settings.hoverHighlightMode,
		pinNeedsHoverLinks: false,
		selectedNodeId: null,
		selectedLink: null,
		hiddenLegendItems,
		labelVisibility: settings.labelVisibility,
	};
}

export function buildVisibleWorldGraph(
	model: WorldModel,
	state: VisibleGraphState,
	settings: RadialSettings = DEFAULT_RADIAL_SETTINGS,
): VisibleWorldGraph {
	if (state.mode === 'focus') return buildFocusGraph(model, state, settings);
	return buildAtlasGraph(model, state, settings);
}

export function visualNodeId(model: WorldModel, id: string | null | undefined): string | null {
	if (id === null || id === undefined) return null;
	const node = model.nodes.get(id);
	return node?.isRepresentativeFile && node.representativeFor && model.nodes.has(node.representativeFor)
		? node.representativeFor
		: id;
}

function buildAtlasGraph(model: WorldModel, state: VisibleGraphState, settings: RadialSettings): VisibleWorldGraph {
	const rootId = model.nodes.has(state.rootPath) ? state.rootPath : ROOT_ID;
	const rootDepth = model.nodes.get(rootId)?.depth ?? 0;
	const maxDepth = clampNumber(state.atlasDepth, 1, 80, settings.atlasDepth);
	const query = normalizedQuery(state.search);
	const visible = new Set<string>();

	const stack = [rootId];
	while (stack.length > 0) {
		const id = stack.pop();
		const node = id ? model.nodes.get(id) : model.nodes.get(ROOT_ID);
		if (!node) continue;
		const relDepth = Math.max(0, node.depth - rootDepth);
		const withinDepth = relDepth <= maxDepth;
		const matches = query.length > 0 && nodeMatches(node, query);
		if (withinDepth || matches) {
			visible.add(node.id);
			if (matches) addAncestors(model, node.id, visible, rootId);
		}
		if (withinDepth || matches) {
			for (const child of [...(model.childrenByParent.get(node.id) ?? [])].reverse()) stack.push(child);
		}
	}

	if (query) {
		for (const node of model.nodes.values()) {
			if (!nodeMatches(node, query)) continue;
			visible.add(node.id);
			addAncestors(model, node.id, visible, rootId);
		}
	}

	addDirectFilesForVisibleFolders(model, visible);
	return materializeVisibleGraph(model, visible, rootId, state, settings, null);
}

function buildFocusGraph(model: WorldModel, state: VisibleGraphState, settings: RadialSettings): VisibleWorldGraph {
	const activePath = state.focusPath && model.nodes.has(state.focusPath) ? state.focusPath : firstNote(model);
	const visible = new Set<string>([ROOT_ID]);
	const siblingLimit = clampNumber(state.focusSiblingLimit, 10, 1000, settings.focusSiblingLimit);

	if (activePath) {
		visible.add(activePath);
		addAncestors(model, activePath, visible, ROOT_ID);
		const active = model.nodes.get(activePath);
		if (active?.parentId) {
			for (const sibling of (model.childrenByParent.get(active.parentId) ?? []).slice(0, siblingLimit)) visible.add(sibling);
		}
		const connected = [
			...(model.linkEdgesBySource.get(activePath) ?? []),
			...(model.linkEdgesByTarget.get(activePath) ?? []),
		].sort((a, b) => b.weight - a.weight);
		for (const edge of connected.slice(0, Math.max(30, siblingLimit))) {
			visible.add(edge.source);
			visible.add(edge.target);
			addAncestors(model, edge.source, visible, ROOT_ID);
			addAncestors(model, edge.target, visible, ROOT_ID);
		}
	}

	const query = normalizedQuery(state.search);
	if (query) {
		for (const node of model.nodes.values()) {
			if (!nodeMatches(node, query)) continue;
			visible.add(node.id);
			addAncestors(model, node.id, visible, ROOT_ID);
		}
	}
	addDirectFilesForVisibleFolders(model, visible);
	return materializeVisibleGraph(model, visible, ROOT_ID, state, settings, activePath);
}

function materializeVisibleGraph(
	model: WorldModel,
	visible: Set<string>,
	rootId: string,
	state: VisibleGraphState,
	settings: RadialSettings,
	focusId: string | null,
): VisibleWorldGraph {
	let nodes = [...visible].map((id) => model.nodes.get(id)).filter((node): node is WorldNode => Boolean(node));
	nodes.sort(compareWorldNodes);
	const budget = applyNodeBudget(model, nodes, rootId, state, settings, focusId);
	nodes = foldRepresentativeNodes(model, budget.nodes);

	const nodeSet = new Set(nodes.map((node) => node.id));
	const hierarchyEdges = model.hierarchyEdges.filter((edge) => nodeSet.has(edge.source) && nodeSet.has(edge.target));
	const bundle = aggregateVisibleLinkEdges(model, nodeSet, state, settings, rootId);
	nodes = nodes.concat(bundle.externalNodes);
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	return {
		nodes,
		nodesById,
		hierarchyEdges: hierarchyEdges.concat(bundle.externalHierarchyEdges),
		linkEdges: bundle.linkEdges,
		hoverLinkEdges: bundle.hoverLinkEdges,
		rootId,
		focusId: visualNodeId(model, focusId),
		hiddenNodeCount: budget.hiddenNodeCount,
		externalNodeCount: bundle.externalNodes.length,
		externalFileCount: bundle.externalNodes.filter((node) => node.externalProxy).length,
		externalGroupCount: bundle.externalNodes.filter((node) => node.type === 'external' && !node.externalProxy).length,
	};
}

function aggregateVisibleLinkEdges(
	model: WorldModel,
	visible: Set<string>,
	state: VisibleGraphState,
	settings: RadialSettings,
	rootId: string,
): {
	linkEdges: WorldEdge[];
	hoverLinkEdges: WorldEdge[];
	externalNodes: WorldNode[];
	externalHierarchyEdges: WorldEdge[];
} {
	const hidden = new Set(state.hiddenLegendItems);
	const wantsInternal = state.showLinkOverlay && !hidden.has('link');
	const wantsUnresolved = wantsInternal && !hidden.has('dashed-link');
	const wantsExternalOverlay = !hidden.has('outside-link');
	const wantsExternalNodes = !hidden.has('outside') || !hidden.has('outside-file');
	const needsHoverLinks = hoverHighlightsNoteLinks(state.hoverHighlightMode) || state.pinNeedsHoverLinks;
	const showExternal = state.showExternalLinks && rootId !== ROOT_ID && (wantsExternalNodes || wantsExternalOverlay);
	if (!wantsInternal && !wantsUnresolved && !needsHoverLinks && !showExternal) {
		return { linkEdges: [], hoverLinkEdges: [], externalNodes: [], externalHierarchyEdges: [] };
	}

	const aggregate = new Map<string, WorldEdge>();
	const externalNodes = new Map<string, WorldNode>();
	const externalHierarchyEdges: WorldEdge[] = [];
	const externalLimit = clampNumber(
		state.externalLinkAnchorLimit,
		0,
		MAX_EXTERNAL_LINK_ANCHOR_LIMIT,
		settings.externalLinkAnchorLimit,
	);
	const externalContext = { fileCount: 0, overflowId: null as string | null };

	for (const raw of model.linkEdges) {
		let source = nearestVisibleAncestor(model, raw.source, visible, rootId);
		let target = nearestVisibleAncestor(model, raw.target, visible, rootId);
		let externalCount = 0;

		if (showExternal) {
			if (!source && target) {
				source = externalEndpointFor(model, raw.source, rootId, externalNodes, externalHierarchyEdges, externalLimit, externalContext, shouldUseExactExternal(raw, state, target));
				if (source) externalCount = 1;
			}
			if (source && !target) {
				target = externalEndpointFor(model, raw.target, rootId, externalNodes, externalHierarchyEdges, externalLimit, externalContext, shouldUseExactExternal(raw, state, source));
				if (target) externalCount = 1;
			}
		}

		if (!source || !target || source === target) continue;
		const key = `${source}->${target}`;
		const edge = aggregate.get(key) ?? {
			id: `visible-link:${key}`,
			type: 'visible-link',
			source,
			target,
			weight: 0,
			rawCount: 0,
			unresolvedCount: 0,
			externalCount: 0,
		};
		edge.weight += raw.weight;
		edge.rawCount = (edge.rawCount ?? 0) + 1;
		if (raw.type === 'unresolved-link') edge.unresolvedCount = (edge.unresolvedCount ?? 0) + 1;
		edge.externalCount = (edge.externalCount ?? 0) + externalCount;
		aggregate.set(key, edge);
	}

	const all = [...aggregate.values()].sort((a, b) => linkRenderScore(b) - linkRenderScore(a));
	const allowsVisibleLink = (edge: WorldEdge) => {
		if (edge.externalCount) return wantsExternalOverlay && (!edge.unresolvedCount || wantsUnresolved);
		if (edge.unresolvedCount) return wantsUnresolved;
		return wantsInternal;
	};
	const allowsHoverLink = (edge: WorldEdge) => {
		if (edge.externalCount) return showExternal && wantsExternalOverlay && (!edge.unresolvedCount || !hidden.has('dashed-link'));
		if (edge.unresolvedCount) return !hidden.has('dashed-link');
		return !hidden.has('link');
	};
	const limit = state.showCompleteRoot
		? MAX_LINK_LIMIT
		: clampNumber(state.linkLimit, 0, MAX_LINK_LIMIT, settings.linkLimit);
	const linkEdges = all.filter(allowsVisibleLink).slice(0, limit);
	const hoverLinkEdges = state.showCompleteRoot ? linkEdges : all.filter(allowsHoverLink);
	const usedExternalIds = new Set<string>();
	for (const edge of showExternal ? all.filter((e) => e.externalCount) : needsHoverLinks ? hoverLinkEdges : []) {
		if (externalNodes.has(edge.source)) usedExternalIds.add(edge.source);
		if (externalNodes.has(edge.target)) usedExternalIds.add(edge.target);
	}

	const collected = collectExternalNodes(usedExternalIds, externalNodes);
	return {
		linkEdges,
		hoverLinkEdges,
		externalNodes: collected,
		externalHierarchyEdges: externalHierarchyEdges.filter((edge) => usedExternalIds.has(edge.target)),
	};
}

function applyNodeBudget(
	model: WorldModel,
	nodes: WorldNode[],
	rootId: string,
	state: VisibleGraphState,
	settings: RadialSettings,
	focusId: string | null,
): { nodes: WorldNode[]; hiddenNodeCount: number } {
	if (state.showCompleteRoot && nodes.length <= MAX_RENDER_NODE_LIMIT) return { nodes, hiddenNodeCount: 0 };
	const limit = clampNumber(state.nodeLimit, 200, MAX_RENDER_NODE_LIMIT, settings.renderNodeLimit);
	if (nodes.length <= limit) return { nodes, hiddenNodeCount: 0 };

	const candidates = nodes
		.slice()
		.sort((a, b) => nodeRenderScore(b, rootId, focusId, state.search) - nodeRenderScore(a, rootId, focusId, state.search));
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const keep = new Set([rootId, focusId].filter((id): id is string => id !== null && id !== undefined));
	addDirectFileChildren(model, rootId, keep, limit, state.showCompleteRoot ? 128 : 64);
	for (const node of candidates) {
		if (keep.size >= limit) break;
		addWithAncestors(model, node.id, keep, nodeById, limit);
		if (node.type === 'folder') addDirectFileChildren(model, node.id, keep, limit, state.showCompleteRoot ? 18 : 8);
	}
	const kept = nodes.filter((node) => keep.has(node.id));
	return { nodes: kept, hiddenNodeCount: Math.max(0, nodes.length - kept.length) };
}

function foldRepresentativeNodes(model: WorldModel, nodes: WorldNode[]): WorldNode[] {
	const visibleIds = new Set(nodes.map((node) => node.id));
	return nodes.filter((node) => !node.isRepresentativeFile || !node.representativeFor || !visibleIds.has(node.representativeFor));
}

function addDirectFilesForVisibleFolders(model: WorldModel, visible: Set<string>): void {
	for (const id of [...visible]) {
		const node = model.nodes.get(id);
		if (!node || node.type !== 'folder') continue;
		for (const childId of model.childrenByParent.get(id) ?? []) {
			const child = model.nodes.get(childId);
			if (child?.type === 'note' || child?.type === 'unresolved') visible.add(childId);
		}
	}
}

function addAncestors(model: WorldModel, id: string, visible: Set<string>, stopId: string): void {
	let current = model.nodes.get(id);
	while (current && current.parentId !== null) {
		visible.add(current.id);
		if (current.id === stopId) break;
		current = model.nodes.get(current.parentId);
	}
	visible.add(stopId || ROOT_ID);
}

function addWithAncestors(
	model: WorldModel,
	id: string,
	keep: Set<string>,
	nodeById: Map<string, WorldNode>,
	limit: number,
): void {
	const chain: string[] = [];
	let current = nodeById.get(id);
	while (current && !keep.has(current.id)) {
		chain.push(current.id);
		current = current.parentId === null ? undefined : nodeById.get(current.parentId);
	}
	for (let i = chain.length - 1; i >= 0 && keep.size < limit; i--) keep.add(chain[i] ?? ROOT_ID);
}

function addDirectFileChildren(model: WorldModel, parentId: string, keep: Set<string>, limit: number, perParentLimit: number): void {
	let added = 0;
	for (const childId of model.childrenByParent.get(parentId) ?? []) {
		if (keep.size >= limit || added >= perParentLimit) return;
		const child = model.nodes.get(childId);
		if (child?.type !== 'note' && child?.type !== 'unresolved') continue;
		keep.add(childId);
		added++;
	}
}

function nearestVisibleAncestor(model: WorldModel, id: string, visible: Set<string>, rootId: string): string | null {
	let current = model.nodes.get(id);
	while (current) {
		if (visible.has(current.id)) return current.id;
		if (current.id === rootId) return rootId;
		current = current.parentId === null ? undefined : model.nodes.get(current.parentId);
	}
	return visible.has(ROOT_ID) ? ROOT_ID : null;
}

function externalEndpointFor(
	model: WorldModel,
	nodeId: string,
	rootId: string,
	externalNodes: Map<string, WorldNode>,
	externalHierarchyEdges: WorldEdge[],
	limit: number,
	context: { fileCount: number; overflowId: string | null },
	exact: boolean,
): string | null {
	const node = model.nodes.get(nodeId);
	if (!node) return null;
	const anchorPath = externalAnchorPath(node, rootId);
	if (!anchorPath) return null;
	const groupId = externalGroupFor(model, anchorPath, rootId, externalNodes);
	if (!exact || (node.type !== 'note' && node.type !== 'unresolved')) return groupId;
	if (externalNodes.has(node.id)) return node.id;
	if (context.fileCount >= limit) return externalOverflowFor(rootId, groupId, externalNodes, externalHierarchyEdges, context);

	externalNodes.set(node.id, { ...node, externalProxy: true, externalParentId: groupId, externalAnchorPath: anchorPath });
	context.fileCount++;
	externalHierarchyEdges.push({
		id: `external-hierarchy:${groupId}->${node.id}`,
		type: 'external-hierarchy',
		source: groupId,
		target: node.id,
		weight: 1,
	});
	return node.id;
}

function externalGroupFor(model: WorldModel, anchorPath: string, rootId: string, externalNodes: Map<string, WorldNode>): string {
	const id = `external-group:${rootId}:${anchorPath}`;
	if (!externalNodes.has(id)) {
		const anchor = model.nodes.get(anchorPath);
		externalNodes.set(id, {
			id,
			path: anchorPath,
			title: `Outside: ${anchor?.title ?? basename(anchorPath)}`,
			type: 'external',
			parentId: null,
			depth: (model.nodes.get(rootId)?.depth ?? 0) + 1,
			noteCount: anchor?.noteCount ?? anchor?.descendantCount ?? 0,
			linkCount: 0,
			backlinkCount: 0,
			descendantCount: anchor?.descendantCount ?? anchor?.noteCount ?? 0,
			externalAnchorPath: anchorPath,
		});
	}
	return id;
}

function externalOverflowFor(
	rootId: string,
	groupId: string,
	externalNodes: Map<string, WorldNode>,
	externalHierarchyEdges: WorldEdge[],
	context: { overflowId: string | null },
): string {
	if (!context.overflowId) {
		context.overflowId = `external-overflow:${rootId}`;
		externalNodes.set(context.overflowId, {
			id: context.overflowId,
			path: 'outside current root',
			title: 'More outside files',
			type: 'external',
			parentId: null,
			depth: 1,
			noteCount: 0,
			linkCount: 0,
			backlinkCount: 0,
			descendantCount: 0,
			externalProxy: true,
			externalParentId: groupId,
			externalAnchorPath: null,
		});
		externalHierarchyEdges.push({
			id: `external-hierarchy:${groupId}->${context.overflowId}`,
			type: 'external-hierarchy',
			source: groupId,
			target: context.overflowId,
			weight: 1,
		});
	}
	return context.overflowId;
}

function collectExternalNodes(ids: Set<string>, externalNodes: Map<string, WorldNode>): WorldNode[] {
	const collected = new Map<string, WorldNode>();
	for (const id of ids) {
		const node = externalNodes.get(id);
		if (!node) continue;
		if (node.externalParentId && externalNodes.has(node.externalParentId)) {
			const parent = externalNodes.get(node.externalParentId);
			if (parent) collected.set(parent.id, parent);
		}
		collected.set(id, node);
	}
	return [...collected.values()].sort(compareWorldNodes);
}

function shouldUseExactExternal(edge: WorldEdge, state: VisibleGraphState, visibleEndpoint: string): boolean {
	if (state.externalDetailMode === 'exact') return true;
	if (state.externalDetailMode === 'grouped') return false;
	if (state.selectedNodeId && (edge.source === state.selectedNodeId || edge.target === state.selectedNodeId || visibleEndpoint === state.selectedNodeId)) {
		return true;
	}
	const selected = state.selectedLink;
	return Boolean(
		selected &&
			(selected.source === visibleEndpoint ||
				selected.target === visibleEndpoint ||
				selected.source === edge.source ||
				selected.target === edge.target),
	);
}

function externalAnchorPath(node: WorldNode, rootId: string): string {
	const nodePath = node.type === 'unresolved' ? parentPath(node.path) : node.path;
	const pathParts = nodePath.split('/').filter(Boolean);
	if (!rootId) return pathParts[0] ?? nodePath;
	const rootParts = rootId.split('/').filter(Boolean);
	let common = 0;
	while (common < rootParts.length && common < pathParts.length && rootParts[common] === pathParts[common]) common++;
	return common < rootParts.length ? rootParts.slice(0, common + 1).join('/') : pathParts.slice(0, common + 1).join('/');
}

function firstNote(model: WorldModel): string | null {
	return [...model.nodes.values()].find((node) => node.type === 'note')?.id ?? null;
}

function normalizedQuery(value: string): string {
	return value.trim().toLowerCase();
}

function nodeMatches(node: WorldNode, query: string): boolean {
	return node.title.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
}

function nodeRenderScore(node: WorldNode, rootId: string, focusId: string | null, query: string): number {
	let score = 0;
	if (node.id === rootId) score += 1_000_000;
	if (node.id === focusId) score += 900_000;
	if (query && nodeMatches(node, normalizedQuery(query))) score += 100_000;
	if (node.type === 'folder') score += 5000 + Math.min(4000, Math.log2((node.noteCount || node.descendantCount || 1) + 1) * 720);
	if (node.type === 'note') score += 1000 + Math.min(3000, Math.log2((node.linkCount || 0) + (node.backlinkCount || 0) + 1) * 520);
	if (node.type === 'unresolved') score += 350;
	return score - node.depth * 3;
}

function linkRenderScore(edge: WorldEdge): number {
	return (
		(edge.weight || 1) * 10 +
		(edge.rawCount || 0) * 4 +
		(edge.externalCount || 0) * 25 +
		(edge.unresolvedCount || 0) * 8
	);
}
