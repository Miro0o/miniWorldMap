// CPU/worker portion of 2D loading. Excludes vault I/O, WebGL and reveal animation.
// node scripts/benchmark-radial.mjs [git-ref=HEAD] [saved-src-directory]
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveObjectURL } from 'node:buffer';
import { Worker } from 'node:worker_threads';

const root = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(tmpdir(), 'mwm-benchmark-'));
const ref = process.argv[2] ?? 'HEAD';
const rounds = Number(process.env.MWM_BENCH_ROUNDS ?? 3);
const sizes = (process.env.MWM_BENCH_SIZES ?? '1000,3900').split(',').map(Number);

// Run the production Blob worker protocol on actual worker threads in Node.
class BrowserWorker {
  constructor(url) {
    this.ready = resolveObjectURL(url).text().then((source) => {
      if (this.stopped) return;
      this.worker = new Worker(`const { parentPort } = require('node:worker_threads');
        global.self = { postMessage: data => parentPort.postMessage(data) };
        ${source}
        parentPort.on('message', data => self.onmessage({ data }));`, { eval: true });
      this.worker.on('message', (data) => this.onmessage?.({ data }));
      this.worker.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
    });
  }
  postMessage(message) { void this.ready.then(() => this.worker?.postMessage(message)); }
  terminate() { this.stopped = true; void this.worker?.terminate(); }
}
globalThis.Worker = BrowserWorker;

async function bundle(name, sourceRoot) {
  const cacheFile = path.join(sourceRoot, 'world/RadialLayoutCache.ts');
  const resultFile = path.join(scratch, `${name}.mjs`);
  await build({
    stdin: { contents: `export { buildVisibleWorldGraph, defaultVisibleGraphState } from './world/visibleGraph';
      export { WorldMapComputation } from './world/WorldMapComputation';
      export { DEFAULT_RADIAL_SETTINGS } from './settings';
      ${existsSync(cacheFile) ? "export { RadialLayoutCache } from './world/RadialLayoutCache';" : 'export class RadialLayoutCache {}'}`,
      resolveDir: sourceRoot, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'es2021', minify: true, outfile: resultFile,
    plugins: [{ name: 'worker', setup(builder) {
      builder.onResolve({ filter: /^worker:/ }, (args) => ({ path: path.resolve(path.dirname(args.importer), args.path.slice(7)), namespace: 'worker' }));
      builder.onLoad({ filter: /.*/, namespace: 'worker' }, async (args) => {
        const result = await build({ entryPoints: [args.path], bundle: true, write: false, format: 'iife', target: 'es2021', minify: true });
        return { contents: result.outputFiles[0].text, loader: 'text' };
      });
    } }],
  });
  return { name, api: await import(pathToFileURL(resultFile)) };
}

function fixture(count, shape) {
  return Array.from({ length: count }, (_, i) => ({
    path: shape === 'deep' ? `Archive/${'Next/'.repeat(Math.floor(i / 100))}Topic ${Math.floor(i % 100 / 10)}/Note ${i}.md` : `Topic ${Math.floor(i / 100)}/Note ${i}.md`,
    basename: `Note ${i}`, kind: 'note',
  }));
}

try {
  const baseline = path.join(scratch, 'baseline');
  mkdirSync(baseline);
  const archive = execFileSync('git', ['archive', ref, 'src'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  const archivePath = path.join(scratch, 'baseline.tar');
  writeFileSync(archivePath, archive);
  execFileSync('tar', ['-xf', archivePath, '-C', baseline]);
  const versions = [await bundle(ref, path.join(baseline, 'src'))];
  if (process.argv[3]) versions.push(await bundle('before', path.resolve(process.argv[3])));
  versions.push(await bundle('working', path.join(root, 'src')));
  const rows = [];
  const cases = [...sizes.map((count) => ({ shape: 'wide', count })), { shape: 'deep', count: Math.min(...sizes) }];
  for (const { shape, count } of cases) {
    const records = fixture(count, shape);
    for (let round = 0; round < rounds; round++) for (const { name, api } of versions) {
      const settings = { ...api.DEFAULT_RADIAL_SETTINGS, atlasDepth: 80, renderNodeLimit: 20000, swirlStrength: 10 };
      const cache = new api.RadialLayoutCache();
      // Rebuild and switch-back both refresh model/graph data before cache lookup.
      let computation = new api.WorldMapComputation(cache);
      for (const action of ['cold', 'rebuild', 'switch-back']) {
        if (action === 'switch-back') { computation.dispose(); computation = new api.WorldMapComputation(cache); }
        try {
          const start = performance.now();
          const model = await computation.buildModel({ records, resolved: {}, unresolved: {}, settings, rootTitle: 'Benchmark' });
          const indexed = performance.now();
          const graph = api.buildVisibleWorldGraph(model, { ...api.defaultVisibleGraphState(settings), showCompleteRoot: true }, settings);
          const visible = performance.now();
          await computation.layout(graph, { ringSpacing: 1160, nodeSpacing: 144, swirlStrength: 10 });
          const end = performance.now();
          const row = { version: name, shape, records: count, nodes: graph.nodes.length, round, action,
            modelMs: indexed - start, visibleMs: visible - indexed, layoutMs: end - visible, totalMs: end - start };
          rows.push(row);
          console.log(JSON.stringify(row));
        } catch (error) { computation.dispose(); throw error; }
      }
      computation.dispose();
    }
  }
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.version}/${row.shape}/${row.records}/${row.action}`;
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const summary = [...groups].map(([caseName, group]) => ({ case: caseName, nodes: group[0].nodes,
    layoutMs: median(group.map((row) => row.layoutMs)), totalMs: median(group.map((row) => row.totalMs)) }));
  console.log(JSON.stringify({ environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch }, rounds, summary }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
