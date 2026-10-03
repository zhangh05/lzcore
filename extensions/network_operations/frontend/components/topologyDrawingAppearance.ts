import type { TopologyLink } from './TopologyWorkspace';

/** Drawing defaults are independent of observation, selection and UI theme. */
export const DRAWING_DEFAULTS = { link: '#66717a', nodeBorder: '#8a949e', nodeBorderWidth: 1.5 };

export function isDrawingColor(value: string): boolean {
  if (!/^(#[\da-f]{3,8}|rgba?\([\d\s,.%]+\)|[a-z]{1,24})$/i.test(value)) return false;
  if (typeof CSS !== 'undefined' && CSS.supports) return CSS.supports('color', value);
  return /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value) || /^(rgba?\(|[a-z])/i.test(value);
}

export function linkDrawingAppearance(link: Pick<TopologyLink, 'style'> & Partial<Pick<TopologyLink, 'status' | 'kind'>>) {
  const stored = link.style?.color?.trim();
  const custom = Boolean(stored && isDrawingColor(stored));
  const width = typeof link.style?.width === 'number' && Number.isFinite(link.style.width) ? link.style.width : link.status === 'down' ? 3 : 2.5;
  const lineStyle = link.style?.line_style || (link.status === 'down' ? 'dotted' : link.kind === 'logical' ? 'dashed' : 'solid');
  return { color: custom ? stored! : DRAWING_DEFAULTS.link, source: custom ? 'custom' : 'default', width, lineStyle } as const;
}

/** Preserve stored CSS colours; native pickers need a six-digit RGB value. */
export function drawingColorHex(color: string): string {
  if (/^#[\da-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(color)) return '#' + [...color.slice(1)].map(c => c + c).join('').toLowerCase();
  if (/^#[\da-f]{8}$/i.test(color)) return color.slice(0, 7).toLowerCase();
  if (typeof document !== 'undefined') {
    const sample = document.createElement('span');
    sample.style.color = color;
    document.documentElement.appendChild(sample);
    const resolved = getComputedStyle(sample).color;
    sample.remove();
    const rgb = resolved.match(/^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (rgb) return '#' + rgb.slice(1, 4).map(c => Number(c).toString(16).padStart(2, '0')).join('');
  }
  return DRAWING_DEFAULTS.link;
}

/** View-only narrow underlay; never replaces the original core stroke. */
export function drawingContrastUnderlay(color: string, dark: boolean): { color: string; opacity: number } {
  const rgb = drawingColorHex(color).slice(1).match(/../g)!.map(c => parseInt(c, 16) / 255);
  const linear = rgb.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  // Canvas surface: white in light mode, #181c1f in dark mode.
  const background = dark ? 0.0113 : 1;
  const contrast = (Math.max(luminance, background) + 0.05) / (Math.min(luminance, background) + 0.05);
  return { color: dark ? '#d7dee1' : '#566368', opacity: contrast < 3 ? 0.8 : 0 };
}

export function topologyLinkColor(link: Pick<TopologyLink, 'style'>): string {
  return linkDrawingAppearance(link).color;
}
