import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Worker as NodeWorker } from 'node:worker_threads';
import workerSource from 'worker:../src/world/worldWorker.ts';
import { WorldMapComputation } from '../src/world/WorldMapComputation';
import { RadialLayoutCache } from '../src/world/RadialLayoutCache';
import type { RadialLayout } from '../src/layout/radial/types';
import { compute, type ComputationRequest, type ComputationResponse, type WorldSnapshot } from '../src/world/computation';
import { buildWorldMap } from '../src/world/buildWorldMap';
import { buildVisibleWorldGraph, defaultVisibleGraphState } from '../src/world/visibleGraph';
import { DEFAULT_RADIAL_SETTINGS } from '../src/settings';

const snapshot: WorldSnapshot = {
	records: Array.from({ length: 500 }, (_, i) => ({ path: `topic${i % 8}/note${i}.md`, basename: `note${i}`, kind: 'note' })),
	resolved: { 'topic0/note0.md': { 'topic1/note1.md': 4 } },
	unresolved: { 'topic0/note0.md': { missing: 3 } },
	settings: { ...DEFAULT_RADIAL_SETTINGS, includeUnresolvedLinks: true },
	rootTitle: 'test',
};

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: ((event: { data: ComputationResponse }) => void) | null = null;
	onerror: ((event: { preventDefault(): void; message: string }) => void) | null = null;
	onmessageerror: (() => void) | null = null;
	postMessage = vi.fn<(request: ComputationRequest) => void>();
	terminate = vi.fn();
	constructor() { FakeWorker.instances.push(this); }
}

beforeEach(() => vi.stubGlobal('window', globalThis));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); FakeWorker.instances = []; });

