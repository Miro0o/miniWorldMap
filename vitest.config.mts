import { defineConfig } from 'vitest/config';
import { build } from 'esbuild';
import path from 'node:path';

export default defineConfig({
	// Layout suites are CPU-heavy. Bound file concurrency so independent large
	// maps do not exhaust the host's cores and trigger unrelated test timeouts.
	test: { maxWorkers: 2, minWorkers: 1 },
	plugins: [{
		name: 'inline-worker-tests',
		resolveId(id, importer) {
			if (id.startsWith('worker:') && importer) return `\0worker:${path.resolve(path.dirname(importer), id.slice(7))}`;
			return null;
		},
		async load(id) {
			if (!id.startsWith('\0worker:')) return;
			const result = await build({ entryPoints: [id.slice(8)], bundle: true, write: false, format: 'iife', target: 'es2021' });
			return `export default ${JSON.stringify(result.outputFiles[0]!.text)}`;
		},
	}],
	resolve: {
		// The npm package contains types only; lifecycle tests supply the host API.
		alias: { obsidian: new URL('./tests/helpers/obsidian.ts', import.meta.url).pathname },
	},
	define: { __GALAXY_DEV__: 'false' },
});
