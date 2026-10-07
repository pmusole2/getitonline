import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { MotiView } from 'moti';
import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  ViewStyle
} from 'react-native';
import type { MD3Theme } from 'react-native-paper';
import { Badge, Text, useTheme } from 'react-native-paper';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSpring
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { ASSISTANT_NAME } from '../../config/assistant';
import { AIAssistantModal } from './AIAssistant';

// ============================================================================
// TYPES
// ============================================================================

type HeaderVariant = 'default' | 'gradient' | 'transparent' | 'glass';
type HeaderSize = 'compact' | 'regular' | 'large';

interface HeaderAction {
  icon: string;
  onPress: () => void;
  badge?: number;
  disabled?: boolean;
}

interface HeaderProps {
  title?: string;
  subtitle?: string;
  variant?: HeaderVariant;
  size?: HeaderSize;
  showBackButton?: boolean;
  onBackPress?: () => void;
  leftActions?: HeaderAction[];
  rightActions?: HeaderAction[];
  showAIIndicator?: boolean;
  showSearch?: boolean;
  onSearchPress?: () => void;
  transparent?: boolean;
  animated?: boolean;
  children?: React.ReactNode;
  style?: ViewStyle;
}

interface TabHeaderProps {
  title: string;
  subtitle?: string;
  greeting?: string;
  userName?: string;
  showNotifications?: boolean;
  notificationCount?: number;
  onNotificationPress?: () => void;
  showCart?: boolean;
  cartCount?: number;
  onCartPress?: () => void;
  showAIAssistant?: boolean;
  onAIPress?: () => void;
  rightContent?: React.ReactNode;
  style?: ViewStyle;
}

interface StackHeaderProps {
  title: string;
  subtitle?: string;
  onBackPress: () => void;
  rightActions?: HeaderAction[];
  variant?: HeaderVariant;
  showAIIndicator?: boolean;
  style?: ViewStyle;
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

function AIStatusIndicator() {
  const theme = useTheme();

  return (
    <MotiView
      from={{ opacity: 0.5 }}
      animate={{ opacity: 1 }}
      transition={{
        opacity: {
          type: 'timing',
          duration: 1500,
          loop: true,
        },
      }}
      style={[styles.aiIndicator, { backgroundColor: theme.colors.primary + '20' }]}
    >
      <MotiView
        from={{ scale: 0.8 }}
        animate={{ scale: 1.1 }}
        transition={{
          scale: {
            type: 'timing',
            duration: 1000,
            loop: true,
          },
        }}
      >
        <Icon name="creation" size={14} color={theme.colors.primary} />
      </MotiView>
      <Text
        variant="labelSmall"
        style={[styles.aiIndicatorText, { color: theme.colors.primary }]}
      >
        {ASSISTANT_NAME}
      </Text>
    </MotiView>
  );
}

function HeaderActionButton({
  icon,
  onPress,
  badge,
  disabled,
  theme,
}: HeaderAction & { theme: MD3Theme }) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.9, { damping: 15 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15 });
  };

  return (
    <AnimatedPressable
      style={[styles.actionButton, animatedStyle]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={disabled}
    >
      <View
        style={[
          styles.actionButtonInner,
          { backgroundColor: theme.colors.surfaceVariant + '80' },
        ]}
      >
        <Icon
          name={icon}
          size={22}
          color={disabled ? theme.colors.onSurfaceVariant + '50' : theme.colors.onSurface}
        />
        {badge !== undefined && badge > 0 && (
          <Badge style={styles.actionBadge} size={18}>
            {badge > 99 ? '99+' : badge}
          </Badge>
        )}
      </View>
    </AnimatedPressable>
  );
}

function BackButton({
  onPress,
  theme,
}: {
  onPress: () => void;
  theme: MD3Theme;
}) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.85, { damping: 15 });
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 15 });
  };

  return (
    <AnimatedPressable
      style={[styles.backButton, animatedStyle]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      <View
        style={[
          styles.backButtonInner,
          { backgroundColor: theme.colors.surfaceVariant + '80' },
        ]}
      >
        <Icon name="arrow-left" size={22} color={theme.colors.onSurface} />
      </View>
    </AnimatedPressable>
  );
}

// ============================================================================
// TAB HEADER - For main tab screens (Home, Browse, etc.)
// ============================================================================