describe('background world computation', () => {
	it('reuses an identical refreshed graph after a mode switch and isolates cached coordinates', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const cache = new RadialLayoutCache();
		const first = new WorldMapComputation(cache);
		const model = buildWorldMap(snapshot.records.slice(0, 2), {}, {}, snapshot.settings);
		const graph = buildVisibleWorldGraph(model, defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS));
		const options = { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 };
		const pending = first.layout(graph, options);
		const worker = FakeWorker.instances[0]!;
		const request = worker.postMessage.mock.calls[0]![0];
		worker.onmessage!({ data: { id: request.id, result: compute(request) } });
		const layout = (await pending)!;
		const expected = structuredClone(layout);
		layout.positions.get(graph.rootId)!.x += 100;
		first.dispose();
		const second = new WorldMapComputation(cache);
		expect(await second.layout(structuredClone(graph), { ...options })).toEqual(expected);
		expect(FakeWorker.instances).toHaveLength(1);
		const copy = (await second.layout(graph, options))!;
		copy.positions.clear();
		expect(await second.layout(graph, options)).toEqual(expected);
		second.dispose();
		expect(await second.layout(graph, options)).toBeNull();
	});

	it('invalidates cached layouts for changed metadata, roots and layout options', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const computation = new WorldMapComputation();
		const model = buildWorldMap(snapshot.records.slice(0, 2), {}, {}, snapshot.settings);
		const graph = buildVisibleWorldGraph(model, defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS));
		const options = { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 };
		const pending = computation.layout(graph, options);
		const worker = FakeWorker.instances[0]!;
		const request = worker.postMessage.mock.calls[0]![0];
		worker.onmessage!({ data: { id: request.id, result: compute(request) } });
		await pending;
		const changed = structuredClone(graph);
		changed.nodesById.get(graph.rootId)!.linkCount++;
		const requests = [
			computation.layout(changed, options),
			computation.layout({ ...graph, rootId: graph.nodes[1]!.id }, options),
			computation.layout(graph, { ...options, swirlStrength: 30 }),
		];
		expect(worker.postMessage).toHaveBeenCalledTimes(4);
		computation.dispose();
		expect(await Promise.all(requests)).toEqual([null, null, null]);
	});

	it('evicts old layouts and clears all retained layouts', () => {
		const cache = new RadialLayoutCache();
		const model = buildWorldMap(snapshot.records.slice(0, 2), {}, {}, snapshot.settings);
		const graph = buildVisibleWorldGraph(model, defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS));
		const layout = compute({ type: 'layout', graph, options: { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 } }) as RadialLayout;
		cache.set('first', layout);
		cache.set('second', layout);
		cache.get('first');
		cache.set('third', layout);
		expect(cache.get('second')).toBeUndefined();
		expect(cache.get('first')).toEqual(layout);
		cache.clear();
		expect(cache.get('first')).toBeUndefined();
		expect(cache.get('third')).toBeUndefined();
	});

	it('shares identical pending layouts without coalescing changed layout options', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const computation = new WorldMapComputation();
		const model = buildWorldMap(snapshot.records.slice(0, 2), {}, {}, snapshot.settings);
		const graph = buildVisibleWorldGraph(model, defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS));
		const options = { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 0 };
		const first = computation.layout(graph, options);
		expect(computation.layout(graph, { ...options })).toBe(first);
		options.swirlStrength = 30;
		const second = computation.layout(graph, options);
		const worker = FakeWorker.instances[0]!;
		expect(worker.postMessage).toHaveBeenCalledTimes(2);
		expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({ options: { swirlStrength: 0 } });
		for (const [request] of worker.postMessage.mock.calls) worker.onmessage!({ data: { id: request.id, result: compute(request) } });
		expect(await first).not.toEqual(await second);
		const disposed = computation.layout(graph, options);
		computation.dispose();
		expect(await disposed).toBeNull();
	});

	it('runs the production worker source with exactly the same ordered model and layout', async () => {
		const worker = new NodeWorker(`const { parentPort } = require('node:worker_threads');
			global.self = { postMessage: data => parentPort.postMessage(data) };
			${workerSource}
			parentPort.on('message', data => self.onmessage({ data }));`, { eval: true });
		const run = (request: ComputationRequest) => new Promise<ComputationResponse>((resolve, reject) => {
			worker.once('message', resolve);
			worker.once('error', reject);
			worker.postMessage(request);
		});
		try {
			const modelTask = { id: 1, type: 'model' as const, snapshot };
			expect(await run(modelTask)).toEqual({ id: 1, result: compute(modelTask) });
			const model = buildWorldMap(snapshot.records, snapshot.resolved, snapshot.unresolved, snapshot.settings);
			for (const rootPath of ['', 'topic0']) for (const swirlStrength of [0, 30, 100]) {
				const graph = buildVisibleWorldGraph(model, { ...defaultVisibleGraphState(DEFAULT_RADIAL_SETTINGS), rootPath, showCompleteRoot: true }, DEFAULT_RADIAL_SETTINGS);
				const task = { id: 2, type: 'layout' as const, graph, options: { ringSpacing: 1160, nodeSpacing: 144, swirlStrength } };
				expect(await run(task)).toEqual({ id: 2, result: compute(task) });
			}
		} finally {
			await worker.terminate();
		}
	});

	it('routes responses by request id and releases every pending request on disposal', async () => {
		vi.stubGlobal('Worker', FakeWorker);
		const computation = new WorldMapComputation();
		const first = computation.buildModel(snapshot);
		const second = computation.buildModel(snapshot);
		const worker = FakeWorker.instances[0]!;
		const request = worker.postMessage.mock.calls[1]![0];
		const result = compute(request);
		worker.onmessage!({ data: { id: request.id, result } });
		expect(await second).toBe(result);
		computation.dispose();
		expect(await first).toBeNull();
		expect(await computation.buildModel(snapshot)).toBeNull();
		expect(worker.terminate).toHaveBeenCalledOnce();
	});

	it.each(['startup', 'error', 'message', 'timeout'])('falls back if the worker fails during %s', async (failure) => {
		vi.useFakeTimers();
		if (failure === 'startup') {
			vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked'); } });
		} else vi.stubGlobal('Worker', FakeWorker);
		const computation = new WorldMapComputation();
		const result = computation.buildModel(snapshot);
		const worker = FakeWorker.instances[0];
		if (failure === 'error') worker!.onerror!({ message: 'worker failed', preventDefault() {} });
		if (failure === 'message') worker!.onmessageerror!();
		if (failure === 'timeout') await vi.advanceTimersByTimeAsync(30000);
		expect(await result).toEqual(compute({ type: 'model', snapshot }));
		expect(vi.getTimerCount()).toBe(0);
		computation.dispose();
	});
});
