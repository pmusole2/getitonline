import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import type { RootStackParamList } from '../types';
import { useAppAuth } from '../context/AuthProvider';
import { api } from '../../../../convex/_generated/api';

import { AuthNavigator } from './AuthNavigator';
import { GuestTabNavigator } from './GuestTabNavigator';
import { MainTabNavigator } from './MainTabNavigator';
import ProductDetailScreen from '../screens/product/ProductDetailScreen';
import CreateProductScreen from '../screens/product/CreateProductScreen';
import EditProductScreen from '../screens/product/EditProductScreen';
import OrderDetailScreen from '../screens/orders/OrderDetailScreen';
import DisputeDetailScreen from '../screens/disputes/DisputeDetailScreen';
import CreateDisputeScreen from '../screens/disputes/CreateDisputeScreen';
import ChatScreen from '../screens/disputes/ChatScreen';
import DisputesListScreen from '../screens/disputes/DisputesListScreen';
import SellerProfileScreen from '../screens/profile/SellerProfileScreen';
import ConversationsListScreen from '../screens/conversations/ConversationsListScreen';
import ConversationChatScreen from '../screens/conversations/ConversationChatScreen';
import SearchScreen from '../screens/browse/SearchScreen';
import CategoryProductsScreen from '../screens/browse/CategoryProductsScreen';
import SettingsScreen from '../screens/profile/SettingsScreen';
import EditProfileScreen from '../screens/profile/EditProfileScreen';
import CartScreen from '../screens/cart/CartScreen';
import CheckoutScreen from '../screens/cart/CheckoutScreen';
import NotificationsScreen from '../screens/notifications/NotificationsScreen';
import WalletScreen from '../screens/wallet/WalletScreen';
import LoadingScreen from '../screens/LoadingScreen';
import { canManageCatalog, canManageListings } from '../utils/roles';

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { isLoading, isSignedIn, user } = useAppAuth();
  const vendorProfile = useQuery(
    api.vendors.getMyVendorProfile,
    user?._id ? { ownerUserId: user._id } : 'skip'
  );
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <Stack.Navigator
      screenOptions={{
        // Disable all default headers - we use custom headers in each screen
        headerShown: false,
        // Modern slide animation
        animation: 'slide_from_right',
        // Gesture handling
        gestureEnabled: true,
        // Full screen gesture for iOS
        fullScreenGestureEnabled: true,
      }}
    >
      <Stack.Screen
        name="Main"
        component={isSignedIn ? MainTabNavigator : GuestTabNavigator}
      />
      <Stack.Screen
        name="ProductDetail"
        component={ProductDetailScreen}
        options={{
          animation: 'slide_from_bottom',
        }}
      />
      <Stack.Screen
        name="SellerProfile"
        component={SellerProfileScreen}
      />
      <Stack.Screen
        name="Search"
        component={SearchScreen}
        options={{
          animation: 'fade',
        }}
      />
      <Stack.Screen
        name="CategoryProducts"
        component={CategoryProductsScreen}
      />
      <Stack.Screen
        name="Cart"
        component={CartScreen}
        options={{
          animation: 'slide_from_right',
        }}
      />
      <Stack.Screen
        name="Auth"
        component={AuthNavigator}
        options={{
          animation: 'slide_from_bottom',
          gestureDirection: 'vertical',
        }}
      />
      {isSignedIn && (
        <>
          {hasListingAccess && (
            <>
              <Stack.Screen
                name="CreateProduct"
                component={CreateProductScreen}
                options={{
                  animation: 'slide_from_bottom',
                  gestureDirection: 'vertical',
                }}
              />
              <Stack.Screen
                name="EditProduct"
                component={EditProductScreen}
                options={{
                  animation: 'slide_from_bottom',
                  gestureDirection: 'vertical',
                }}
              />
            </>
          )}
          <Stack.Screen
            name="OrderDetail"
            component={OrderDetailScreen}
          />
          <Stack.Screen
            name="DisputeDetail"
            component={DisputeDetailScreen}
          />
          <Stack.Screen
            name="CreateDispute"
            component={CreateDisputeScreen}
            options={{
              animation: 'slide_from_bottom',
              gestureDirection: 'vertical',
            }}
          />
          <Stack.Screen
            name="Chat"
            component={ChatScreen}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
          />
          <Stack.Screen
            name="EditProfile"
            component={EditProfileScreen}
            options={{
              animation: 'slide_from_bottom',
              gestureDirection: 'vertical',
            }}
          />
          <Stack.Screen
            name="Checkout"
            component={CheckoutScreen}
            options={{
              animation: 'slide_from_bottom',
              gestureDirection: 'vertical',
            }}
          />
          <Stack.Screen
            name="Notifications"
            component={NotificationsScreen}
          />
          <Stack.Screen
            name="Conversations"
            component={ConversationsListScreen}
          />
          <Stack.Screen
            name="ConversationChat"
            component={ConversationChatScreen}
          />
          <Stack.Screen
            name="Disputes"
            component={DisputesListScreen}
          />
          <Stack.Screen
            name="Wallet"
            component={WalletScreen}
            options={{
              animation: 'slide_from_bottom',
              gestureDirection: 'vertical',
            }}
          />
        </>
      )}
    </Stack.Navigator>
  );
}
