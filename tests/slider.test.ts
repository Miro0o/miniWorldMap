import { describe, expect, it, vi } from 'vitest';
import { Slider } from '../src/overlay/Slider';

describe('panel slider drag cleanup', () => {
	it.each(['pointerup', 'pointercancel', 'lostpointercapture'])('ends a drag on %s without retaining move handlers', (endEvent) => {
		const captured = new Set<number>();
		const track = Object.assign(new EventTarget(), {
			getBoundingClientRect: () => ({ left: 0, width: 100 }),
			setPointerCapture: (id: number) => { captured.add(id); },
			hasPointerCapture: (id: number) => captured.has(id),
			releasePointerCapture: (id: number) => { captured.delete(id); },
		});
		const set = vi.fn(), input = vi.fn();
		const slider = Object.assign(Object.create(Slider.prototype), {
			trackEl: track,
			spec: { min: 0, max: 100, step: 1, defaultValue: 50, set, onInput: input },
			refresh() {},
		}) as { bindDrag(): void };
		slider.bindDrag();
		const dispatch = (type: string, x = 20) => track.dispatchEvent(Object.assign(new Event(type), { clientX: x, pointerId: 1, button: 0 }));
		dispatch('pointerdown');
		dispatch('pointermove', 40);
		if (endEvent === 'lostpointercapture') captured.clear();
		dispatch(endEvent);
		dispatch('pointermove', 90);
		expect(set.mock.calls.map(([value]) => value)).toEqual([20, 40]);
		expect(captured.size).toBe(0);
		dispatch('pointerdown');
		dispatch('pointermove', 60);
		dispatch('pointerup');
		expect(set.mock.calls.map(([value]) => value)).toEqual([20, 40, 20, 60]);
		expect(input).toHaveBeenCalledTimes(4);
	});
});
