export type ViewMode = 'radial2d' | 'map3d';
export type Language = 'en' | 'zh';

export interface BloomSettings {
	strength: number;
	radius: number;
	threshold: number;
}

export interface PhysicsSettings {
	repel: number; // Positive value; the layout uses the negative charge.
	linkDistance: number;
	linkStrength: number;
	centerPull: number;
	flatten: number;
}

export type SizeBy = 'degree' | 'fileSize' | 'uniform';

export interface LookSettings {
	nodeSize: number;
	linkOpacity: number;
	twinkle: number;
	sizeBy: SizeBy;
}

export type VisualPreset = 'deep-space' | 'adaptive';

export interface GalaxySettings {
	bloom: BloomSettings;
	physics: PhysicsSettings;
	look: LookSettings;
	cruise: boolean;
	cruiseSpeed: number;
	showUnresolved: boolean;
	showOrphans: boolean;
	colorTheme: string;
	qualityOverride: 'auto' | 'high' | 'low' | 'mobile';
	preset: VisualPreset;
	colorGroups: import('./settings/graphJsonImport').ColorGroup[];
	positionCache: Record<string, [number, number, number]>;
}

export type ColorScheme = 'auto' | 'day' | 'night';
export type LabelVisibility = 'auto' | 'hover';
export type HoverTargetMode = 'nodes' | 'links' | 'both';
export type HoverHighlightMode =
	| 'none'
	| 'note-links'
	| 'hierarchy-parents'
	| 'hierarchy-direct-children'
	| 'hierarchy-descendants'
	| 'hierarchy-parents-direct'
	| 'hierarchy-all';
export type ExternalDetailMode = 'grouped' | 'selected' | 'exact';

export interface RadialSettings {
	atlasDepth: number;
	focusSiblingLimit: number;
	linkLimit: number;
	renderNodeLimit: number;
	externalLinkAnchorLimit: number;
	adaptiveDetail: boolean;
	includeUnresolvedLinks: boolean;
	showLinkOverlay: boolean;
	showExternalLinks: boolean;
	externalDetailMode: ExternalDetailMode;
	colorScheme: ColorScheme;
	labelVisibility: LabelVisibility;
	hoverHighlightMode: HoverHighlightMode;
	hoverTargetMode: HoverTargetMode;
	swirlStrength: number;
	hiddenLegendItems: string[];
	ignoreFolders: string[];
}

export interface MiniWorldMapSettings {
	language: Language;
	viewMode: ViewMode;
	radial: RadialSettings;
	galaxy3d: GalaxySettings;
}

export const MAX_ATLAS_DEPTH = 80;
export const MAX_RENDER_NODE_LIMIT = 20_000;
export const MAX_LINK_LIMIT = 30_000;
export const MAX_EXTERNAL_LINK_ANCHOR_LIMIT = 20_000;
export const MAX_SWIRL_STRENGTH = 100;

export const HOVER_HIGHLIGHT_MODE_OPTIONS: [HoverHighlightMode, string][] = [
	['none', 'None'],
	['note-links', 'Note links'],
	['hierarchy-parents', 'Hierarchy parents'],
	['hierarchy-direct-children', 'Hierarchy direct children'],
	['hierarchy-descendants', 'Hierarchy all children'],
	['hierarchy-parents-direct', 'Hierarchy parents + direct'],
	['hierarchy-all', 'Hierarchy parents + all children'],
];

export const LABEL_VISIBILITY_OPTIONS: [LabelVisibility, string][] = [
	['auto', 'Auto'],
	['hover', 'Hover only'],
];

export const HOVER_TARGET_MODE_OPTIONS: [HoverTargetMode, string][] = [
	['nodes', 'Nodes'],
	['links', 'Links'],
	['both', 'Nodes + links'],
];

