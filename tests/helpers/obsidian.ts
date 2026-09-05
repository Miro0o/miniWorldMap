/** Minimal event/component lifecycle used by controller tests; no Obsidian UI. */
interface EventHandle { off(): void }

export class Events {
	private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
	on(name: string, callback: (...args: unknown[]) => void): EventHandle {
		const list = this.handlers.get(name) ?? new Set();
		list.add(callback);
		this.handlers.set(name, list);
		return { off: () => { list.delete(callback); } };
	}
	offref(ref: EventHandle): void { ref.off(); }
	emit(name: string, ...args: unknown[]): void { for (const fn of this.handlers.get(name) ?? []) fn(...args); }
	get listenerCount(): number { return [...this.handlers.values()].reduce((sum, list) => sum + list.size, 0); }
}

export class Component {
	children = new Set<Component>();
	private loaded = false;
	private cleanup: (() => void)[] = [];
	load(): void {
		if (this.loaded) return;
		this.loaded = true;
		for (const child of this.children) child.load();
	}
	unload(): void {
		if (!this.loaded) return;
		this.loaded = false;
		this.onunload();
		for (const child of this.children) child.unload();
		for (const fn of this.cleanup.splice(0)) fn();
	}
	onunload(): void { /* subclass hook */ }
	register(fn: () => void): void { this.cleanup.push(fn); }
	registerEvent(ref: EventHandle): void { this.register(() => ref.off()); }
	addChild<T extends Component>(child: T): T {
		this.children.add(child);
		if (this.loaded) child.load();
		return child;
	}
	removeChild<T extends Component>(child: T): T {
		this.children.delete(child);
		child.unload();
		return child;
	}
}

export class TFile {
	extension = 'md';
	stat = { size: 10 };
	basename: string;
	constructor(public path: string) { this.basename = path.split('/').pop()!.replace(/\.md$/, ''); }
}
export class TFolder {
	name: string;
	constructor(public path: string, public children: (TFile | TFolder)[] = []) { this.name = path.split('/').pop()!; }
}
export class ItemView extends Component {
	app: unknown;
	contentEl = { empty() {}, removeClass() {} };
	constructor(leaf: { app: unknown }) { super(); this.app = leaf.app; }
}
export class WorkspaceLeaf {}
export class Menu {}
export class Notice {}
export class SuggestModal {}
export const Platform = { isMobile: false };
export function setIcon(): void { /* UI not exercised */ }
export const prepareFuzzySearch = () => () => null;
export const normalizePath = (path: string) => path;

export function debounce(callback: () => void, timeout: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => { clearTimeout(timer); timer = undefined; return debounced; };
	const run = () => { if (timer !== undefined) { cancel(); callback(); } };
	const debounced = () => { cancel(); timer = setTimeout(run, timeout); return debounced; };
	debounced.cancel = cancel;
	debounced.run = run;
	return debounced;
}
