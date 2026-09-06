export interface BandConstraint {
	a: number;
	b: number;
	/** angle[b] - angle[a] must be at least this value. */
	base: number;
	/** Additional space requested for a readable fork. */
	extra: number;
	/** Preserve the opening of small forks before trimming longer fans. */
	priority?: number;
}

interface Arc extends BandConstraint { weight: number }
interface Obstruction { blocking: number[]; overflow: number }
type Solution = { distance: Float64Array } | Obstruction | null;
export interface BandCentering { parent: number; first: number; last: number }

/** Solve ordered bands and outward corridors together. When a cycle cannot
 * accommodate every requested fork, reduce only the extra gaps on that cycle.
 * Physical clearance and the order constraints never become negotiable.
 */
export function solveBandConstraints(count: number, constraints: BandConstraint[], span: number, families: BandCentering[] = []): number[] | null {
	const arcs: Arc[] = constraints.map((constraint) => ({ ...constraint, weight: constraint.base + constraint.extra }));
	for (let iteration = 0; iteration < 128; iteration++) {
		const earliest = solveDifferences(count, arcs, span, false);
		if (!earliest) return null;
		if ('distance' in earliest) {
			const latest = solveDifferences(count, arcs, span, true);
			if (!latest || !('distance' in latest)) return null;
			// The mean of two feasible solutions remains feasible and avoids
			// parking every family against the same side of its available space.
			const angles = [...earliest.distance].map((angle, i) => (angle + span - latest.distance[i]!) / 2);
			return centerBands(angles, arcs, span, families);
		}
		const extra = earliest.blocking.reduce((sum, index) => sum + arcs[index]!.extra, 0);
		if (extra < earliest.overflow - 1e-8) return null;
		let remaining = Math.min(extra, Math.max(earliest.overflow * 1.02, extra * 0.2));
		while (remaining > 1e-12) {
			const weighted = earliest.blocking.reduce((sum, index) => sum + arcs[index]!.extra / (arcs[index]!.priority ?? 1), 0);
			if (weighted < 1e-12) break;
			let removed = 0;
			for (const index of earliest.blocking) {
				const arc = arcs[index]!;
				const amount = Math.min(arc.extra, remaining * arc.extra / (arc.priority ?? 1) / weighted);
				arc.extra -= amount;
				arc.weight = arc.base + arc.extra;
				removed += amount;
			}
			remaining -= removed;
		}
	}
	return null;
}

/** Project parent/fan centering onto the same feasible angular corridors.
 * Neighboring families can yield together before their radial lanes are chosen.
 * Keep the original solution if the bounded relaxation cannot settle safely.
 */
function centerBands(original: number[], arcs: Arc[], span: number, families: BandCentering[]): number[] {
	if (!families.length) return original;
	const error = (values: number[]) => families.reduce((sum, family) => sum + (values[family.parent]! - (values[family.first]! + values[family.last]!) / 2) ** 2, 0);
	let best = original, bestError = error(original);
	for (let pass = 0; pass < 16; pass++) {
		const desired = best.slice();
		for (const { parent, first, last } of families) {
			desired[parent] = (desired[first]! + desired[last]!) / 2;
		}
		// Forward and reverse closures propagate each move through all affected
		// neighbors. Both satisfy every spacing bound; so does their mean.
		const low = solveDifferences(original.length, arcs, Infinity, false, desired);
		const high = solveDifferences(original.length, arcs, Infinity, true, desired.map((angle) => -angle));
		if (!low || !high || !('distance' in low) || !('distance' in high)) break;
		const angles = [...low.distance].map((angle, i) => (angle - high.distance[i]!) / 2);
		const minimum = Math.min(...angles), maximum = Math.max(...angles);
		if (maximum - minimum > span + 1e-8) break;
		const shift = (span - maximum - minimum) / 2;
		for (let i = 0; i < angles.length; i++) angles[i] = angles[i]! + shift;
		const score = error(angles);
		if (score >= bestError - 1e-12) break;
		best = angles; bestError = score;
	}
	return best;
}

function solveDifferences(count: number, arcs: Arc[], span: number, reverse: boolean, seed?: number[]): Solution {
	const adjacent: { to: number; index: number }[][] = Array.from({ length: count }, () => []);
	for (let index = 0; index < arcs.length; index++) {
		const arc = arcs[index]!;
		adjacent[reverse ? arc.b : arc.a]!.push({ to: reverse ? arc.a : arc.b, index });
	}
	const distance = seed ? Float64Array.from(seed) : new Float64Array(count);
	const predecessor = new Int32Array(count).fill(-1);
	const previous = new Int32Array(count).fill(-1);
	const queued = new Uint8Array(count).fill(1);
	const queue = Int32Array.from({ length: count }, (_, i) => reverse ? count - i - 1 : i);
	let head = 0, tail = 0, pending = count, changes = 0, work = 0;
	while (pending > 0) {
		// Bound pathological input without returning partially valid angles.
		if (++work > count * 4096) return null;
		const a = queue[head]!;
		head = (head + 1) % count;
		pending--;
		queued[a] = 0;
		for (const edge of adjacent[a]!) {
			const next = distance[a]! + arcs[edge.index]!.weight;
			if (next <= distance[edge.to]! + 1e-10) continue;
			distance[edge.to] = next;
			previous[edge.to] = a;
			predecessor[edge.to] = edge.index;
			if (next > span + 1e-8) {
				const obstruction = traceObstruction(edge.to, predecessor, previous, arcs, next - span);
				if (obstruction) return obstruction;
			}
			// Inspect the predecessor graph in linear time. Checking every
			// individual path on every relaxation is quadratic on deep trees.
			if (++changes % (count * 2) === 0) {
				const obstruction = findPositiveCycle(predecessor, previous, arcs);
				if (obstruction) return obstruction;
			}
			if (!queued[edge.to]) {
				queue[tail] = edge.to;
				tail = (tail + 1) % count;
				pending++;
				queued[edge.to] = 1;
			}
		}
	}
	return { distance };
}

function traceObstruction(start: number, predecessor: Int32Array, previous: Int32Array, arcs: Arc[], overflow: number): Obstruction | null {
	const path: number[] = [];
	const visited = new Map<number, number>();
	let node = start;
	while (node >= 0 && predecessor[node]! >= 0) {
		const cycleStart = visited.get(node);
		if (cycleStart !== undefined) {
			const blocking = path.slice(cycleStart);
			const weight = blocking.reduce((sum, index) => sum + arcs[index]!.weight, 0);
			return weight > 1e-10 ? { blocking, overflow: weight } : null;
		}
		visited.set(node, path.length);
		path.push(predecessor[node]!);
		node = previous[node]!;
	}
	return { blocking: path, overflow };
}

function findPositiveCycle(predecessor: Int32Array, previous: Int32Array, arcs: Arc[]): Obstruction | null {
	const seen = new Int32Array(predecessor.length);
	for (let i = 0; i < predecessor.length; i++) {
		if (seen[i] || predecessor[i]! < 0) continue;
		let node = i;
		const chain: number[] = [];
		while (node >= 0 && predecessor[node]! >= 0 && !seen[node]) {
			seen[node] = i + 1;
			chain.push(node);
			node = previous[node]!;
		}
		if (node < 0 || seen[node] !== i + 1) continue;
		const blocking = chain.slice(chain.indexOf(node)).map((id) => predecessor[id]!);
		const overflow = blocking.reduce((sum, index) => sum + arcs[index]!.weight, 0);
		if (overflow > 1e-10) return { blocking, overflow };
	}
	return null;
}
