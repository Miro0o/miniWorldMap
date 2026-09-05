import type { RadialSettings } from '../settings';
import { layoutRadialGraph, type RadialLayout, type RadialLayoutOptions } from '../layout/radial/layoutRadial';
import { buildWorldMap } from './buildWorldMap';
import type { LinkTable, VisibleWorldGraph, WorldFileRecord, WorldModel } from './types';

export interface WorldSnapshot {
	records: WorldFileRecord[];
	resolved: LinkTable;
	unresolved: LinkTable;
	settings: Pick<RadialSettings, 'includeUnresolvedLinks' | 'ignoreFolders'>;
	rootTitle: string;
}

export type ComputationTask =
	| { type: 'model'; snapshot: WorldSnapshot }
	| { type: 'layout'; graph: VisibleWorldGraph; options: RadialLayoutOptions };
export type ComputationResult = WorldModel | RadialLayout;
export type ComputationRequest = ComputationTask & { id: number };
export type ComputationResponse = { id: number } & ({ result: ComputationResult } | { error: string });

/** Both execution paths call the same algorithms, with the same input order. */
export function compute(task: ComputationTask): ComputationResult {
	if (task.type === 'layout') return layoutRadialGraph(task.graph, task.options);
	const { records, resolved, unresolved, settings, rootTitle } = task.snapshot;
	return buildWorldMap(records, resolved, unresolved, settings, rootTitle);
}
