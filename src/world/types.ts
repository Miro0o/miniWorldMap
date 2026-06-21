import type { ExternalDetailMode, HoverHighlightMode, LabelVisibility } from '../settings';

export const ROOT_ID = '';
export const ROOT_TITLE = 'Vault';

export type WorldNodeType = 'folder' | 'note' | 'unresolved' | 'external';

export interface WorldNode {
	id: string;
	path: string;
	title: string;
	type: WorldNodeType;
	parentId: string | null;
	depth: number;
	noteCount: number;
	linkCount: number;
	backlinkCount: number;
	descendantCount: number;
	representativeFile?: string;
	isRepresentativeFile?: boolean;
	representativeFor?: string;
	externalProxy?: boolean;
	externalParentId?: string;
	externalAnchorPath?: string | null;
}

export interface WorldEdge {
	id: string;
	type: 'hierarchy' | 'external-hierarchy' | 'link' | 'unresolved-link' | 'visible-link';
	source: string;
	target: string;
	weight: number;
	rawCount?: number;
	unresolvedCount?: number;
	externalCount?: number;
}

export interface WorldStats {
	loadedEntries: number;
	scannedMarkdown: number;
	folders: number;
	notes: number;
	unresolved: number;
	hierarchyEdges: number;
	linkEdges: number;
	maxDepth: number;
}

export interface WorldModel {
	nodes: Map<string, WorldNode>;
	hierarchyEdges: WorldEdge[];
	linkEdges: WorldEdge[];
	childrenByParent: Map<string, string[]>;
	linkEdgesBySource: Map<string, WorldEdge[]>;
	linkEdgesByTarget: Map<string, WorldEdge[]>;
	folderRepresentatives: Map<string, string>;
	stats: WorldStats;
}

export interface WorldFileRecord {
	path: string;
	basename: string;
	kind: 'folder' | 'note';
	size?: number;
}

export type LinkTable = Record<string, Record<string, number>>;

export interface VisibleGraphState {
	mode: 'atlas' | 'focus';
	rootPath: string;
	focusPath: string | null;
	search: string;
	atlasDepth: number;
	focusSiblingLimit: number;
	nodeLimit: number;
	linkLimit: number;
	externalLinkAnchorLimit: number;
	showLinkOverlay: boolean;
	showExternalLinks: boolean;
	externalDetailMode: ExternalDetailMode;
	showCompleteRoot: boolean;
	hoverHighlightMode: HoverHighlightMode;
	pinNeedsHoverLinks: boolean;
	selectedNodeId: string | null;
	selectedLink: WorldEdge | null;
	hiddenLegendItems: string[];
	labelVisibility: LabelVisibility;
}

export interface VisibleWorldGraph {
	nodes: WorldNode[];
	nodesById: Map<string, WorldNode>;
	hierarchyEdges: WorldEdge[];
	linkEdges: WorldEdge[];
	hoverLinkEdges: WorldEdge[];
	rootId: string;
	focusId: string | null;
	hiddenNodeCount: number;
	externalNodeCount: number;
	externalFileCount: number;
	externalGroupCount: number;
}
