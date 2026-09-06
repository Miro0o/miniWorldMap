# 2D loading comparison — 2026-09-06

The regression comes primarily from the new hierarchy-clearance and sibling-layout passes. These preserve the newer spacing and branch geometry, but evaluating many candidate positions repeats expensive collision searches.

The optimization keeps the same placement rules. It narrows collision searches when branch protection is disabled, prunes the empty corners around diagonal edges, and rechecks recently blocking pairs before building temporary indexes. It also retains two completed layouts per view across rebuilds and 2D/3D controller changes. The complete refreshed graph and layout options must match before reuse; cached coordinates are copied to isolate animation/mutation, and closing the view clears the cache.

## Measurement

Baseline: `ad66e4a` (`performance fix`). “Before” is the uncommitted source captured at the start of this task; “optimized” is the resulting source. Each version used the same synthetic records and settings, with production-minified worker bundles running on actual Node worker threads. Each value below is the median of three independent cycles. Each cycle measures cold load, same-controller rebuild, then a new controller sharing the same view cache.

Environment: Intel Core i7-1068NG7 @ 2.30 GHz, macOS x64, Node 26.7.0. Settings: complete-root graph, depth 80, node limit 20,000, ring spacing 1,160, node spacing 144, spin 10, no note-link edges. “Wide” groups 100 notes per folder; “deep” adds another hierarchy level per 100 notes and ten topic folders per level.

**These are data-computation times, not measured Obsidian click-to-visible times.** Totals include model construction, visible-graph construction, worker startup/transfer where applicable, layout and cache lookup/copy. They exclude vault enumeration, metadata-readiness waits, WebGL, DOM labels and reveal animation. The benchmark always rebuilds the model; the app can reuse it when unchanged.

| Graph | Action | Commit | Before | Optimized |
| --- | --- | ---: | ---: | ---: |
| 1,011 nodes, wide | Cold load | 0.079 s | 0.685 s | 0.360 s |
| 1,011 nodes, wide | Rebuild, unchanged data | 0.032 s | 0.594 s | 0.016 s |
| 1,011 nodes, wide | Return to 2D, unchanged data | 0.095 s | 0.732 s | 0.053 s |
| 3,940 nodes, wide | Cold load | 0.160 s | 7.387 s | 2.128 s |
| 3,940 nodes, wide | Rebuild, unchanged data | 0.103 s | 8.004 s | 0.060 s |
| 3,940 nodes, wide | Return to 2D, unchanged data | 0.164 s | 7.249 s | 0.102 s |
| 1,111 nodes, deep | Cold load | 0.091 s | 2.360 s | 1.597 s |
| 1,111 nodes, deep | Rebuild, unchanged data | 0.045 s | 2.230 s | 0.023 s |
| 1,111 nodes, deep | Return to 2D, unchanged data | 0.092 s | 2.296 s | 0.058 s |

At 3,940 nodes, the cold computation drops from 7.387 s to 2.128 s (71% less). Rebuilds drop from 8.004 s to 0.060 s, and returning to 2D drops from 7.249 s to 0.102 s when the inputs are unchanged. The cold path remains slower than the commit because the newer layout rules do more work. A changed graph or an evicted cache entry still takes the cold layout path.

## Reproduction

```sh
node scripts/benchmark-radial.mjs ad66e4a
```

To include a saved pre-optimization source tree:

```sh
node scripts/benchmark-radial.mjs ad66e4a /path/to/saved/src
```

`MWM_BENCH_ROUNDS` controls repetitions (default 3); `MWM_BENCH_SIZES` controls wide-map note counts (default `1000,3900`). The deep case uses the smallest requested size. Run without concurrent test/profile workloads. All 81 samples with per-stage timings are in [the measurement CSV](radial-load-2026-09-06.csv).

## Validation

- All 224 tests across 26 suites pass, including layout quality, hierarchy crossings, sibling spacing, label placement, picking, camera/interaction behavior, cache invalidation and worker lifecycle.
- Full layout objects match the captured pre-optimization implementation exactly in 360 generated linked-map cases (60 seeds × 2 roots × 3 spin settings), plus the 3,940-node wide map at spin 0, 10 and 100. Comparisons include positions, rings, routes and bounds, not only screenshots.
- Production build, TypeScript checks, ESLint and `git diff --check` pass. The root `main.js` and `dist/` assets have been rebuilt.
- No live Obsidian GUI timing or screenshot comparison was performed. The renderer's visual settings and reveal animation were preserved; the measured improvement applies to the computation portion of loading.
