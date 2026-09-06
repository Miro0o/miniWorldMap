import { smoothstep } from './geometry';

/** Inner rings need larger angles to give siblings visible physical spacing.
 * Fade out the extra demand before the already well-spaced outer families. */
export function innerSiblingSpacing(depth: number, maxDepth: number): number {
	return 1 + 2.5 * (1 - smoothstep(0.2, 0.65, depth / Math.max(1, maxDepth)));
}
