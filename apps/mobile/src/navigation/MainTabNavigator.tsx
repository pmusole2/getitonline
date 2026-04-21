import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useTheme } from 'react-native-paper';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  interpolate,
} from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { MotiView } from 'moti';
import type { MainTabParamList } from '../types';

import HomeScreen from '../screens/home/HomeScreen';
import BrowseScreen from '../screens/browse/BrowseScreen';
import SellScreen from '../screens/product/SellScreen';
import OrdersScreen from '../screens/orders/OrdersScreen';
import ProfileScreen from '../screens/profile/ProfileScreen';
import { useAppAuth } from '../context/AuthProvider';
import { canAccessSellerSurface } from '../utils/roles';

const Tab = createBottomTabNavigator<MainTabParamList>();

// Icon configuration with focused/unfocused variants
const TAB_ICONS: Record<keyof MainTabParamList, { focused: string; unfocused: string }> = {
  Home: { focused: 'home', unfocused: 'home-outline' },
  Browse: { focused: 'compass', unfocused: 'compass-outline' },
  Sell: { focused: 'plus-circle', unfocused: 'plus-circle-outline' },
  Orders: { focused: 'package-variant-closed', unfocused: 'package-variant' },
  Profile: { focused: 'account-circle', unfocused: 'account-circle-outline' },
};

// Custom animated tab bar icon with glow effect
interface AnimatedTabIconProps {
  focused: boolean;
  iconName: string;
  color: string;
  size: number;
  isCenter?: boolean;
}

function AnimatedTabIcon({ focused, iconName, color, size, isCenter = false }: AnimatedTabIconProps) {
  const theme = useTheme();
  const scale = useSharedValue(focused ? 1 : 0.85);

  React.useEffect(() => {
    scale.value = withSpring(focused ? 1 : 0.85, {
      damping: 15,
      stiffness: 200,
    });
  }, [focused, scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  if (isCenter) {
    return (
      <View style={styles.centerTabContainer}>
        <LinearGradient
          colors={[theme.colors.primary, theme.colors.tertiary]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.centerTabGradient}
        >
          {focused && (
            <MotiView
              from={{ opacity: 0.5, scale: 1 }}
              animate={{ opacity: 0, scale: 1.5 }}
              transition={{
                opacity: { type: 'timing', duration: 1000, loop: true },
                scale: { type: 'timing', duration: 1000, loop: true },
              }}
              style={[styles.centerTabPulse, { borderColor: theme.colors.primary }]}
            />
          )}
          <Animated.View style={animatedStyle}>
            <Icon name={iconName} size={size + 2} color="#FFFFFF" />
          </Animated.View>
        </LinearGradient>
      </View>
    );
  }

  return (
    <View style={styles.tabIconContainer}>
      {focused && (
        <MotiView
          from={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{
            opacity: { type: 'spring', damping: 15 },
            scale: { type: 'spring', damping: 15 },
          }}
          style={[styles.activeIndicator, { backgroundColor: theme.colors.primary + '20' }]}
        />
      )}
      <Animated.View style={animatedStyle}>
        <Icon name={iconName} size={size} color={color} />
      </Animated.View>
    </View>
  );
}

// Custom tab bar with glassmorphism effect
interface CustomTabBarBackgroundProps {
  isDark: boolean;
}

function CustomTabBarBackground({ isDark }: CustomTabBarBackgroundProps) {
  const theme = useTheme();

  return (
    <View style={styles.tabBarBackgroundContainer}>
      {/* Gradient line at top */}
      <LinearGradient
        colors={[
          'transparent',
          theme.colors.primary + '30',
          theme.colors.tertiary + '30',
          'transparent',
        ]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.tabBarTopLine}
      />

      {/* Blur background */}
      {Platform.OS === 'ios' ? (
        <BlurView
          intensity={80}
          tint={isDark ? 'dark' : 'light'}
          style={StyleSheet.absoluteFillObject}
        />
      ) : (
        <View
          style={[
            StyleSheet.absoluteFillObject,
            { backgroundColor: theme.colors.surface + 'F5' },
          ]}
        />
      )}
    </View>
  );
}

export function MainTabNavigator() {
  const theme = useTheme();
  const isDark = theme.dark;
  const { user } = useAppAuth();
  const canAccessSell = canAccessSellerSurface(user?.role);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        // Disable default header - we use custom headers in screens
        headerShown: false,

        // Custom tab bar styling
        tabBarIcon: ({ focused, color, size }) => {
          const icons = TAB_ICONS[route.name];
          const iconName = focused ? icons.focused : icons.unfocused;
          const isCenter = route.name === 'Sell';

          return (
            <AnimatedTabIcon
              focused={focused}
              iconName={iconName}
              color={color}
              size={size}
              isCenter={isCenter}
            />
          );
        },

        // Colors
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,

        // Tab bar styling
        tabBarStyle: {
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: Platform.OS === 'ios' ? 88 : 68,
          paddingBottom: Platform.OS === 'ios' ? 28 : 8,
          paddingTop: 8,
          borderTopWidth: 0,
          elevation: 0,
          backgroundColor: 'transparent',
        },

        // Tab bar background
        tabBarBackground: () => <CustomTabBarBackground isDark={isDark} />,

        // Label styling
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },

        // Hide label for center tab
        tabBarShowLabel: route.name !== 'Sell',
      })}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: 'Home' }}
      />
      <Tab.Screen
        name="Browse"
        component={BrowseScreen}
        options={{ title: 'Browse' }}
      />
      {canAccessSell && (
        <Tab.Screen
          name="Sell"
          component={SellScreen}
          options={{ title: '' }}
        />
      )}
      <Tab.Screen
        name="Orders"
        component={OrdersScreen}
        options={{ title: 'Orders' }}
      />
      <Tab.Screen
        name="Profile"
        component={ProfileScreen}
        options={{ title: 'Profile' }}
      />
    </Tab.Navigator>
  );
}

const styles = StyleSheet.create({
  tabBarBackgroundContainer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
  },
  tabBarTopLine: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    zIndex: 1,
  },
  tabIconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    height: 48,
  },
  activeIndicator: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderRadius: 12,
  },
  centerTabContainer: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -20,
  },
  centerTabGradient: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#0EA5E9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  centerTabPulse: {
    position: 'absolute',
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 2,
  },
});
