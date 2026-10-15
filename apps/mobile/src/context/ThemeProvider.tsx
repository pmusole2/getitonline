import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useMutation } from 'convex/react';
import { resolveAccountAccess } from '@gettitonline/shared';
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
  const { isLoading: authLoading, isSignedIn, user, authSyncError } = useAppAuth();
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  // Set once a server theme has been applied, so a device theme that finishes loading later never overrides it.
  const serverThemeApplied = useRef(false);

  // Only a ready account reads or writes its preferences. Guests, pending, banned, and recovering visitors keep the device
  // theme, and a skipped query never holds up rendering.
  const accessStatus = resolveAccountAccess({
    isLoading: authLoading,
    isSignedIn,
    syncFailed: authSyncError !== null,
    user,
  });
  const accountId = accessStatus === 'ready' && user ? user._id : null;

  // Convex queries and mutations
  const userPreferences = useQuery(api.users.getPreferences, accountId ? {} : 'skip');
  const updateThemeModeMutation = useMutation(api.users.updateThemeMode);

  // Preferences carry no account ID. The result already on screen when this account became current may still belong to
  // the previous account, so it is never applied. Only a result that differs from it belongs to this account.
  const resultAtAccountChange = useMemo(() => userPreferences, [accountId]);
  const accountPreferences = userPreferences !== resultAtAccountChange ? userPreferences : undefined;

  // The account that is current now. A save that finishes for another account must not clear this account's state.
  const activeAccountRef = useRef(accountId);
  useEffect(() => {
    activeAccountRef.current = accountId;
  }, [accountId]);

  // Load saved theme preference on mount (from local storage as fallback)
  useEffect(() => {
    loadLocalThemePreference();
  }, []);

  // Apply the ready account's saved theme
  useEffect(() => {
    if (accountPreferences) {
      serverThemeApplied.current = true;
      const serverTheme = accountPreferences.themeMode;
      if (serverTheme && serverTheme !== themeMode) {
        setThemeModeState(serverTheme);
        // Also save to local storage for offline access
        saveLocalThemePreference(serverTheme);
      }
    }
  }, [accountPreferences]);

  const loadLocalThemePreference = async () => {
    try {
      const savedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
      if (
        !serverThemeApplied.current &&
        savedTheme &&
        (savedTheme === 'light' || savedTheme === 'dark' || savedTheme === 'system')
      ) {
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

  // Save theme preference (to both local and server if a ready account is signed in)
  const setThemeMode = useCallback(
    async (mode: ThemeMode) => {
      setThemeModeState(mode);

      // Always save locally for immediate access and offline support
      saveLocalThemePreference(mode);

      if (accountId === null) {
        return;
      }

      setIsSyncing(true);
      try {
        await updateThemeModeMutation({
          themeMode: mode,
        });
      } catch (error) {
        console.log('Failed to sync theme to server:', error);
        // Local preference is already saved, so user won't notice
      } finally {
        if (activeAccountRef.current === accountId) {
          setIsSyncing(false);
        }
      }
    },
    [accountId, updateThemeModeMutation],
  );

  // Toggle between light and dark (skipping system)
  const toggleTheme = useCallback(() => {
    const newMode = isDark ? 'light' : 'dark';
    setThemeMode(newMode);
  }, [setThemeMode]);

  // Determine if dark mode should be active
  const isDark = themeMode === 'system' ? systemColorScheme === 'dark' : themeMode === 'dark';

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

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
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
