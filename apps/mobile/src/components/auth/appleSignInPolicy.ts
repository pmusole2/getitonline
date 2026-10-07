export type AppleButtonAppearance = 'black' | 'white';

export function shouldShowAppleSignIn(
  platform: string,
  isAvailable: boolean,
): boolean {
  return platform === 'ios' && isAvailable;
}

export function getAppleButtonAppearance(isDark: boolean): AppleButtonAppearance {
  return isDark ? 'white' : 'black';
}