export function TabHeader({
  title,
  subtitle,
  greeting,
  userName,
  showNotifications = false,
  notificationCount = 0,
  onNotificationPress,
  showCart = false,
  cartCount = 0,
  onCartPress,
  showAIAssistant = false,
  onAIPress,
  rightContent,
  style,
}: TabHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [isAssistantVisible, setIsAssistantVisible] = React.useState(false);
  const handleAIPress = onAIPress ?? (() => setIsAssistantVisible(true));

  return (
    <View style={[styles.tabHeaderContainer, { paddingTop: insets.top }, style]}>
      {/* Static background gradient */}
      <LinearGradient
        colors={[
          theme.colors.surface,
          theme.colors.surface,
          theme.colors.background,
        ]}
        style={StyleSheet.absoluteFillObject}
      />

      <Animated.View
        entering={FadeIn.duration(400)}
        style={styles.tabHeaderContent}
      >
        {/* Left Section - Title/Greeting */}
        <View style={styles.tabHeaderLeft}>
          {greeting ? (
            <>
              <Text
                variant="bodyMedium"
                style={[styles.greeting, { color: theme.colors.onSurfaceVariant }]}
              >
                {greeting}
              </Text>
              <View style={styles.titleRow}>
                <Text
                  variant="headlineSmall"
                  style={[styles.userName, { color: theme.colors.onSurface }]}
                >
                  {userName || 'Welcome'}
                </Text>
              </View>
            </>
          ) : (
            <>
              <View style={styles.titleRow}>
                <Text
                  variant="headlineSmall"
                  style={[styles.title, { color: theme.colors.onSurface }]}
                >
                  {title}
                </Text>
              </View>
              {subtitle && (
                <Text
                  variant="bodyMedium"
                  style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
                >
                  {subtitle}
                </Text>
              )}
            </>
          )}
        </View>

        {/* Right Section - Actions */}
        <View style={styles.tabHeaderActions}>
          {rightContent}

          {showAIAssistant && (
            <Pressable
              onPress={handleAIPress}
              style={[styles.aiButton, { backgroundColor: theme.colors.primaryContainer }]}
              accessibilityRole="button"
              accessibilityLabel={`Open ${ASSISTANT_NAME}`}
            >
              <MotiView
                from={{ rotate: '0deg' }}
                animate={{ rotate: '360deg' }}
                transition={{
                  rotate: { type: 'timing', duration: 8000, loop: true, easing: Easing.linear },
                }}
              >
                <Icon name="creation" size={20} color={theme.colors.primary} />
              </MotiView>
            </Pressable>
          )}

          {showCart && onCartPress && (
            <HeaderActionButton
              icon="cart-outline"
              onPress={onCartPress}
              badge={cartCount}
              theme={theme}
            />
          )}

          {showNotifications && onNotificationPress && (
            <HeaderActionButton
              icon="bell-outline"
              onPress={onNotificationPress}
              badge={notificationCount}
              theme={theme}
            />
          )}
        </View>
      </Animated.View>

      {/* Bottom accent line with gradient */}
      <LinearGradient
        colors={[
          'transparent',
          theme.colors.primary + '20',
          theme.colors.tertiary + '20',
          'transparent',
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.accentLine}
      />

      {showAIAssistant && !onAIPress && (
        <AIAssistantModal
          visible={isAssistantVisible}
          onClose={() => setIsAssistantVisible(false)}
          currentScreen={title}
        />
      )}
    </View>
  );
}

// ============================================================================
// STACK HEADER - For push screens (ProductDetail, OrderDetail, etc.)
// ============================================================================

export function StackHeader({
  title,
  subtitle,
  onBackPress,
  rightActions = [],
  variant = 'default',
  showAIIndicator = false,
  style,
}: StackHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const renderContent = () => (
    <Animated.View
      entering={FadeIn.duration(300)}
      style={styles.stackHeaderContent}
    >
      {/* Back Button */}
      <BackButton onPress={onBackPress} theme={theme} />

      {/* Title Section */}
      <Animated.View
        entering={FadeInDown.delay(100).duration(300)}
        style={styles.stackHeaderCenter}
      >
        <View style={styles.titleRow}>
          <Text
            variant="titleLarge"
            style={[styles.stackTitle, { color: theme.colors.onSurface }]}
            numberOfLines={1}
          >
            {title}
          </Text>
          {showAIIndicator && <AIStatusIndicator />}
        </View>
        {subtitle && (
          <Text
            variant="bodySmall"
            style={[styles.stackSubtitle, { color: theme.colors.onSurfaceVariant }]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
        )}
      </Animated.View>

      {/* Right Actions */}
      <View style={styles.stackHeaderRight}>
        {rightActions.map((action, index) => (
          <HeaderActionButton key={index} {...action} theme={theme} />
        ))}
      </View>
    </Animated.View>
  );

  if (variant === 'glass') {
    return (
      <View style={[styles.stackHeaderContainer, { paddingTop: insets.top }, style]}>
        <BlurView intensity={80} tint="light" style={StyleSheet.absoluteFillObject} />
        {renderContent()}
        <LinearGradient
          colors={[
            'transparent',
            theme.colors.primary + '15',
            theme.colors.tertiary + '15',
            'transparent',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.accentLine}
        />
      </View>
    );
  }

  if (variant === 'gradient') {
    return (
      <View style={[styles.stackHeaderContainer, { paddingTop: insets.top }, style]}>
        <LinearGradient
          colors={[theme.colors.surface, theme.colors.background]}
          style={StyleSheet.absoluteFillObject}
        />
        {renderContent()}
        <LinearGradient
          colors={[
            'transparent',
            theme.colors.primary + '20',
            theme.colors.tertiary + '20',
            'transparent',
          ]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.accentLine}
        />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.stackHeaderContainer,
        { paddingTop: insets.top, backgroundColor: theme.colors.surface },
        style,
      ]}
    >
      {renderContent()}
      <LinearGradient
        colors={[
          'transparent',
          theme.colors.primary + '10',
          theme.colors.tertiary + '10',
          'transparent',
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.accentLine}
      />
    </View>
  );
}

// ============================================================================
// SEARCH HEADER - For search-focused screens
// ============================================================================

interface SearchHeaderProps {
  placeholder?: string;
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  onBackPress?: () => void;
  showBackButton?: boolean;
  autoFocus?: boolean;
  style?: ViewStyle;
}

export function SearchHeader({
  placeholder = 'Search...',
  value,
  onChangeText,
  onSubmit,
  onBackPress,
  showBackButton = true,
  autoFocus = false,
  style,
}: SearchHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.searchHeaderContainer,
        { paddingTop: insets.top, backgroundColor: theme.colors.surface },
        style,
      ]}
    >
      <Animated.View
        entering={FadeIn.duration(300)}
        style={styles.searchHeaderContent}
      >
        {showBackButton && onBackPress && (
          <BackButton onPress={onBackPress} theme={theme} />
        )}

        <View
          style={[
            styles.searchInputContainer,
            { backgroundColor: theme.colors.surfaceVariant },
          ]}
        >
          <Icon name="magnify" size={20} color={theme.colors.onSurfaceVariant} />
          <Animated.View entering={FadeIn.delay(150).duration(200)} style={styles.searchInputWrapper}>
            <Text
              style={[
                styles.searchInput,
                {
                  color: value ? theme.colors.onSurface : theme.colors.onSurfaceVariant,
                },
              ]}
              numberOfLines={1}
            >
              {value || placeholder}
            </Text>
          </Animated.View>
          {value.length > 0 && (
            <Pressable onPress={() => onChangeText('')}>
              <Icon name="close-circle" size={18} color={theme.colors.onSurfaceVariant} />
            </Pressable>
          )}
        </View>

        {/* AI Search Enhancement indicator */}
        <MotiView
          from={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            scale: { type: 'spring', damping: 15 },
            opacity: { type: 'spring', damping: 15 },
          }}
          style={[styles.aiSearchButton, { backgroundColor: theme.colors.primaryContainer }]}
        >
          <Icon name="auto-fix" size={20} color={theme.colors.primary} />
        </MotiView>
      </Animated.View>

      <LinearGradient
        colors={[
          'transparent',
          theme.colors.primary + '15',
          theme.colors.tertiary + '15',
          'transparent',
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.accentLine}
      />
    </View>
  );
}

