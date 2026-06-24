export type ObsidianThemeScheme = 'day' | 'night';

export const DEFAULT_MAP_BACKGROUNDS: Record<ObsidianThemeScheme, string> = {
	day: '#f8fafc',
	night: '#1e1e1e',
};

export function resolveObsidianBackground(scheme: ObsidianThemeScheme, fallback: string | number = DEFAULT_MAP_BACKGROUNDS[scheme]): string {
	const sampled = sampleObsidianBackground(scheme);
	if (sampled && fitsScheme(sampled, scheme)) return sampled;
	return colorFallbackToCss(fallback);
}

function sampleObsidianBackground(scheme: ObsidianThemeScheme): string | null {
	const doc = activeDocument;
	const body = doc.body;
	const target = scheme === 'night' ? 'theme-dark' : 'theme-light';
	const other = scheme === 'night' ? 'theme-light' : 'theme-dark';
	const hadLight = body.classList.contains('theme-light');
	const hadDark = body.classList.contains('theme-dark');
	try {
		if (!body.classList.contains(target) || body.classList.contains(other)) {
			body.classList.remove(other);
			body.classList.add(target);
		}
		const style = doc.defaultView?.getComputedStyle(body) ?? getComputedStyle(body);
		return normalizeCssColor(style.getPropertyValue('--background-primary').trim() || style.backgroundColor);
	} finally {
		body.classList.toggle('theme-light', hadLight);
		body.classList.toggle('theme-dark', hadDark);
	}
}

function normalizeCssColor(value: string): string | null {
	const doc = activeDocument;
	const body = doc.body;
	const probe = doc.createElement('span');
	probe.style.color = value;
	if (!probe.style.color) return null;
	probe.style.display = 'none';
	body.appendChild(probe);
	try {
		const computed = doc.defaultView?.getComputedStyle(probe).color ?? getComputedStyle(probe).color;
		return rgbStringToHex(computed);
	} finally {
		probe.remove();
	}
}

function colorFallbackToCss(value: string | number): string {
	if (typeof value === 'number') return `#${value.toString(16).padStart(6, '0')}`;
	return value;
}

function fitsScheme(color: string, scheme: ObsidianThemeScheme): boolean {
	const rgb = hexToRgb(color);
	if (!rgb) return false;
	const luminance = relativeLuminance(rgb);
	return scheme === 'day' ? luminance >= 0.5 : luminance <= 0.45;
}

function rgbStringToHex(value: string): string | null {
	if (value.trim().toLowerCase() === 'transparent') return null;
	const match = value.match(/^rgba?\((.*)\)$/i);
	if (!match) return expandHex(value);
	const parts = match[1]
		?.replaceAll(',', ' ')
		.split(/[ /]+/)
		.map((part) => part.trim())
		.filter(Boolean);
	if (!parts || parts.length < 3) return null;
	const alpha = parts[3] === undefined ? 1 : parseAlpha(parts[3]);
	if (alpha === null || alpha <= 0.05) return null;
	const channels = parts.slice(0, 3).map(parseChannel);
	if (channels.some((channel) => channel === null)) return null;
	return `#${channels.map((channel) => channel!.toString(16).padStart(2, '0')).join('')}`;
}

function expandHex(value: string): string | null {
	const trimmed = value.trim();
	const short = trimmed.match(/^#([0-9a-f]{3})$/i);
	if (short?.[1]) return `#${[...short[1]].map((part) => `${part}${part}`).join('').toLowerCase()}`;
	const full = trimmed.match(/^#([0-9a-f]{6})$/i);
	return full?.[1] ? `#${full[1].toLowerCase()}` : null;
}

function parseChannel(value: string): number | null {
	if (value.endsWith('%')) {
		const percent = Number.parseFloat(value);
		return Number.isFinite(percent) ? clampByte((percent / 100) * 255) : null;
	}
	const channel = Number.parseFloat(value);
	return Number.isFinite(channel) ? clampByte(channel) : null;
}

function parseAlpha(value: string): number | null {
	if (value.endsWith('%')) {
		const percent = Number.parseFloat(value);
		return Number.isFinite(percent) ? clampUnit(percent / 100) : null;
	}
	const alpha = Number.parseFloat(value);
	return Number.isFinite(alpha) ? clampUnit(alpha) : null;
}

function clampByte(value: number): number {
	return Math.min(255, Math.max(0, Math.round(value)));
}

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, value));
}

function hexToRgb(value: string): { r: number; g: number; b: number } | null {
	const hex = expandHex(value);
	if (!hex) return null;
	return {
		r: Number.parseInt(hex.slice(1, 3), 16),
		g: Number.parseInt(hex.slice(3, 5), 16),
		b: Number.parseInt(hex.slice(5, 7), 16),
	};
}

function relativeLuminance(rgb: { r: number; g: number; b: number }): number {
	const convert = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * convert(rgb.r) + 0.7152 * convert(rgb.g) + 0.0722 * convert(rgb.b);
}
