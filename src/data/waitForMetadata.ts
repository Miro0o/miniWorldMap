import type { Component, MetadataCache } from 'obsidian';

/** Empty/link-free vaults may never emit another resolved event. */
export function waitForMetadata(cache: MetadataCache, owner: Component, timeoutMs = 1600): Promise<void> {
	if (Object.keys(cache.resolvedLinks).length > 0) return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			cache.offref(ref);
			resolve();
		};
		const ref = cache.on('resolved', finish);
		const timer = setTimeout(finish, timeoutMs);
		owner.register(finish);
	});
}
