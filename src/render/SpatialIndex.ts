export interface SpatialBounds {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

interface Entry<T> extends SpatialBounds {
	value: T;
	order: number;
	code: number;
}

interface Branch<T> extends SpatialBounds {
	entries?: Entry<T>[];
	left?: Branch<T>;
	right?: Branch<T>;
}

/** Static world-space bounds. Exact hit distances remain the renderer's responsibility. */
export class SpatialIndex<T> {
	private root: Branch<T> | null;

	constructor(items: readonly T[], bounds: (item: T) => SpatialBounds) {
		const entries = items.map((value, order) => ({ ...bounds(value), value, order, code: 0 }));
		sortSpatially(entries);
		this.root = entries.length ? buildBranch(entries, 0, entries.length) : null;
	}

	query(x: number, y: number, radius: number): T[] {
		if (!this.root) return [];
		// Roundoff may expand the candidate set, but must never drop a boundary hit.
		const padding = Number.EPSILON * Math.max(1, Math.abs(x), Math.abs(y), radius) * 8;
		const extent = radius + padding;
		const area = { minX: x - extent, minY: y - extent, maxX: x + extent, maxY: y + extent };
		const found: Entry<T>[] = [];
		const stack = [this.root];
		while (stack.length) {
			const branch = stack.pop()!;
			if (!intersects(branch, area)) continue;
			if (branch.entries) {
				for (const entry of branch.entries) if (intersects(entry, area)) found.push(entry);
			} else {
				if (branch.left) stack.push(branch.left);
				if (branch.right) stack.push(branch.right);
			}
		}
		// The original traversal order decides ties between overlapping nodes/roads.
		return found.sort((a, b) => a.order - b.order).map((entry) => entry.value);
	}
}

/** One spatial sort, then a linear tree build; avoid sorting again at every level. */
function sortSpatially<T>(entries: Entry<T>[]): void {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const entry of entries) {
		const x = (entry.minX + entry.maxX) / 2;
		const y = (entry.minY + entry.maxY) / 2;
		minX = Math.min(minX, x); minY = Math.min(minY, y);
		maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
	}
	const scaleX = 65535 / Math.max(1, maxX - minX);
	const scaleY = 65535 / Math.max(1, maxY - minY);
	for (const entry of entries) {
		const x = Math.min(65535, Math.floor(((entry.minX + entry.maxX) / 2 - minX) * scaleX));
		const y = Math.min(65535, Math.floor(((entry.minY + entry.maxY) / 2 - minY) * scaleY));
		entry.code = (interleave(x) | (interleave(y) << 1)) >>> 0;
	}
	entries.sort((a, b) => a.code - b.code);
}

function interleave(value: number): number {
	value = (value | (value << 8)) & 0x00ff00ff;
	value = (value | (value << 4)) & 0x0f0f0f0f;
	value = (value | (value << 2)) & 0x33333333;
	return (value | (value << 1)) & 0x55555555;
}

function buildBranch<T>(entries: Entry<T>[], start: number, end: number): Branch<T> {
	if (end - start > 8) {
		const middle = (start + end) >>> 1;
		const left = buildBranch(entries, start, middle);
		const right = buildBranch(entries, middle, end);
		return {
			minX: Math.min(left.minX, right.minX), minY: Math.min(left.minY, right.minY),
			maxX: Math.max(left.maxX, right.maxX), maxY: Math.max(left.maxY, right.maxY),
			left, right,
		};
	}
	const branch: Branch<T> = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, entries: entries.slice(start, end) };
	for (let i = start; i < end; i++) {
		const entry = entries[i]!;
		branch.minX = Math.min(branch.minX, entry.minX); branch.minY = Math.min(branch.minY, entry.minY);
		branch.maxX = Math.max(branch.maxX, entry.maxX); branch.maxY = Math.max(branch.maxY, entry.maxY);
	}
	return branch;
}

function intersects(a: SpatialBounds, b: SpatialBounds): boolean {
	return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