export const LEGEND_ITEM_DEFINITIONS: [string, string, string, string][] = [
	['root', 'legend.root', 'legend.root.desc', 'mwm-legend-root'],
	['folder', 'legend.folder', 'legend.folder.desc', 'mwm-legend-folder'],
	['folder-meta', 'legend.folderMeta', 'legend.folderMeta.desc', 'mwm-legend-meta'],
	['file', 'legend.note', 'legend.note.desc', 'mwm-legend-note'],
	['outside', 'legend.outsideGroup', 'legend.outsideGroup.desc', 'mwm-legend-external'],
	['outside-file', 'legend.outsideNote', 'legend.outsideNote.desc', 'mwm-legend-outside-file'],
	['missing', 'legend.unresolvedNote', 'legend.unresolvedNote.desc', 'mwm-legend-unresolved'],
	['tree', 'legend.hierarchy', 'legend.hierarchy.desc', 'mwm-legend-tree'],
	['link', 'legend.noteLinks', 'legend.noteLinks.desc', 'mwm-legend-link'],
	['outside-link', 'legend.outsideLinks', 'legend.outsideLinks.desc', 'mwm-legend-link-external'],
	['dashed-link', 'legend.unresolvedLinks', 'legend.unresolvedLinks.desc', 'mwm-legend-link-unresolved'],
];

export const DEFAULT_RADIAL_SETTINGS: RadialSettings = {
	atlasDepth: 6,
	focusSiblingLimit: 160,
	linkLimit: 1200,
	renderNodeLimit: 4200,
	externalLinkAnchorLimit: 700,
	adaptiveDetail: true,
	includeUnresolvedLinks: true,
	showLinkOverlay: true,
	showExternalLinks: true,
	externalDetailMode: 'grouped',
	colorScheme: 'auto',
	labelVisibility: 'auto',
	hoverHighlightMode: 'hierarchy-all',
	hoverTargetMode: 'nodes',
	swirlStrength: 0,
	hiddenLegendItems: [],
	ignoreFolders: ['.git', '.obsidian'],
};

export const DEFAULT_GALAXY_SETTINGS: GalaxySettings = {
	bloom: { strength: 0.35, radius: 0.35, threshold: 0.22 },
	physics: { repel: 200, linkDistance: 70, linkStrength: 1, centerPull: 0.04, flatten: 0.3 },
	look: { nodeSize: 1, linkOpacity: 0.14, twinkle: 0.5, sizeBy: 'degree' },
	cruise: true,
	cruiseSpeed: 1,
	showUnresolved: false,
	showOrphans: true,
	colorTheme: 'imported',
	qualityOverride: 'auto',
	preset: 'adaptive',
	colorGroups: [],
	positionCache: {},
};

export const DEFAULT_SETTINGS: MiniWorldMapSettings = {
	language: 'en',
	viewMode: 'radial2d',
	radial: DEFAULT_RADIAL_SETTINGS,
	galaxy3d: DEFAULT_GALAXY_SETTINGS,
};

export function mergeSettings(saved: unknown): MiniWorldMapSettings {
	const raw = isRecord(saved) ? saved : {};
	const hasNestedRadial = isRecord(raw['radial']);
	const radialSource = hasNestedRadial ? raw['radial'] : raw;
	const galaxySource = isRecord(raw['galaxy3d']) ? raw['galaxy3d'] : raw;
	const radial = mergeRadialSettings(radialSource);
	if (!hasNestedRadial && raw['showLinkOverlay'] === false) radial.showLinkOverlay = DEFAULT_RADIAL_SETTINGS.showLinkOverlay;
	return {
		language: normalizeLanguage(raw['language'] ?? raw['locale'] ?? raw['lang']),
		viewMode: normalizeViewMode(raw['viewMode']),
		radial,
		galaxy3d: mergeGalaxySettings(galaxySource),
	};
}

