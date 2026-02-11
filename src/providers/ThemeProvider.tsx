import React, { createContext, useContext, useState, useEffect } from 'react';
import { invoke } from '../lib/tauri-mock';
import type { AppSettings } from '../types/bindings';

// Theme type definition
export type ThemeValue = 'light' | 'dark' | 'system';

// Context value interface
export interface ThemeContextValue {
  theme: ThemeValue;
  setTheme: (theme: ThemeValue) => Promise<void>;
  systemTheme: 'light' | 'dark';
  isReady: boolean;
}

// Create the context
const ThemeContext = createContext<ThemeContextValue | null>(null);

// Helper function to detect system theme preference
function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Helper function to apply theme to DOM
function applyTheme(theme: ThemeValue, systemTheme: 'light' | 'dark'): void {
  const isDark = theme === 'dark' || (theme === 'system' && systemTheme === 'dark');
  const htmlElement = document.documentElement;

  if (isDark) {
    htmlElement.classList.add('dark');
  } else {
    htmlElement.classList.remove('dark');
  }
}

// Helper function to load and inject system accent color
function loadSystemAccentColor(): void {
  try {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    // Light mode: darker blue for WCAG AA compliance (8.51:1)
    // Dark mode: lighter blue for dark mode readability (5.20:1)
    const accentColor = isDark ? '217 91% 71%' : '217 91% 35%';
    document.documentElement.style.setProperty('--accent', accentColor);
    console.log('[Theme] Accent color set to:', accentColor);
  } catch (err) {
    console.error('[Theme] Failed to set accent color:', err);
  }
}

// ThemeProvider component
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeValue>('system');
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>('light');
  const [isReady, setIsReady] = useState(false);

  // Initialize theme from database and system preference on mount
  useEffect(() => {
    async function initializeTheme() {
      try {
        // Detect system theme
        const system = getSystemTheme();
        setSystemTheme(system);

        // Load saved theme preference from database
        const settings = await invoke<AppSettings>('get_settings');
        const savedTheme = (settings.theme_preference as ThemeValue) || 'system';
        setThemeState(savedTheme);

        // Apply theme to DOM
        applyTheme(savedTheme, system);

        // Load and inject system accent color
        loadSystemAccentColor();
      } catch (err) {
        console.error('Failed to load theme settings, using system theme:', err);
        // Fallback to system theme
        const system = getSystemTheme();
        setSystemTheme(system);
        setThemeState('system');
        applyTheme('system', system);
        // Still try to load accent color even on error
        loadSystemAccentColor();
      } finally {
        setIsReady(true);
      }
    }

    initializeTheme();
  }, []);

  // Handle theme changes and persist to database
  async function handleSetTheme(newTheme: ThemeValue): Promise<void> {
    try {
      // Update state
      setThemeState(newTheme);

      // Apply theme to DOM immediately
      applyTheme(newTheme, systemTheme);

      // Persist to database
      const settings = await invoke<AppSettings>('get_settings');
      const updatedSettings: AppSettings = {
        ...settings,
        theme_preference: newTheme,
        updated_at: new Date().toISOString(),
      };
      await invoke('save_settings', { settings: updatedSettings });
    } catch (err) {
      console.error('Failed to save theme preference:', err);
      // Revert state on error
      setThemeState(theme);
      applyTheme(theme, systemTheme);
    }
  }

  // Listen for system theme changes
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const handleChange = (e: MediaQueryListEvent) => {
      const newSystemTheme = e.matches ? 'dark' : 'light';
      setSystemTheme(newSystemTheme);

      // If user has system theme selected, reapply
      if (theme === 'system') {
        applyTheme('system', newSystemTheme);
      }

      // Reload accent color when system theme changes
      loadSystemAccentColor();
    };

    // Use addEventListener for better compatibility
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [theme]);

  const value: ThemeContextValue = {
    theme,
    setTheme: handleSetTheme,
    systemTheme,
    isReady,
  };

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

// Hook to use theme context
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
