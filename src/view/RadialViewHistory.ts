import type { VisibleGraphState } from '../world/types';

export interface RadialViewEntry {
	state: VisibleGraphState;
	view: { centerX: number; centerY: number; zoom: number };
}

/** Navigation stores small view descriptions, never graphs or render resources. */
export class RadialViewHistory {
	private entries: RadialViewEntry[] = [];
	private cursor = -1;

	get current(): RadialViewEntry | undefined { return this.entries[this.cursor]; }
	get canGoBack(): boolean { return this.cursor > 0; }
	get canGoForward(): boolean { return this.cursor < this.entries.length - 1; }

	peek(direction: -1 | 1): RadialViewEntry | undefined {
		return this.entries[this.cursor + direction];
	}

	replaceCurrent(entry: RadialViewEntry): void {
		if (this.cursor < 0) this.push(entry);
		else this.entries[this.cursor] = entry;
	}

	push(entry: RadialViewEntry): void {
		const previous = this.current?.state;
		const next = entry.state;
		if (previous && previous.mode === next.mode && previous.rootPath === next.rootPath
			&& previous.focusPath === next.focusPath && previous.showCompleteRoot === next.showCompleteRoot) {
			this.replaceCurrent(entry);
			return;
		}
		this.entries.splice(this.cursor + 1);
		this.entries.push(entry);
		if (this.entries.length > 100) this.entries.shift();
		this.cursor = this.entries.length - 1;
	}

	go(direction: -1 | 1): void {
		if (this.peek(direction)) this.cursor += direction;
	}
}
