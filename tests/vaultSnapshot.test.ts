import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Vault } from 'obsidian';
import { TFile, TFolder } from './helpers/obsidian';
import { collectEntries, snapshotLinks } from '../src/world/vaultSnapshot';
import type { LinkTable } from '../src/world/types';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function forceBatches() {
	vi.useFakeTimers();
	let time = 0;
	vi.spyOn(performance, 'now').mockImplementation(() => (time += 8));
}

describe('vault snapshot batches', () => {
	it('finishes file batches without advancing timers and preserves traversal order', async () => {
		forceBatches();
		const notes = Array.from({ length: 800 }, (_, i) => new TFile(`A/${i}.md`));
		const root = new TFolder('', [new TFolder('A', notes), new TFile('last.md')]);
		const vault = { getRoot: () => root } as unknown as Vault;
		const result = await collectEntries(vault, () => false);
		expect(result?.map((entry) => entry.path)).toEqual(['last.md', 'A', ...notes.map((note) => note.path)]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('finishes link batches without timers and detects in-place edits', async () => {
		forceBatches();
		const table: LinkTable = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`${i}.md`, { target: i }]));
		const first = await snapshotLinks(table, null, () => false);
		expect(await snapshotLinks(table, first, () => false)).toBe(first);
		table['0.md']!.target = 20;
		const changed = await snapshotLinks(table, first, () => false);
		expect(changed?.['0.md']!.target).toBe(20);
		expect(first?.['0.md']!.target).toBe(0);
		expect(Object.keys(changed!)).toEqual(Object.keys(table));
		expect(vi.getTimerCount()).toBe(0);
	});

	it('abandons an invalidated scan at the next batch boundary', async () => {
		forceBatches();
		const root = new TFolder('', Array.from({ length: 800 }, (_, i) => new TFile(`${i}.md`)));
		let cancelled = false;
		const pending = collectEntries({ getRoot: () => root } as unknown as Vault, () => cancelled);
		cancelled = true;
		expect(await pending).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});
});
