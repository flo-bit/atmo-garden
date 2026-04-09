/**
 * Allowed tailwind color labels for community accent colors. Matches the
 * non-gray accent palette in @foxui/colors `SelectTheme`. Adding one of
 * these as a class on a wrapper element rebinds the `--accent-*` CSS
 * variables defined by @foxui/core.
 */
export const ACCENT_COLORS = [
	'red',
	'orange',
	'amber',
	'yellow',
	'lime',
	'green',
	'emerald',
	'teal',
	'cyan',
	'sky',
	'blue',
	'indigo',
	'violet',
	'purple',
	'fuchsia',
	'pink',
	'rose'
] as const;

export type AccentColor = (typeof ACCENT_COLORS)[number];

export const DEFAULT_ACCENT_COLOR: AccentColor = 'pink';

export function isAccentColor(x: unknown): x is AccentColor {
	return typeof x === 'string' && (ACCENT_COLORS as readonly string[]).includes(x);
}
