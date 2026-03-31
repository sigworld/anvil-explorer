export type ThemePreference = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'anvil-explorer.theme'

const SYSTEM_THEME_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark'
}

export function getStoredThemePreference() {
  const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY)
  return isThemePreference(storedValue) ? storedValue : getSystemTheme()
}

export function getSystemTheme(): ThemePreference {
  return window.matchMedia(SYSTEM_THEME_QUERY).matches ? 'dark' : 'light'
}

export function applyThemePreference(preference: ThemePreference) {
  document.documentElement.dataset.theme = preference
  document.documentElement.dataset.themePreference = preference
  document.documentElement.style.colorScheme = preference
}
