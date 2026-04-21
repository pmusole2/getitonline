import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import { useAppAuth } from './AuthProvider';

// ============================================================================
// TYPES
// ============================================================================

type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextType {
  themeMode: ThemeMode;
  isDark: boolean;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  isSyncing: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const THEME_STORAGE_KEY = '@gettitonline_theme';

// ============================================================================
// CONTEXT
// ============================================================================

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

// ============================================================================
// PROVIDER
// ============================================================================

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const systemColorScheme = useColorScheme();
  const { user } = useAppAuth();
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  // Convex queries and mutations
  const userPreferences = useQuery(
    api.users.getPreferences,
    user ? { userId: user._id } : 'skip'
  );
  const updateThemeModeMutation = useMutation(api.users.updateThemeMode);

  // Load saved theme preference on mount (from local storage as fallback)
  useEffect(() => {
    loadLocalThemePreference();
  }, []);

  // Sync with backend when user logs in or preferences change
  useEffect(() => {
    if (user && userPreferences) {
      // User is logged in and we have their preferences from server
      const serverTheme = userPreferences.themeMode;
      if (serverTheme && serverTheme !== themeMode) {
        setThemeModeState(serverTheme);
        // Also save to local storage for offline access
        saveLocalThemePreference(serverTheme);
      }
    }
  }, [user, userPreferences]);

  const loadLocalThemePreference = async () => {
    try {
      const savedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
      if (savedTheme && (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system')) {
        setThemeModeState(savedTheme as ThemeMode);
      }
    } catch (error) {
      console.log('Failed to load theme preference:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const saveLocalThemePreference = async (mode: ThemeMode) => {
    try {
      await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch (error) {
      console.log('Failed to save theme preference locally:', error);
    }
  };

  // Save theme preference (to both local and server if logged in)
  const setThemeMode = useCallback(async (mode: ThemeMode) => {
    setThemeModeState(mode);

    // Always save locally for immediate access and offline support
    saveLocalThemePreference(mode);

    // If user is logged in, sync to server
    if (user) {
      setIsSyncing(true);
      try {
        await updateThemeModeMutation({
          userId: user._id,
          themeMode: mode,
        });
      } catch (error) {
        console.log('Failed to sync theme to server:', error);
        // Local preference is already saved, so user won't notice
      } finally {
        setIsSyncing(false);
      }
    }
  }, [user, updateThemeModeMutation]);

  // Toggle between light and dark (skipping system)
  const toggleTheme = useCallback(() => {
    const newMode = isDark ? 'light' : 'dark';
    setThemeMode(newMode);
  }, [setThemeMode]);

  // Determine if dark mode should be active
  const isDark = themeMode === 'system'
    ? systemColorScheme === 'dark'
    : themeMode === 'dark';

  const value: ThemeContextType = {
    themeMode,
    isDark,
    setThemeMode,
    toggleTheme,
    isSyncing,
  };

  // Don't render until we've loaded the saved preference
  if (isLoading) {
    return null;
  }

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

// ============================================================================
// HOOK
// ============================================================================

export function useAppTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useAppTheme must be used within a ThemeProvider');
  }
  return context;
}
