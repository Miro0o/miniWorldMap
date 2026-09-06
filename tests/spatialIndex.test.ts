import { describe, expect, it } from 'vitest';
import { SpatialIndex, type SpatialBounds } from '../src/render/SpatialIndex';

describe('spatial candidates', () => {
	it('matches a linear bounds scan in original order, including ties and boundary hits', () => {
		const items: SpatialBounds[] = Array.from({ length: 500 }, (_, i) => {
			const x = (i * 71) % 2000 - 1000;
			const y = (i * 107) % 2000 - 1000;
			return { minX: x, minY: y, maxX: x + i % 40, maxY: y + i % 70 };
		});
		items.push({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
		const index = new SpatialIndex(items, (item) => item);
		for (const radius of [0, 1, 20, 100, 3000]) {
			for (let i = 0; i < 100; i++) {
				const x = (i * 137) % 2000 - 1000;
				const y = (i * 193) % 2000 - 1000;
				const expected = items.filter((b) => b.minX <= x + radius && b.maxX >= x - radius && b.minY <= y + radius && b.maxY >= y - radius);
				expect(index.query(x, y, radius)).toEqual(expected);
			}
		}
		expect(index.query(0, 0, 0).slice(-2)).toEqual(items.slice(-2));
	});

	it('handles an empty graph', () => {
		expect(new SpatialIndex<SpatialBounds>([], (item) => item).query(0, 0, 100)).toEqual([]);
	});

	it('keeps segment intersections and clearance boundaries while pruning empty diagonal corners', () => {
		const items = Array.from({ length: 500 }, (_, i) => ({ x: (i * 71) % 1000, y: (i * 107) % 1000 }));
		items.push({ x: 500, y: 500 }, { x: 1000, y: 1000 }, { x: 0, y: 500 });
		const index = new SpatialIndex(items, (p) => ({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }));
		for (const a of [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 500, y: 500 }]) {
			for (const b of [{ x: 1000, y: 1000 }, a]) for (const padding of [0, 10, 500]) {
				const dx = b.x - a.x, dy = b.y - a.y;
				const hits = items.filter((p) => {
					const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / Math.max(1e-12, dx * dx + dy * dy)));
					return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= padding;
				});
				const candidates = new Set<typeof items[number]>();
				index.someAlongSegment(a, b, padding, (p) => { candidates.add(p); return false; });
				for (const hit of hits) expect(candidates.has(hit)).toBe(true);
			}
		}
		let calls = 0;
		index.someAlongSegment({ x: 0, y: 0 }, { x: 1000, y: 1000 }, 0, () => { calls++; return false; });
		expect(calls).toBeLessThan(20);
	});

	it('matches rectangular bounds scans and stops after the first exact match', () => {
		const items = Array.from({ length: 1000 }, (_, i) => ({ minX: i * 3, maxX: i * 3 + 2, minY: i % 19, maxY: i % 19 + 1 }));
		const index = new SpatialIndex(items, (item) => item);
		for (const width of [0, 1, 3000]) for (const height of [0, 1, 100]) {
			const area = { minX: 30, maxX: 30 + width, minY: 3, maxY: 3 + height };
			const expected = items.filter((b) => b.minX <= area.maxX && b.maxX >= area.minX && b.minY <= area.maxY && b.maxY >= area.minY);
			expect(index.queryBounds(area)).toEqual(expected);
			expect(new Set(index.queryBounds(area, false))).toEqual(new Set(expected));
			for (const cutoff of [0, 100, 3001]) {
				expect(index.some(area, (item) => item.minX >= cutoff)).toBe(expected.some((item) => item.minX >= cutoff));
			}
		}
		let calls = 0;
		expect(index.some({ minX: -1, minY: -1, maxX: 4000, maxY: 100 }, () => { calls++; return true; })).toBe(true);
		expect(calls).toBe(1);
	});
});
