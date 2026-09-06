import type { RadialPoint } from './types';
import { clamp } from './geometry';

export interface DepthBand { min: number; max: number }

/** Reserve visible gaps between placement intervals inside the existing ranges.
 * Open both overlapping and narrowly separated bands around their interface,
 * keeping the original baselines, ranges, and variation within each band. */
export function separateDepthBands(positions: Map<string, RadialPoint>, ringTargets: Map<number, number>): Map<number, DepthBand> {
	const bands = new Map<number, DepthBand>();
	for (const point of positions.values()) {
		if (point.external || !ringTargets.has(point.depth)) continue;
		const min = point.ringBandMin ?? point.radius, max = point.ringBandMax ?? point.radius;
		const band = bands.get(point.depth);
		if (band) { band.min = Math.min(band.min, min); band.max = Math.max(band.max, max); }
		else bands.set(point.depth, { min, max });
	}
	const original = new Map([...bands].map(([depth, band]) => [depth, { ...band }]));
	const depths = [...bands.keys()].sort((a, b) => a - b);
	for (let i = 1; i < depths.length; i++) {
		const innerDepth = depths[i - 1]!, outerDepth = depths[i]!;
		const inner = bands.get(innerDepth)!, outer = bands.get(outerDepth)!;
		const innerRadius = ringTargets.get(innerDepth)!, outerRadius = ringTargets.get(outerDepth)!;
		const step = outerRadius - innerRadius;
		if (step <= 0) continue;
		if (outer.min - inner.max >= step * 0.36) continue;
		const boundary = clamp((inner.max + outer.min) / 2, innerRadius + step * 0.25, outerRadius - step * 0.25);
		inner.max = Math.min(inner.max, boundary - step * 0.18);
		outer.min = Math.max(outer.min, boundary + step * 0.18);
	}
	// Preserve the radial variation on either side of each baseline. Do this
	// before spreading siblings, so all subsequent edge checks use these radii.
	for (const point of positions.values()) {
		if (point.external) continue;
		const band = bands.get(point.depth), before = original.get(point.depth);
		if (!band || !before || (band.min === before.min && band.max === before.max)) continue;
		const baseline = ringTargets.get(point.depth)!;
		const low = point.ringBandMin ?? point.radius, high = point.ringBandMax ?? point.radius;
		const min = Math.max(low, band.min), max = Math.min(high, band.max);
		if (min > max) continue;
		const offset = point.radius - baseline;
		point.radius = clamp(baseline + (offset < 0
			? offset * (baseline - min) / Math.max(1e-9, baseline - low)
			: offset * (max - baseline) / Math.max(1e-9, high - baseline)), min, max);
		point.x = Math.cos(point.angle) * point.radius;
		point.y = Math.sin(point.angle) * point.radius;
	}
	return bands;
}
