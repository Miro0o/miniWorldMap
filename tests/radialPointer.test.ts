import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { mergeSettings } from '../src/settings';
import { Radial2DController } from '../src/view/Radial2DController';

const controllers: Radial2DController[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', {
		setTimeout, clearTimeout, cancelAnimationFrame: clearTimeout,
		requestAnimationFrame: (callback: () => void) => setTimeout(callback, 16),
	});
});
afterEach(() => {
	for (const controller of controllers.splice(0)) controller.dispose();
	vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

function fixture() {
	const handlers = new Map<string, (event: PointerEvent) => void>();
	const canvas = {
		addEventListener: (name: string, callback: (event: PointerEvent) => void) => handlers.set(name, callback),
		removeEventListener: (name: string) => handlers.delete(name),
		getBoundingClientRect: () => ({ left: 0, top: 0 }),
		focus() {}, setPointerCapture() {}, releasePointerCapture() {},
	};
	const view = { centerX: 0, centerY: 0, zoom: 1 };
	const setView = vi.fn((centerX: number, centerY: number, zoom: number) => Object.assign(view, { centerX, centerY, zoom }));
	const activate = vi.fn();
	const controller = new Radial2DController({} as App, { empty() {}, removeClass() {} } as unknown as HTMLElement,
		mergeSettings(null), () => {}, () => {}, () => {});
	controllers.push(controller);
	controller.load();
	Object.assign(controller, {
		renderer: { domElement: canvas, getView: () => ({ ...view }), setView, dispose() {} },
		activateAt: activate, updateHover() {},
	});
	(controller as unknown as { bindRendererEvents(): void }).bindRendererEvents();
	const emit = (name: string, pointerId = 1, clientX = 0, clientY = 0, button = 0) => {
		handlers.get(name)?.({ pointerId, clientX, clientY, button } as PointerEvent);
	};
	return { emit, activate, view, setView };
}

describe('2D pointer lifecycle', () => {
	it.each(['pointercancel', 'lostpointercapture'])('cancels queued movement on %s and allows a new drag', (event) => {
		const { emit, activate, view, setView } = fixture();
		emit('pointerdown');
		emit('pointermove', 1, 40, 20);
		emit(event);
		vi.runAllTimers();
		emit('pointermove', 1, 90, 50);
		emit('pointerup', 1, 90, 50);
		vi.runAllTimers();
		expect(setView).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		emit('pointerdown');
		emit('pointermove', 1, 10, 20);
		emit('pointerup', 1, 10, 20);
		expect(view).toEqual({ centerX: -10, centerY: 20, zoom: 1 });
		expect(activate).not.toHaveBeenCalled();
	});

	it('keeps another pointer from moving or releasing the active drag', () => {
		const { emit, activate, view } = fixture();
		emit('pointerdown');
		emit('pointerdown', 2, 100, 100);
		emit('pointermove', 2, 200, 200);
		emit('pointerup', 2, 200, 200);
		emit('pointercancel', 2);
		emit('pointermove', 1, 10, 20);
		emit('pointerup', 1, 10, 20);
		expect(view).toEqual({ centerX: -10, centerY: 20, zoom: 1 });
		expect(activate).not.toHaveBeenCalled();
	});

	it('activates a primary click once and ignores an unmatched secondary release', () => {
		const { emit, activate } = fixture();
		emit('pointerdown', 1, 0, 0, 2);
		emit('pointerup', 1, 0, 0, 2);
		expect(activate).not.toHaveBeenCalled();
		emit('pointerdown'); emit('pointerup');
		expect(activate).toHaveBeenCalledOnce();
	});
});