export function mergeRadialSettings(saved: unknown): RadialSettings {
	const s = isRecord(saved) ? saved : {};
	const d = DEFAULT_RADIAL_SETTINGS;
	const legendIds = new Set(LEGEND_ITEM_DEFINITIONS.map(([id]) => id));
	const hoverMode = s['hoverHighlightMode'] ?? (s['enableLinkHover'] === true ? 'note-links' : d.hoverHighlightMode);
	return {
		atlasDepth: clampNumber(s['atlasDepth'], 1, MAX_ATLAS_DEPTH, d.atlasDepth),
		focusSiblingLimit: clampNumber(s['focusSiblingLimit'], 10, 1000, d.focusSiblingLimit),
		linkLimit: clampNumber(s['linkLimit'], 0, MAX_LINK_LIMIT, d.linkLimit),
		renderNodeLimit: clampNumber(s['renderNodeLimit'], 200, MAX_RENDER_NODE_LIMIT, d.renderNodeLimit),
		externalLinkAnchorLimit: clampNumber(
			s['externalLinkAnchorLimit'],
			0,
			MAX_EXTERNAL_LINK_ANCHOR_LIMIT,
			d.externalLinkAnchorLimit,
		),
		adaptiveDetail: typeof s['adaptiveDetail'] === 'boolean' ? s['adaptiveDetail'] : d.adaptiveDetail,
		includeUnresolvedLinks:
			typeof s['includeUnresolvedLinks'] === 'boolean' ? s['includeUnresolvedLinks'] : d.includeUnresolvedLinks,
		showLinkOverlay: typeof s['showLinkOverlay'] === 'boolean' ? s['showLinkOverlay'] : d.showLinkOverlay,
		showExternalLinks: typeof s['showExternalLinks'] === 'boolean' ? s['showExternalLinks'] : d.showExternalLinks,
		externalDetailMode: normalizeExternalDetailMode(s['externalDetailMode']),
		colorScheme: normalizeColorScheme(s['colorScheme']),
		labelVisibility: normalizeLabelVisibility(s['labelVisibility']),
		hoverHighlightMode: normalizeHoverHighlightMode(hoverMode),
		hoverTargetMode: normalizeHoverTargetMode(s['hoverTargetMode']),
		swirlStrength: clampNumber(s['swirlStrength'], 0, MAX_SWIRL_STRENGTH, d.swirlStrength),
		hiddenLegendItems: Array.isArray(s['hiddenLegendItems'])
			? s['hiddenLegendItems'].filter((id): id is string => typeof id === 'string' && legendIds.has(id))
			: d.hiddenLegendItems.slice(),
		ignoreFolders: Array.isArray(s['ignoreFolders'])
			? s['ignoreFolders'].filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
			: d.ignoreFolders.slice(),
	};
}

export function mergeGalaxySettings(saved: unknown): GalaxySettings {
	const s = isRecord(saved) ? saved : {};
	const d = DEFAULT_GALAXY_SETTINGS;
	const bloom = isRecord(s['bloom']) ? s['bloom'] : {};
	const physics = isRecord(s['physics']) ? s['physics'] : {};
	const look = isRecord(s['look']) ? s['look'] : {};
	return {
		bloom: {
			strength: finiteNumber(bloom['strength'], d.bloom.strength),
			radius: finiteNumber(bloom['radius'], d.bloom.radius),
			threshold: finiteNumber(bloom['threshold'], d.bloom.threshold),
		},
		physics: {
			repel: finiteNumber(physics['repel'], d.physics.repel),
			linkDistance: finiteNumber(physics['linkDistance'], d.physics.linkDistance),
			linkStrength: finiteNumber(physics['linkStrength'], d.physics.linkStrength),
			centerPull: finiteNumber(physics['centerPull'], d.physics.centerPull),
			flatten: finiteNumber(physics['flatten'], d.physics.flatten),
		},
		look: {
			nodeSize: finiteNumber(look['nodeSize'], d.look.nodeSize),
			linkOpacity: finiteNumber(look['linkOpacity'], d.look.linkOpacity),
			twinkle: finiteNumber(look['twinkle'], d.look.twinkle),
			sizeBy: (['degree', 'fileSize', 'uniform'] as const).includes(look['sizeBy'] as SizeBy)
				? (look['sizeBy'] as SizeBy)
				: d.look.sizeBy,
		},
		cruise: typeof s['cruise'] === 'boolean' ? s['cruise'] : d.cruise,
		cruiseSpeed: finiteNumber(s['cruiseSpeed'], d.cruiseSpeed),
		showUnresolved:
			typeof s['showUnresolved'] === 'boolean'
				? s['showUnresolved']
				: typeof s['includeUnresolvedLinks'] === 'boolean'
					? s['includeUnresolvedLinks']
					: d.showUnresolved,
		showOrphans: typeof s['showOrphans'] === 'boolean' ? s['showOrphans'] : d.showOrphans,
		colorTheme: typeof s['colorTheme'] === 'string' ? s['colorTheme'] : d.colorTheme,
		qualityOverride: (['auto', 'high', 'low', 'mobile'] as const).includes(s['qualityOverride'] as 'auto')
			? (s['qualityOverride'] as GalaxySettings['qualityOverride'])
			: d.qualityOverride,
		preset: s['preset'] === 'deep-space' ? 'deep-space' : 'adaptive',
		colorGroups: Array.isArray(s['colorGroups'])
			? s['colorGroups'].filter(
					(g): g is import('./settings/graphJsonImport').ColorGroup =>
						isRecord(g) && typeof g['query'] === 'string' && typeof g['color'] === 'string',
				)
			: [],
		positionCache:
			isRecord(s['positionCache']) && !Array.isArray(s['positionCache'])
				? (s['positionCache'] as Record<string, [number, number, number]>)
				: {},
	};
}

