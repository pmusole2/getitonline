import { MD3DarkTheme, MD3LightTheme, configureFonts } from 'react-native-paper';
import type { MD3Theme } from 'react-native-paper';

const fontConfig = {
  fontFamily: 'System',
};

export const brandColors = {
  primary: '#0795F9',
  primarySoft: '#6FA6D4',
  success: '#7A9C59',
  error: '#B20000',
  text: '#111111',
  mutedText: '#485555',
  background: '#FFFFFF',
  subtleSurface: '#F5F7FB',
  mutedSurface: '#F2F2F2',
  darkBackground: '#071523',
  darkSurface: '#0D2136',
  darkCard: '#12304C',
  darkText: '#F5F7FB',
  darkMutedText: '#B9C7D6',
  darkBorder: 'rgba(111,166,212,0.24)',
} as const;

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: brandColors.primary,
    primaryContainer: '#DFF0FF',
    onPrimary: '#FFFFFF',
    onPrimaryContainer: '#063C66',

    secondary: brandColors.primarySoft,
    secondaryContainer: '#E7F1FA',
    onSecondary: '#102B42',
    onSecondaryContainer: '#102B42',

    tertiary: brandColors.success,
    tertiaryContainer: '#E5EEDB',
    onTertiary: '#FFFFFF',
    onTertiaryContainer: '#31451D',

    error: brandColors.error,
    errorContainer: '#F7D9D9',
    onError: '#FFFFFF',
    onErrorContainer: '#5A0000',

    background: brandColors.background,
    surface: brandColors.subtleSurface,
    surfaceVariant: brandColors.mutedSurface,

    onBackground: brandColors.text,
    onSurface: brandColors.text,
    onSurfaceVariant: brandColors.mutedText,

    outline: 'rgba(111,166,212,0.36)',
    outlineVariant: 'rgba(111,166,212,0.18)',

    inverseSurface: '#12304C',
    inverseOnSurface: '#F5F7FB',
    inversePrimary: '#7EC0FF',

    shadow: '#000000',
    scrim: '#000000',
    surfaceDisabled: 'rgba(17, 17, 17, 0.12)',
    onSurfaceDisabled: 'rgba(17, 17, 17, 0.38)',
    backdrop: 'rgba(7, 21, 35, 0.35)',
    elevation: {
      level0: 'transparent',
      level1: '#FFFFFF',
      level2: '#F5F7FB',
      level3: '#EEF3F8',
      level4: '#E7F1FA',
      level5: '#DDEAF5',
    },
  },
  fonts: configureFonts({ config: fontConfig }),
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: brandColors.primary,
    primaryContainer: '#123A61',
    onPrimary: '#F5F7FB',
    onPrimaryContainer: '#DFF0FF',

    secondary: brandColors.primarySoft,
    secondaryContainer: '#163552',
    onSecondary: '#F5F7FB',
    onSecondaryContainer: '#DDEAF5',

    tertiary: brandColors.success,
    tertiaryContainer: '#2E4420',
    onTertiary: '#F5F7FB',
    onTertiaryContainer: '#E5EEDB',

    error: brandColors.error,
    errorContainer: '#5A0000',
    onError: '#F5F7FB',
    onErrorContainer: '#F7D9D9',

    background: brandColors.darkBackground,
    surface: brandColors.darkSurface,
    surfaceVariant: brandColors.darkCard,

    onBackground: brandColors.darkText,
    onSurface: brandColors.darkText,
    onSurfaceVariant: brandColors.darkMutedText,

    outline: brandColors.darkBorder,
    outlineVariant: 'rgba(111,166,212,0.12)',

    inverseSurface: '#F5F7FB',
    inverseOnSurface: '#12304C',
    inversePrimary: brandColors.primary,

    shadow: '#000000',
    scrim: '#000000',
    surfaceDisabled: 'rgba(245, 247, 251, 0.12)',
    onSurfaceDisabled: 'rgba(245, 247, 251, 0.38)',
    backdrop: 'rgba(0, 0, 0, 0.55)',
    elevation: {
      level0: 'transparent',
      level1: '#0D2136',
      level2: '#12304C',
      level3: '#173E60',
      level4: '#1E4F78',
      level5: '#275F8E',
    },
  },
  fonts: configureFonts({ config: fontConfig }),
};

export const CURRENCY = {
  code: 'ZMW',
  symbol: 'K',
  locale: 'en-ZM',
};

export function formatPrice(amount: number): string {
  return `K${amount.toLocaleString('en-ZM', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export const designTokens = {
  radius: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    full: 9999,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 32,
    '4xl': 48,
  },
  animation: {
    fast: 150,
    normal: 300,
    slow: 500,
    slower: 800,
  },
  glow: {
    sm: {
      shadowColor: brandColors.primary,
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.22,
      shadowRadius: 6,
      elevation: 4,
    },
    md: {
      shadowColor: brandColors.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.18,
      shadowRadius: 12,
      elevation: 8,
    },
    lg: {
      shadowColor: brandColors.primarySoft,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.2,
      shadowRadius: 18,
      elevation: 12,
    },
  },
  gradients: {
    primary: [brandColors.primary, brandColors.primarySoft] as [string, string],
    success: [brandColors.success, '#98B97A'] as [string, string],
    dark: [brandColors.darkBackground, brandColors.darkSurface] as [string, string],
    glass: ['rgba(255,255,255,0.14)', 'rgba(255,255,255,0.05)'] as [string, string],
  },
};

export type AppTheme = MD3Theme;
