// What the workspace needs before its first paint: the density, theme and
// palette ride on the page URL (see renderer/boot.js), so a compact user never
// sees the comfortable layout flash before the first state push.
import { THEMES, PALETTES } from './themes.js';

export function bootQuery(config = {}) {
  const query = {};
  if (config.density === 'compact' || config.density === 'comfortable') query.density = config.density;
  if (typeof config.theme === 'string' && Object.hasOwn(THEMES, config.theme)) query.theme = config.theme;
  if (typeof config.palette === 'string' && Object.hasOwn(PALETTES, config.palette)) query.palette = config.palette;
  return query;
}