// ============================================================================
// LARGE HEADER - For profile/detail screens with hero section
// ============================================================================

interface LargeHeaderProps {
  title: string;
  subtitle?: string;
  backgroundGradient?: [string, string];
  showBackButton?: boolean;
  onBackPress?: () => void;
  rightActions?: HeaderAction[];
  children?: React.ReactNode;
  style?: ViewStyle;
}

export function LargeHeader({
  title,
  subtitle,
  backgroundGradient,
  showBackButton = false,
  onBackPress,
  rightActions = [],
  children,
  style,
}: LargeHeaderProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const gradientColors = backgroundGradient || [
    theme.colors.primary,
    theme.colors.tertiary,
  ];

  return (
    <View style={[styles.largeHeaderContainer, style]}>
      <LinearGradient
        colors={gradientColors}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={[styles.largeHeaderGradient, { paddingTop: insets.top }]}
      >
        {/* Top navigation row */}
        <View style={styles.largeHeaderNav}>
          {showBackButton && onBackPress ? (
            <Pressable
              onPress={onBackPress}
              style={[styles.largeBackButton, { backgroundColor: 'rgba(255,255,255,0.2)' }]}
            >
              <Icon name="arrow-left" size={22} color="#fff" />
            </Pressable>
          ) : (
            <View style={{ width: 40 }} />
          )}

          <View style={styles.largeHeaderActions}>
            {rightActions.map((action, index) => (
              <Pressable
                key={index}
                onPress={action.onPress}
                style={[styles.largeActionButton, { backgroundColor: 'rgba(255,255,255,0.2)' }]}
                disabled={action.disabled}
              >
                <Icon name={action.icon} size={22} color="#fff" />
                {action.badge !== undefined && action.badge > 0 && (
                  <Badge style={styles.largeActionBadge} size={16}>
                    {action.badge}
                  </Badge>
                )}
              </Pressable>
            ))}
          </View>
        </View>

        {/* Title section */}
        <Animated.View
          entering={FadeInDown.delay(100).duration(400)}
          style={styles.largeHeaderTitleSection}
        >
          <Text variant="headlineMedium" style={styles.largeTitle}>
            {title}
          </Text>
          {subtitle && (
            <Text variant="bodyMedium" style={styles.largeSubtitle}>
              {subtitle}
            </Text>
          )}
        </Animated.View>

        {/* Custom content (avatar, stats, etc.) */}
        {children}
      </LinearGradient>
    </View>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  // Tab Header
  tabHeaderContainer: {
    overflow: 'hidden',
  },
  tabHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  tabHeaderLeft: {
    flex: 1,
  },
  tabHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  greeting: {
    fontSize: 14,
    marginBottom: 2,
  },
  userName: {
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  title: {
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  subtitle: {
    marginTop: 2,
  },
  accentLine: {
    height: 2,
    width: '100%',
  },

  // Stack Header
  stackHeaderContainer: {
    overflow: 'hidden',
  },
  stackHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  stackHeaderCenter: {
    flex: 1,
    alignItems: 'center',
  },
  stackHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  stackTitle: {
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  stackSubtitle: {
    marginTop: 2,
  },

  // Search Header
  searchHeaderContainer: {
    overflow: 'hidden',
  },
  searchHeaderContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },
  searchInputContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  searchInputWrapper: {
    flex: 1,
  },
  searchInput: {
    fontSize: 15,
  },
  aiSearchButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Large Header
  largeHeaderContainer: {
    overflow: 'hidden',
  },
  largeHeaderGradient: {
    paddingBottom: 24,
  },
  largeHeaderNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  largeBackButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  largeHeaderActions: {
    flexDirection: 'row',
    gap: 8,
  },
  largeActionButton: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  largeActionBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
  },
  largeHeaderTitleSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  largeTitle: {
    color: '#fff',
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  largeSubtitle: {
    color: 'rgba(255,255,255,0.8)',
    marginTop: 4,
  },
  // Action Buttons
  actionButton: {
    position: 'relative',
  },
  actionButtonInner: {
    width: 42,
    height: 42,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  actionBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
  },

  // Back Button
  backButton: {
    marginRight: 4,
  },
  backButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // AI Indicator
  aiIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    gap: 4,
  },
  aiIndicatorText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },

  // AI Button
  aiButton: {
    width: 42,
    height: 42,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },

});

export default {
  TabHeader,
  StackHeader,
  SearchHeader,
  LargeHeader,
};
