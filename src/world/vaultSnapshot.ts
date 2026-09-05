import { TFile, TFolder, type Vault } from 'obsidian';
import { normalizeVaultPath } from './buildWorldMap';
import { ROOT_ID, type LinkTable, type WorldFileRecord } from './types';

export function* vaultEntries(vault: Vault): Generator<WorldFileRecord> {
	const stack = [...vault.getRoot().children];
	while (stack.length > 0) {
		const entry = stack.pop();
		if (entry instanceof TFolder) {
			const path = normalizeVaultPath(entry.path);
			if (path) yield { path, basename: entry.name, kind: 'folder' };
			if (Array.isArray(entry.children)) {
				for (let index = entry.children.length - 1; index >= 0; index--) {
					const child = entry.children[index];
					if (child) stack.push(child);
				}
			}
		} else if (entry instanceof TFile && entry.extension === 'md' && entry.path !== ROOT_ID) {
			yield { path: entry.path, basename: entry.basename, kind: 'note', size: entry.stat.size };
		}
	}
}

/** Yield between short batches without changing vault traversal/key order. */
export async function collectEntries(vault: Vault, cancelled: () => boolean): Promise<WorldFileRecord[] | null> {
	const records: WorldFileRecord[] = [];
	let start = performance.now();
	for (const entry of vaultEntries(vault)) {
		records.push(entry);
		if (records.length % 256 === 0 && performance.now() - start >= 4) {
			await yieldToUI();
			if (cancelled()) return null;
			start = performance.now();
		}
	}
	return cancelled() ? null : records;
}

/** Own the nested tables: Obsidian may replace or mutate its cache in place. */
export async function snapshotLinks(table: LinkTable, previous: LinkTable | null, cancelled: () => boolean): Promise<LinkTable | null> {
	const sources = Object.keys(table);
	const oldSources = previous ? Object.keys(previous) : [];
	let unchanged = previous !== null && sources.length === oldSources.length;
	const next: LinkTable = Object.create(null) as LinkTable;
	let start = performance.now();
	for (let index = 0; index < sources.length; index++) {
		const source = sources[index]!;
		const targets = table[source] ?? {};
		const oldTargets = previous?.[source];
		const keys = Object.keys(targets);
		const oldKeys = oldTargets ? Object.keys(oldTargets) : [];
		const same = oldTargets !== undefined && keys.length === oldKeys.length
			&& keys.every((key, i) => key === oldKeys[i] && targets[key] === oldTargets[key]);
		next[source] = same ? oldTargets : { ...targets };
		unchanged = unchanged && source === oldSources[index] && same;
		if (index % 256 === 255 && performance.now() - start >= 4) {
			await yieldToUI();
			if (cancelled()) return null;
			start = performance.now();
		}
	}
	return cancelled() ? null : unchanged ? previous : next;
}

function yieldToUI(): Promise<void> {
	// Timers in a hidden Obsidian window can be throttled to a minute per batch.
	// A message task still lets input/rendering run, without timer throttling.
	return new Promise((resolve) => {
		const channel = new MessageChannel();
		channel.port1.onmessage = () => {
			channel.port1.close();
			channel.port2.close();
			resolve();
		};
		channel.port2.postMessage(null);
	});
}
