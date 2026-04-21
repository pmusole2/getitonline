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
} from 'react-native-reanimated';
import { MotiView } from 'moti';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

import HomeScreen from '../screens/home/HomeScreen';
import BrowseScreen from '../screens/browse/BrowseScreen';
import GuestAccountScreen from '../screens/auth/GuestAccountScreen';

type GuestTabParamList = {
  Home: undefined;
  Browse: undefined;
  Account: undefined;
};

const Tab = createBottomTabNavigator<GuestTabParamList>();

const TAB_ICONS: Record<keyof GuestTabParamList, { focused: string; unfocused: string }> = {
  Home: { focused: 'home', unfocused: 'home-outline' },
  Browse: { focused: 'compass', unfocused: 'compass-outline' },
  Account: { focused: 'account-circle', unfocused: 'account-circle-outline' },
};

interface AnimatedTabIconProps {
  focused: boolean;
  iconName: string;
  color: string;
  size: number;
}

function AnimatedTabIcon({
  focused,
  iconName,
  color,
  size,
}: AnimatedTabIconProps) {
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

function CustomTabBarBackground({ isDark }: { isDark: boolean }) {
  const theme = useTheme();

  return (
    <View style={styles.tabBarBackgroundContainer}>
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

export function GuestTabNavigator() {
  const theme = useTheme();
  const isDark = theme.dark;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarIcon: ({ focused, color, size }) => {
          const icons = TAB_ICONS[route.name];

          return (
            <AnimatedTabIcon
              focused={focused}
              iconName={focused ? icons.focused : icons.unfocused}
              color={color}
              size={size}
            />
          );
        },
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.onSurfaceVariant,
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
        tabBarBackground: () => <CustomTabBarBackground isDark={isDark} />,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
          marginTop: 2,
        },
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
      <Tab.Screen
        name="Account"
        component={GuestAccountScreen}
        options={{ title: 'Account' }}
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
});
