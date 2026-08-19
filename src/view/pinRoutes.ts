export interface PinRouteIdentity {
	kind: 'node' | 'link';
	nodeId?: string;
	edgeId?: string;
	source?: string;
	target?: string;
	mode: string;
}

export function pinRouteKey(route: PinRouteIdentity): string {
	if (route.kind === 'node') return `node:${route.nodeId ?? ''}:${route.mode}`;
	return `link:${route.edgeId ?? `${route.source ?? ''}->${route.target ?? ''}`}`;
}

export function findPinnedRoute<T extends { key: string }>(pins: readonly T[], route: PinRouteIdentity): T | undefined {
	const key = pinRouteKey(route);
	return pins.find((pin) => pin.key === key);
}

export function canStartPinGrouping(pinCount: number): boolean {
	return pinCount > 0;
}

export function addPinGroupMembership(groupIds: readonly string[], groupId: string): string[] {
	return groupIds.includes(groupId) ? [...groupIds] : [...groupIds, groupId];
}

export function removePinGroupMembership(groupIds: readonly string[], groupId: string): string[] {
	return groupIds.filter((id) => id !== groupId);
}

export function pinBelongsToGroup(groupIds: readonly string[], groupId: string): boolean {
	return groupIds.includes(groupId);
}

export function isPinnedRouteVisible(
	pin: { active: boolean; groupIds: readonly string[] },
	groups: readonly { id: string; visible: boolean }[],
): boolean {
	if (!pin.active) return false;
	const memberships = groups.filter((group) => pin.groupIds.includes(group.id));
	return memberships.length === 0 || memberships.some((group) => group.visible);
}
