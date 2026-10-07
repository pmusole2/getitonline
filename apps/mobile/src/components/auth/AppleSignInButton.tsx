import * as AppleAuthentication from 'expo-apple-authentication';
import React from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  View,
} from 'react-native';

import {
  getAppleButtonAppearance,
  shouldShowAppleSignIn,
} from './appleSignInPolicy';

interface AppleSignInButtonProps {
  disabled: boolean;
  isDark: boolean;
  loading: boolean;
  onPress: () => void | Promise<void>;
}

export function AppleSignInButton({
  disabled,
  isDark,
  loading,
  onPress,
}: AppleSignInButtonProps) {
  const [isAvailable, setIsAvailable] = React.useState(false);

  React.useEffect(() => {
    let isMounted = true;

    if (Platform.OS !== 'ios') {
      return () => {
        isMounted = false;
      };
    }

    void AppleAuthentication.isAvailableAsync().then((available) => {
      if (isMounted) {
        setIsAvailable(available);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  if (!shouldShowAppleSignIn(Platform.OS, isAvailable)) {
    return null;
  }

  const appearance = getAppleButtonAppearance(isDark);
  const buttonStyle =
    appearance === 'white'
      ? AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
      : AppleAuthentication.AppleAuthenticationButtonStyle.BLACK;

  return (
    <View
      pointerEvents={disabled ? 'none' : 'auto'}
      style={[styles.container, disabled && styles.disabled]}
    >
      <AppleAuthentication.AppleAuthenticationButton
        buttonStyle={buttonStyle}
        buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
        cornerRadius={8}
        onPress={() => void onPress()}
        style={styles.button}
      />
      {loading ? (
        <View pointerEvents="none" style={styles.loadingOverlay}>
          <ActivityIndicator
            color={appearance === 'white' ? '#000000' : '#FFFFFF'}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 52,
    marginBottom: 12,
    position: 'relative',
    width: '100%',
  },
  button: {
    height: 52,
    width: '100%',
  },
  disabled: {
    opacity: 0.64,
  },
  loadingOverlay: {
    alignItems: 'center',
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
  },
});
