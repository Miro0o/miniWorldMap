import { describe, expect, it } from 'vitest';
import {
	addPinGroupMembership,
	canStartPinGrouping,
	findPinnedRoute,
	isPinnedRouteVisible,
	pinBelongsToGroup,
	pinRouteKey,
	removePinGroupMembership,
	type PinRouteIdentity,
} from '../src/view/pinRoutes';

describe('pinned route identity', () => {
	it('keeps grouping discoverable after the first distinct route is pinned', () => {
		expect(canStartPinGrouping(0)).toBe(false);
		expect(canStartPinGrouping(1)).toBe(true);
		expect(canStartPinGrouping(2)).toBe(true);
	});

	it('uses one stable key for repeated pins of the same node route', () => {
		const route: PinRouteIdentity = { kind: 'node', nodeId: 'Atlas/Topic.md', mode: 'all-links' };
		const key = pinRouteKey(route);
		expect(pinRouteKey({ ...route })).toBe(key);
		expect(findPinnedRoute([{ key, id: 'pin-1' }], route)?.id).toBe('pin-1');
	});

	it('keeps genuinely different node routes distinct', () => {
		const allLinks = pinRouteKey({ kind: 'node', nodeId: 'Atlas/Topic.md', mode: 'all-links' });
		const parents = pinRouteKey({ kind: 'node', nodeId: 'Atlas/Topic.md', mode: 'hierarchy-parents' });
		expect(allLinks).not.toBe(parents);
	});

	it('uses the graph edge identity for a pinned note-link route', () => {
		const route: PinRouteIdentity = {
			kind: 'link',
			edgeId: 'visible-link:Atlas/A.md->Atlas/B.md',
			source: 'Atlas/A.md',
			target: 'Atlas/B.md',
			mode: 'note-links',
		};
		expect(pinRouteKey(route)).toBe('link:visible-link:Atlas/A.md->Atlas/B.md');
	});
});

describe('pinned route group membership', () => {
	it('allows one route to belong to multiple groups', () => {
		let groupIds = addPinGroupMembership([], 'group-a');
		groupIds = addPinGroupMembership(groupIds, 'group-b');

		expect(pinBelongsToGroup(groupIds, 'group-a')).toBe(true);
		expect(pinBelongsToGroup(groupIds, 'group-b')).toBe(true);
	});

	it('removes only the requested membership', () => {
		const groupIds = removePinGroupMembership(['group-a', 'group-b'], 'group-a');
		expect(groupIds).toEqual(['group-b']);
	});

	it('does not duplicate membership within the same group', () => {
		expect(addPinGroupMembership(['group-a'], 'group-a')).toEqual(['group-a']);
	});

	it('keeps a shared route visible through any shown group', () => {
		const pin = { active: true, groupIds: ['group-a', 'group-b'] };
		expect(isPinnedRouteVisible(pin, [{ id: 'group-a', visible: false }, { id: 'group-b', visible: true }])).toBe(true);
		expect(isPinnedRouteVisible(pin, [{ id: 'group-a', visible: false }, { id: 'group-b', visible: false }])).toBe(false);
	});

	it('lets route visibility override and ungrouped routes behave independently', () => {
		expect(isPinnedRouteVisible({ active: false, groupIds: ['group-a'] }, [{ id: 'group-a', visible: true }])).toBe(false);
		expect(isPinnedRouteVisible({ active: true, groupIds: [] }, [])).toBe(true);
	});
});
