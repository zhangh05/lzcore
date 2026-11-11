import { create } from "zustand";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export type Density = "comfortable" | "compact";

const THEME_KEY = "lzcore-next:theme";
const DENSITY_KEY = "lzcore-next:density";
const NAV_KEY = "lzcore-next:nav-collapsed";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
  } catch { return fallback; }
}

interface PrefsState {
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  syncTheme: (theme: Theme) => void;
  density: Density;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
  /** Primary navigation collapsed to an icon rail (frees width for canvas pages). */
  navCollapsed: boolean;
  setNavCollapsed: (v: boolean) => void;
}

function apply(theme: Theme, density: Density) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = density;
}

export const usePrefs = create<PrefsState>((set, get) => ({
  theme: read<Theme>(THEME_KEY, ["light", "dark"], "light"),
  themePreference: read<ThemePreference>("lzcore-next:theme-preference", ["light", "dark", "system"], "system"),
  syncTheme: (theme) => { apply(theme, get().density); set({ theme }); },
  setThemePreference: (preference) => {
    const theme = preference === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
    try { localStorage.setItem("lzcore-next:theme-preference", preference); } catch { /* ignore */ }
    apply(theme, get().density); set({ theme, themePreference: preference });
  },
  density: read<Density>(DENSITY_KEY, ["comfortable", "compact"], "comfortable"),
  setTheme: (theme) => { try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ } apply(theme, get().density); set({ theme, themePreference: theme }); },
  setDensity: (density) => { try { localStorage.setItem(DENSITY_KEY, density); } catch { /* ignore */ } apply(get().theme, density); set({ density }); },
  navCollapsed: read<"1" | "0">(NAV_KEY, ["1", "0"], "0") === "1",
  setNavCollapsed: (v) => { try { localStorage.setItem(NAV_KEY, v ? "1" : "0"); } catch { /* ignore */ } set({ navCollapsed: v }); },
}));

export function applyStoredPrefs() {
  const desktop = window.__LZCORE_DESKTOP__;
  if (desktop) {
    if (desktop.platform === "win32") document.documentElement.dataset.desktopPlatform = "win32";
    usePrefs.setState({ theme: desktop.theme, themePreference: desktop.ui?.themePreference ?? "system" });
  }
  const { theme, density } = usePrefs.getState();
  apply(theme, density);
}

/** 用户 + 工作区作用域的本地键（迁自 utils/userScope 的思路）。 */
export function scopedKey(user: string | undefined, key: string): string {
  return `lzcore-next:${user || "local"}:${key}`;
}
