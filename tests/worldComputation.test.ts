import { afterEach, describe, expect, it, vi } from 'vitest';
import { Worker as NodeWorker } from 'node:worker_threads';
import workerSource from 'worker:../src/world/worldWorker.ts';
import { WorldMapComputation } from '../src/world/WorldMapComputation';
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

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); FakeWorker.instances = []; });

describe('background world computation', () => {
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
