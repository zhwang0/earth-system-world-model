/**
 * icons.js — the intervention glyphs the lab's scenario tiles and the twin's tools share.
 * 24 x 24 stroke paths, drawn with currentColor.
 */
export const ICON = {
  leaf: 'M5 21c0-7 4-12 14-14 0 9-5 14-14 14Zm0 0c1-4 3-6 6-8',
  axe: 'M14 3 21 10l-3 3-2-2-7 7-2.5.5L6 21l-3-3 .5-2.5L4 15l7-7-2-2 3-3Z',
  flame: 'M12 22c4 0 7-3 7-7 0-5-5-6-4-11-4 2-6 5-6 8 0-1-1-2-2-3-1 2-2 4-2 6 0 4 3 7 7 7Z',
  scissors: 'M6 3l12 12M18 3 6 15M8 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Zm13 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z',
  sprout: 'M12 22V11m0 0C12 7 9 4 4 4c0 5 3 7 8 7Zm0 0c0-3 2-6 8-6 0 4-3 6-8 6Z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  target: 'M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20Zm0-5a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-4a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z',
  eraser: 'M20 20H9l-5-5a1.5 1.5 0 0 1 0-2.1l8.9-8.9a1.5 1.5 0 0 1 2.1 0l5 5a1.5 1.5 0 0 1 0 2.1L12 19M8 11l6 6',
};

/** An inline SVG for a glyph, sized and stroked by CSS. */
export const svgIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
