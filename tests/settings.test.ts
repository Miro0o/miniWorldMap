import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../src/settings';

describe('Mini World Map settings migration', () => {
	it('defaults to 2D radial mode and preserves legacy radial keys', () => {
		const settings = mergeSettings({
			atlasDepth: 9,
			linkLimit: 42,
			renderNodeLimit: 900,
			includeUnresolvedLinks: false,
			showLinkOverlay: false,
			hoverHighlightMode: 'note-links',
			hoverTargetMode: 'both',
			hiddenLegendItems: ['link', 'bogus'],
			ignoreFolders: ['.trash'],
		});
		expect(settings.language).toBe('en');
		expect(settings.viewMode).toBe('radial2d');
		expect(settings.radial.atlasDepth).toBe(9);
		expect(settings.radial.linkLimit).toBe(42);
		expect(settings.radial.renderNodeLimit).toBe(900);
		expect(settings.radial.includeUnresolvedLinks).toBe(false);
		expect(settings.radial.showLinkOverlay).toBe(true);
		expect(settings.radial.hoverHighlightMode).toBe('note-links');
		expect(settings.radial.hoverTargetMode).toBe('both');
		expect(settings.radial.hiddenLegendItems).toEqual(['link']);
		expect(settings.radial.ignoreFolders).toEqual(['.trash']);
	});

	it('defaults 2D hover targets to nodes only', () => {
		expect(mergeSettings({}).radial.hoverTargetMode).toBe('nodes');
		expect(mergeSettings({ radial: { hoverTargetMode: 'links' } }).radial.hoverTargetMode).toBe('links');
		expect(mergeSettings({ radial: { hoverTargetMode: 'anything' } }).radial.hoverTargetMode).toBe('nodes');
	});

	it('preserves intentional nested 2D note-link visibility', () => {
		expect(mergeSettings({ radial: { showLinkOverlay: false } }).radial.showLinkOverlay).toBe(false);
	});

	it('defaults radial ring guides off but preserves the panel option', () => {
		expect(mergeSettings({}).radial.showRingGuides).toBe(false);
		expect(mergeSettings({ radial: { showRingGuides: true } }).radial.showRingGuides).toBe(true);
	});

	it('normalizes the shared language option', () => {
		expect(mergeSettings({ language: 'zh' }).language).toBe('zh');
		expect(mergeSettings({ language: 'fr' }).language).toBe('en');
	});

	it('keeps Galaxy settings nested for 3D map mode', () => {
		const settings = mergeSettings({
			viewMode: 'map3d',
			galaxy3d: {
				cruise: false,
				bloom: { strength: 1.2 },
				physics: { repel: 123 },
				look: { sizeBy: 'fileSize' },
			},
		});
		expect(settings.viewMode).toBe('map3d');
		expect(settings.galaxy3d.cruise).toBe(false);
		expect(settings.galaxy3d.bloom.strength).toBe(1.2);
		expect(settings.galaxy3d.physics.repel).toBe(123);
		expect(settings.galaxy3d.look.sizeBy).toBe('fileSize');
		expect(settings.galaxy3d.preset).toBe('auto');
		expect(mergeSettings({ galaxy3d: { preset: 'adaptive' } }).galaxy3d.preset).toBe('auto');
	});
});
