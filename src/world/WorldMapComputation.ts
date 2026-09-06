import workerSource from 'worker:./worldWorker.ts';
import type { RadialLayout, RadialLayoutOptions } from '../layout/radial/layoutRadial';
import { compute, type ComputationResponse, type ComputationResult, type ComputationTask, type WorldSnapshot } from './computation';
import type { VisibleWorldGraph, WorldModel } from './types';
import { RadialLayoutCache } from './RadialLayoutCache';

interface PendingTask {
	resolve(result: ComputationResult | null): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** One worker per view; failure falls back to the identical local computation. */
export class WorldMapComputation {
	private worker: Worker | null = null;
	private workerUnavailable = false;
	private disposed = false;
	private nextId = 0;
	private pending = new Map<number, PendingTask>();
	private pendingLayout: { graph: VisibleWorldGraph; options: RadialLayoutOptions; promise: Promise<RadialLayout | null> } | null = null;

	constructor(private layoutCache = new RadialLayoutCache()) {}

	buildModel(snapshot: WorldSnapshot): Promise<WorldModel | null> {
		return this.run({ type: 'model', snapshot }) as Promise<WorldModel | null>;
	}

	layout(graph: VisibleWorldGraph, options: RadialLayoutOptions): Promise<RadialLayout | null> {
		if (this.disposed) return Promise.resolve(null);
		const current = this.pendingLayout;
		if (current?.graph === graph && current.options.ringSpacing === options.ringSpacing
			&& current.options.nodeSpacing === options.nodeSpacing && current.options.swirlStrength === options.swirlStrength) return current.promise;
		const snapshot = { ...options };
		const key = this.layoutCache.key(graph, snapshot);
		const cached = this.layoutCache.get(key);
		if (cached) return Promise.resolve().then(() => this.disposed ? null : cached);
		const pending = { graph, options: snapshot, promise: this.run({ type: 'layout', graph, options: snapshot }) as Promise<RadialLayout | null> };
		pending.promise = pending.promise.then((layout) => {
			if (layout && !this.disposed) this.layoutCache.set(key, layout);
			return layout;
		}).finally(() => {
			if (this.pendingLayout === pending) this.pendingLayout = null;
		});
		this.pendingLayout = pending;
		return pending.promise;
	}

	private async run(task: ComputationTask): Promise<ComputationResult | null> {
		if (this.disposed) return null;
		try {
			const worker = this.getWorker();
			if (worker) {
				return await new Promise<ComputationResult | null>((resolve, reject) => {
					const id = ++this.nextId;
					const timer = setTimeout(() => this.failWorker(new Error('World map worker timed out')), 30000);
					this.pending.set(id, { resolve, reject, timer });
					try {
						worker.postMessage({ ...task, id });
					} catch (error) {
						this.failWorker(error instanceof Error ? error : new Error(String(error)));
					}
				});
			}
		} catch {
			// The fallback also covers asynchronous worker/CSP/message failures.
		}
		return this.disposed ? null : compute(task);
	}

	private getWorker(): Worker | null {
		if (this.worker || this.workerUnavailable || this.disposed) return this.worker;
		if (typeof Worker === 'undefined') {
			this.workerUnavailable = true;
			return null;
		}
		let url = '';
		try {
			url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
			const worker = new Worker(url);
			worker.onmessage = (event: MessageEvent<ComputationResponse>) => {
				const response = event.data;
				const task = this.pending.get(response.id);
				if (!task) return;
				clearTimeout(task.timer);
				this.pending.delete(response.id);
				if ('error' in response) task.reject(new Error(response.error));
				else task.resolve(response.result);
			};
			worker.onerror = (event) => {
				event.preventDefault();
				this.failWorker(new Error(event.message));
			};
			worker.onmessageerror = () => this.failWorker(new Error('World map worker message failed'));
			this.worker = worker;
		} catch {
			this.workerUnavailable = true;
		} finally {
			if (url) URL.revokeObjectURL(url);
		}
		return this.worker;
	}

	private failWorker(error: Error): void {
		this.workerUnavailable = true;
		this.worker?.terminate();
		this.worker = null;
		for (const task of this.pending.values()) {
			clearTimeout(task.timer);
			task.reject(error);
		}
		this.pending.clear();
	}

	dispose(): void {
		this.disposed = true;
		this.pendingLayout = null;
		this.worker?.terminate();
		this.worker = null;
		for (const task of this.pending.values()) {
			clearTimeout(task.timer);
			task.resolve(null);
		}
		this.pending.clear();
	}
}
