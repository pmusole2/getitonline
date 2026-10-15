import { useEffect, useRef, useState, useCallback } from 'react';
import { Platform } from 'react-native';
import { useMutation } from 'convex/react';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../types';

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

interface UsePushNotificationsReturn {
  expoPushToken: string | null;
  notification: Notifications.Notification | null;
  error: string | null;
  requestPermissions: () => Promise<boolean>;
}

export function usePushNotifications(userId?: Id<'users'>): UsePushNotificationsReturn {
  const [expoPushToken, setExpoPushToken] = useState<string | null>(null);
  const [notification, setNotification] = useState<Notifications.Notification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upsertNotificationDevice = useMutation(api.notifications.upsertNotificationDevice);

  const notificationListener = useRef<Notifications.Subscription | null>(null);
  const responseListener = useRef<Notifications.Subscription | null>(null);

  const registerForPushNotificationsAsync = useCallback(async (): Promise<string | null> => {
    if (!Device.isDevice) {
      setError('Push notifications require a physical device');
      return null;
    }

    try {
      const permissionResponse = await Notifications.getPermissionsAsync();
      let finalStatus = permissionResponse.status;

      if (finalStatus !== 'granted') {
        const requestResponse = await Notifications.requestPermissionsAsync();
        finalStatus = requestResponse.status;
      }

      if (finalStatus !== 'granted') {
        setError('Permission for push notifications was denied');
        return null;
      }

      // Get the Expo push token
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId,
      });

      const token = tokenData.data;

      // Configure for Android
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('default', {
          name: 'default',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#10B981',
        });

        await Notifications.setNotificationChannelAsync('orders', {
          name: 'Order Updates',
          importance: Notifications.AndroidImportance.HIGH,
          sound: 'default',
        });

        await Notifications.setNotificationChannelAsync('disputes', {
          name: 'Dispute Updates',
          importance: Notifications.AndroidImportance.HIGH,
          sound: 'default',
        });

        await Notifications.setNotificationChannelAsync('messages', {
          name: 'Messages',
          importance: Notifications.AndroidImportance.DEFAULT,
          sound: 'default',
        });
      }

      return token;
    } catch (err) {
      console.error('Error registering for push notifications:', err);
      setError('Failed to register for push notifications');
      return null;
    }
  }, []);

  const requestPermissions = useCallback(async (): Promise<boolean> => {
    const token = await registerForPushNotificationsAsync();
    if (token) {
      setExpoPushToken(token);
      if (userId) {
        await upsertNotificationDevice({
          channel: 'mobile_push',
          token,
          platform: Platform.OS,
          isOptedIn: true,
        });
      }
      return true;
    }
    return false;
  }, [registerForPushNotificationsAsync, upsertNotificationDevice, userId]);

  useEffect(() => {
    if (!userId || !expoPushToken) return;

    void upsertNotificationDevice({
      channel: 'mobile_push',
      token: expoPushToken,
      platform: Platform.OS,
      isOptedIn: true,
    });
  }, [expoPushToken, upsertNotificationDevice, userId]);

  useEffect(() => {
    // Register for push notifications on mount
    requestPermissions();

    // Listen for incoming notifications while app is foregrounded
    notificationListener.current = Notifications.addNotificationReceivedListener(
      (notif) => {
        setNotification(notif);
      }
    );

    // Listen for notification interactions
    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data;
        // Handle notification tap - navigate to relevant screen
        handleNotificationNavigation(data);
      }
    );

    return () => {
      if (notificationListener.current) {
        notificationListener.current.remove();
      }
      if (responseListener.current) {
        responseListener.current.remove();
      }
    };
  }, [requestPermissions]);

  return {
    expoPushToken,
    notification,
    error,
    requestPermissions,
  };
}

// Handle navigation when notification is tapped
function handleNotificationNavigation(data: Record<string, unknown>) {
  // This will be called from the navigation context
  // The actual navigation logic should be implemented in the app's navigation
  console.log('Notification data:', data);
}

// Helper function to send local notification (for testing)
export async function sendLocalNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>
) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: 'default',
    },
    trigger: null, // Immediate
  });
}

// Helper function to schedule a notification
export async function scheduleNotification(
  title: string,
  body: string,
  trigger: Notifications.NotificationTriggerInput,
  data?: Record<string, unknown>
) {
  return await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: 'default',
    },
    trigger,
  });
}

// Cancel all scheduled notifications
export async function cancelAllNotifications() {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

// Get badge count
export async function getBadgeCount(): Promise<number> {
  return await Notifications.getBadgeCountAsync();
}

// Set badge count
export async function setBadgeCount(count: number) {
  await Notifications.setBadgeCountAsync(count);
}
