export const FONT_SCALE_STORAGE_KEY = "session-viewer-font-scale";
export const FONT_SCALE_MIN = 0.9;
export const FONT_SCALE_MAX = 1.6;
export const FONT_SCALE_STEP = 0.1;
export const FONT_SCALE_DEFAULT = 1;

export function normalizeFontScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return FONT_SCALE_DEFAULT;
  const rounded = Math.round(parsed / FONT_SCALE_STEP) * FONT_SCALE_STEP;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Number(rounded.toFixed(1))));
}

export function adjustFontScale(current, direction) {
  return normalizeFontScale(Number(current) + Math.sign(direction) * FONT_SCALE_STEP);
}

export function loadFontScale(storage) {
  try {
    const storedValue = storage?.getItem(FONT_SCALE_STORAGE_KEY);
    return storedValue == null || storedValue === "" ? FONT_SCALE_DEFAULT : normalizeFontScale(storedValue);
  } catch {
    return FONT_SCALE_DEFAULT;
  }
}

export function saveFontScale(storage, value) {
  const normalized = normalizeFontScale(value);
  try {
    storage?.setItem(FONT_SCALE_STORAGE_KEY, String(normalized));
  } catch {
    // The live preference still applies when browser storage is unavailable.
  }
  return normalized;
}
