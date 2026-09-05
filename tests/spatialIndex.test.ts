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
});
