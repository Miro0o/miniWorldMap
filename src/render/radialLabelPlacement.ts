import type { SpatialBounds } from './SpatialIndex';

const CELL_SIZE = 128;

/** Screen-space grid rebuilt per frame; dense maps do not require all-pairs label checks. */
export class RadialLabelOccupancy {
	private cells = new Map<string, SpatialBounds[]>();

	intersects(bounds: SpatialBounds): boolean {
		for (const key of this.keys(bounds)) {
			for (const other of this.cells.get(key) ?? []) {
				if (bounds.minX < other.maxX && bounds.maxX > other.minX && bounds.minY < other.maxY && bounds.maxY > other.minY) return true;
			}
		}
		return false;
	}

	add(bounds: SpatialBounds): void {
		for (const key of this.keys(bounds)) {
			const cell = this.cells.get(key);
			if (cell) cell.push(bounds);
			else this.cells.set(key, [bounds]);
		}
	}

	private *keys(bounds: SpatialBounds): Generator<string> {
		for (let x = Math.floor(bounds.minX / CELL_SIZE); x <= Math.floor(bounds.maxX / CELL_SIZE); x++) {
			for (let y = Math.floor(bounds.minY / CELL_SIZE); y <= Math.floor(bounds.maxY / CELL_SIZE); y++) yield `${x}:${y}`;
		}
	}
}

/** Conservative text bounds avoid synchronous DOM measurements during wheel/pan events. */
export function radialLabelBounds(title: string, x: number, y: number, fontSize: number, maxWidth: number, padding: number): SpatialBounds {
	let lineWidth = 0;
	let widestLine = 0;
	let lines = 1;
	// Match normal word wrapping, with anywhere wrapping for names wider than a line.
	for (const word of title.split(/\s+/u)) {
		const widths = Array.from(word, (char) => fontSize * (/[^\u0000-\u00ff]|[MW@%]/u.test(char) ? 1 : 0.65));
		const wordWidth = widths.reduce((sum, width) => sum + width, 0);
		const space = lineWidth > 0 ? fontSize * 0.4 : 0;
		if (lineWidth > 0 && lineWidth + space + wordWidth > maxWidth) {
			widestLine = Math.max(widestLine, lineWidth);
			lineWidth = 0;
			lines++;
		} else lineWidth += space;
		for (const width of widths) {
			if (lineWidth > 0 && lineWidth + width > maxWidth) {
				widestLine = Math.max(widestLine, lineWidth);
				lineWidth = 0;
				lines++;
			}
			lineWidth += width;
		}
	}
	const halfWidth = Math.min(maxWidth, Math.max(widestLine, lineWidth)) / 2 + 3 + padding;
	return { minX: x - halfWidth, maxX: x + halfWidth, minY: y - padding, maxY: y + lines * fontSize * 1.17 + padding };
}
