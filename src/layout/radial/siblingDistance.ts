import type { RadialPoint } from './types';
import { clamp } from './geometry';

/** One world-space spacing target for the whole map. A lane change or a larger
 * ring changes the required angle, not the desired distance between siblings. */
export function siblingDistance(positions: Map<string, RadialPoint>, nodeGap: number): (a: RadialPoint, b: RadialPoint) => number {
	const unit = siblingSpacingUnit(positions, nodeGap);
	const footprint = (point: RadialPoint) => 5 + Math.max(point.nodeRadius - 6, 0) * 0.18;
	return (a, b) => Math.max(a.nodeRadius + b.nodeRadius + nodeGap * 3, unit * (footprint(a) + footprint(b)) / 10);
}

export function siblingSpacingUnit(positions: Map<string, RadialPoint>, nodeGap: number): number {
	const frozen = [...positions.values()].find((point) => !point.external && point.siblingSpacing !== undefined)?.siblingSpacing;
	if (frozen !== undefined) return frozen;
	const levels = new Map<number, number[]>();
	for (const point of positions.values()) {
		if (point.external) continue;
		const row = levels.get(point.depth) ?? [];
		row.push(point.ringRadius ?? point.radius); levels.set(point.depth, row);
	}
	const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
	const baselines = [...levels].sort(([a], [b]) => a - b).map(([depth, radii]) => ({ depth, radius: median(radii) }));
	const steps = baselines.slice(1).map((band, i) => (band.radius - baselines[i]!.radius) / (band.depth - baselines[i]!.depth)).filter((step) => step > 0);
	const step = steps.length ? median(steps) : nodeGap;
	return step * 0.12;
}

export function siblingAngle(distance: number, radius: number): number {
	return 2 * Math.asin(clamp(distance / (2 * Math.max(1, radius)), 0, 1));
}
