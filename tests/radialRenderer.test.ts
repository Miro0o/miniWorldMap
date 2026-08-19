import { describe, expect, it } from 'vitest';
import { radialEdgeHighlightKind, radialNodeColorKind } from '../src/render/RadialRenderer';
import type { WorldEdge, WorldNode } from '../src/world/types';

function edge(overrides: Partial<WorldEdge> = {}): WorldEdge {
	return {
		id: 'edge',
		type: 'visible-link',
		source: 'A',
		target: 'B',
		weight: 1,
		...overrides,
	};
}

function node(overrides: Partial<WorldNode> = {}): WorldNode {
	return {
		id: 'Note.md',
		path: 'Note.md',
		title: 'Note',
		type: 'note',
		parentId: '',
		depth: 1,
		noteCount: 1,
		linkCount: 0,
		backlinkCount: 0,
		descendantCount: 0,
		...overrides,
	};
}

describe('2D semantic highlight colors', () => {
	it('classifies hierarchy, note, outside, and unresolved routes separately', () => {
		expect(radialEdgeHighlightKind(edge({ type: 'hierarchy' }))).toBe('hierarchy');
		expect(radialEdgeHighlightKind(edge())).toBe('note-link');
		expect(radialEdgeHighlightKind(edge({ externalCount: 1 }))).toBe('outside-link');
		expect(radialEdgeHighlightKind(edge({ type: 'external-hierarchy' }))).toBe('outside-link');
		expect(radialEdgeHighlightKind(edge({ unresolvedCount: 1 }))).toBe('unresolved-link');
	});
});

describe('2D semantic node colors', () => {
	it('classifies the three internal node types separately', () => {
		expect(radialNodeColorKind(node({ type: 'folder' }), '')).toBe('folder');
		expect(radialNodeColorKind(node({ type: 'folder', representativeFile: 'Topic/Topic.md' }), '')).toBe('folder-note');
		expect(radialNodeColorKind(node(), '')).toBe('note');
	});

	it('distinguishes exact outside notes from grouped outside branches', () => {
		expect(radialNodeColorKind(node({ externalProxy: true }), '')).toBe('outside-note');
		expect(radialNodeColorKind(node({ type: 'external' }), '')).toBe('outside-group');
	});
});
