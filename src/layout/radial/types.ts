import type { WorldNode } from '../../world/types';

export const DEFAULT_RING_SPACING = 1160;

export const MIN_RING_SPACING = 620;

export const MAX_RING_SPACING = 2800;

export const DEFAULT_NODE_SPACING = 144;

export const MIN_NODE_SPACING = 72;

export const MAX_NODE_SPACING = 360;

export const RING_JAGGED_BAND_FACTOR = 0.3;

export const RING_JAGGED_INNER_FACTOR = 0.15;

export const RING_JAGGED_OUTER_FACTOR = 0.34;

export const LEAF_SPAN_DEMAND = 0.045;

export interface RadialPoint {
	x: number;
	y: number;
	homeX: number;
	homeY: number;
	radius: number;
	homeRadius: number;
	angle: number;
	homeAngle: number;
	depth: number;
	nodeRadius: number;
	centerX: number;
	centerY: number;
	external: boolean;
	ringRadius?: number;
	ringBandMin?: number;
	ringBandMax?: number;
	/** World-space spacing reference, frozen before capacity expansion. */
	siblingSpacing?: number;
	sectorStart?: number;
	sectorEnd?: number;
	sectorSpan?: number;
	/** The family's angular corridor may widen across its children's radial band. */
	childSectorStart?: number;
	childSectorEnd?: number;
}

export interface RadialRing {
	depth: number;
	radius: number;
	count: number;
}

export interface RadialRoute {
	kind: 'line' | 'curve' | 'outer';
	centerX: number;
	centerY: number;
	radius: number;
	sourceAngle: number;
	targetAngle: number;
	endAngle?: number;
	curveStrength?: number;
}

export interface RadialLayout {
	positions: Map<string, RadialPoint>;
	rings: RadialRing[];
	routes: Map<string, RadialRoute>;
	bounds: { minX: number; minY: number; maxX: number; maxY: number };
	width: number;
	height: number;
	centerX: number;
	centerY: number;
	ringSpacing: number;
	nodeSpacing: number;
	/** Detail zoom at which unchanged glyphs are distinguishable; not a camera limit. */
	readableZoom?: number;
}

export interface RadialLayoutOptions {
	ringSpacing: number;
	nodeSpacing: number;
	swirlStrength: number;
}

export interface Metric {
	weight: number;
	count: number;
	maxDepth: number;
	spanDemand: number;
}

export interface SpacingProfile {
	baseRingGap: number;
	baseNodeGap: number;
	ringGap: number;
	nodeGap: number;
	branchFanSpan: number;
	routeGapFactor: number;
	radiusExpansion: number;
	ringCountsByDepth: Map<number, number>;
	maxDensityDepth: number;
	incidentPressureByNode: Map<string, number>;
}

export interface RingItem {
	id: string;
	node: WorldNode;
	point: RadialPoint;
	depth: number;
	parentId: string | null;
	parentAngle: number;
	visualRadius: number;
	arcDemand: number;
	preferred: number;
	parentSectorSpan: number;
	sectorSpan: number;
	fanWeight: number;
	parentIsRoot: boolean;
}

export interface FanPlacement {
	item: RingItem;
	angle: number;
	sectorStart: number;
	sectorEnd: number;
}

export interface ParentRingGroup {
	parentId: string;
	parentAngle: number;
	preferred: number;
	arcDemand: number;
	fanWeight: number;
	span: number;
	center: number;
	sectorSpan: number;
	items: RingItem[];
}

export interface ParentRingSectorEntry {
	group: ParentRingGroup;
	anchor: number;
	minSpan: number;
	desiredSpan: number;
	maxSpan: number;
	weight: number;
	parentAnchored: boolean;
	anchorPull: number;
}

export interface DepthRingStats {
	count: number;
	diameterTotal: number;
	maxDiameter: number;
	external: number;
	linkPressure: number;
	arcDemand: number;
}

export interface SectorRingLaneItem {
	id: string;
	node: WorldNode;
	point: RadialPoint;
	visualRadius: number;
	arcDemand: number;
	kind: string;
	parentKey: string;
}

export interface DepthLayoutPolicy {
	depth: number;
	count: number;
	depthRatio: number;
	outerWeight: number;
	crowdPressure: number;
	middleCrowdWeight: number;
	sparseTail: number;
	radialScale: number;
	bandScale: number;
	utilizationDrop: number;
}

export interface DepthLayoutProfile {
	maxDepth: number;
	averageCount: number;
	maxCount: number;
	byDepth: Map<number, DepthLayoutPolicy>;
	fallback: DepthLayoutPolicy;
}