export interface SettingsHost {
	settings: MiniWorldMapSettings;
	saveSettings(): Promise<void>;
	setViewMode(mode: ViewMode): void;
	setLanguage(language: Language): void;
}

export function toLayoutParams(p: PhysicsSettings): import('./types').LayoutParams {
	return {
		charge: -p.repel,
		linkDistance: p.linkDistance,
		linkStrength: p.linkStrength,
		centerPull: p.centerPull,
		flatten: p.flatten,
		velocityDecay: 0.6,
	};
}

export function normalizeViewMode(value: unknown): ViewMode {
	return value === 'map3d' || value === 'radial2d' ? value : DEFAULT_SETTINGS.viewMode;
}

export function normalizeLanguage(value: unknown): Language {
	return value === 'zh' ? 'zh' : DEFAULT_SETTINGS.language;
}

export function normalizeColorScheme(value: unknown): ColorScheme {
	return value === 'auto' || value === 'day' || value === 'night' ? value : DEFAULT_RADIAL_SETTINGS.colorScheme;
}

export function normalizeLabelVisibility(value: unknown): LabelVisibility {
	return value === 'hover' ? 'hover' : DEFAULT_RADIAL_SETTINGS.labelVisibility;
}

export function normalizeHoverHighlightMode(value: unknown): HoverHighlightMode {
	return HOVER_HIGHLIGHT_MODE_OPTIONS.some(([id]) => id === value)
		? (value as HoverHighlightMode)
		: DEFAULT_RADIAL_SETTINGS.hoverHighlightMode;
}

export function normalizeHoverTargetMode(value: unknown): HoverTargetMode {
	return HOVER_TARGET_MODE_OPTIONS.some(([id]) => id === value)
		? (value as HoverTargetMode)
		: DEFAULT_RADIAL_SETTINGS.hoverTargetMode;
}

export function hoverHighlightsNoteLinks(mode: unknown): boolean {
	return normalizeHoverHighlightMode(mode) === 'note-links';
}

export function hoverHighlightModeLabel(mode: unknown): string {
	const normalized = normalizeHoverHighlightMode(mode);
	return HOVER_HIGHLIGHT_MODE_OPTIONS.find(([id]) => id === normalized)?.[1].toLowerCase() ?? normalized;
}

export function normalizeExternalDetailMode(value: unknown): ExternalDetailMode {
	return value === 'selected' || value === 'exact' || value === 'grouped'
		? value
		: DEFAULT_RADIAL_SETTINGS.externalDetailMode;
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const n = finiteNumber(value, fallback);
	return Math.min(Math.max(n, min), max);
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : Number.parseFloat(String(value)) || fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
