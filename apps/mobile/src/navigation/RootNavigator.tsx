import React from 'react';
import { StyleSheet, View } from 'react-native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import { Button, Text, useTheme } from 'react-native-paper';
import type { RootStackParamList } from '../types';
import { resolveAccountAccess } from '@gettitonline/shared';
import { useAppAuth } from '../context/AuthProvider';
import { api } from '../../../../convex/_generated/api';

import { AuthNavigator } from './AuthNavigator';
import { GuestTabNavigator } from './GuestTabNavigator';
import { MainTabNavigator } from './MainTabNavigator';
import ProductDetailScreen from '../screens/product/ProductDetailScreen';
import CreateProductScreen from '../screens/product/CreateProductScreen';
import EditProductScreen from '../screens/product/EditProductScreen';
import SellScreen from '../screens/product/SellScreen';
import OrderDetailScreen from '../screens/orders/OrderDetailScreen';
import DisputeDetailScreen from '../screens/disputes/DisputeDetailScreen';
import CreateDisputeScreen from '../screens/disputes/CreateDisputeScreen';
import ChatScreen from '../screens/disputes/ChatScreen';
import DisputesListScreen from '../screens/disputes/DisputesListScreen';
import SellerProfileScreen from '../screens/profile/SellerProfileScreen';
import StoresDirectoryScreen from '../screens/store/StoresDirectoryScreen';
import AdminStoresScreen from '../screens/store/AdminStoresScreen';
import AdminDashboardScreen from '../screens/admin/AdminDashboardScreen';
import AdminOrdersScreen from '../screens/admin/AdminOrdersScreen';
import AdminEscrowScreen from '../screens/admin/AdminEscrowScreen';
import AdminTransactionsScreen from '../screens/admin/AdminTransactionsScreen';
import AdminCategoriesScreen from '../screens/admin/AdminCategoriesScreen';
import AdminUsersScreen from '../screens/admin/AdminUsersScreen';
import AdminDeliveryScreen from '../screens/admin/AdminDeliveryScreen';
import AdminPromotionsScreen from '../screens/admin/AdminPromotionsScreen';
import ListingReviewScreen from '../screens/admin/ListingReviewScreen';
import SellerOperationsScreen from '../screens/workspace/SellerOperationsScreen';
import WorkspaceScreen from '../screens/workspace/WorkspaceScreen';
import FavoritesScreen from '../screens/favorites/FavoritesScreen';
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
import { canManageListings } from '../utils/roles';

const Stack = createNativeStackNavigator<RootStackParamList>();

function AuthSyncErrorScreen({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut: () => Promise<void>;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.errorContainer, { backgroundColor: theme.colors.background }]}>
      <Text variant="headlineSmall" style={[styles.errorTitle, { color: theme.colors.onSurface }]}>
        Account setup did not finish
      </Text>
      <Text variant="bodyMedium" style={[styles.errorMessage, { color: theme.colors.onSurfaceVariant }]}>
        {message}
      </Text>
      <Button mode="contained" onPress={onRetry} style={styles.errorButton}>
        Try Again
      </Button>
      <Button mode="text" onPress={() => void onSignOut()}>
        Sign Out
      </Button>
    </View>
  );
}

export function RootNavigator() {
  const { authSyncError, isLoading, isSignedIn, retryUserSync, signOut, user } = useAppAuth();
  // The vendor status is read only for a ready account, with the same readiness rules the protected screens use.
  const accountStatus = resolveAccountAccess({ isLoading, isSignedIn, syncFailed: authSyncError !== null, user });
  const vendorProfile = useQuery(api.vendors.getMyVendorProfile, accountStatus === 'ready' ? {} : 'skip');
  const hasListingAccess = canManageListings(user?.role, vendorProfile?.status ?? null);

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (authSyncError && isSignedIn && !user) {
    return <AuthSyncErrorScreen message={authSyncError} onRetry={retryUserSync} onSignOut={signOut} />;
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
      <Stack.Screen name="Main" component={isSignedIn ? MainTabNavigator : GuestTabNavigator} />
      <Stack.Screen
        name="ProductDetail"
        component={ProductDetailScreen}
        options={{
          animation: 'slide_from_bottom',
        }}
      />
      <Stack.Screen name="SellerProfile" component={SellerProfileScreen} />
      <Stack.Screen name="StoresDirectory" component={StoresDirectoryScreen} />
      <Stack.Screen name="Favorites" component={FavoritesScreen} />
      <Stack.Screen
        name="Search"
        component={SearchScreen}
        options={{
          animation: 'fade',
        }}
      />
      <Stack.Screen name="CategoryProducts" component={CategoryProductsScreen} />
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
          <Stack.Screen
            name="Sell"
            component={SellScreen}
            options={{
              animation: 'slide_from_right',
            }}
          />
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
          <Stack.Screen name="OrderDetail" component={OrderDetailScreen} />
          <Stack.Screen name="DisputeDetail" component={DisputeDetailScreen} />
          <Stack.Screen
            name="CreateDispute"
            component={CreateDisputeScreen}
            options={{
              animation: 'slide_from_bottom',
              gestureDirection: 'vertical',
            }}
          />
          <Stack.Screen name="Chat" component={ChatScreen} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="AdminStores" component={AdminStoresScreen} />
          <Stack.Screen name="AdminDashboard" component={AdminDashboardScreen} />
          <Stack.Screen name="AdminOrders" component={AdminOrdersScreen} />
          <Stack.Screen name="AdminEscrow" component={AdminEscrowScreen} />
          <Stack.Screen name="AdminTransactions" component={AdminTransactionsScreen} />
          <Stack.Screen name="AdminCategories" component={AdminCategoriesScreen} />
          <Stack.Screen name="AdminUsers" component={AdminUsersScreen} />
          <Stack.Screen name="AdminDelivery" component={AdminDeliveryScreen} />
          <Stack.Screen name="AdminPromotions" component={AdminPromotionsScreen} />
          <Stack.Screen name="SellerOperations" component={SellerOperationsScreen} />
          <Stack.Screen name="Workspace" component={WorkspaceScreen} />
          <Stack.Screen name="ListingReview" component={ListingReviewScreen} />
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
          <Stack.Screen name="Notifications" component={NotificationsScreen} />
          <Stack.Screen name="Conversations" component={ConversationsListScreen} />
          <Stack.Screen name="ConversationChat" component={ConversationChatScreen} />
          <Stack.Screen name="Disputes" component={DisputesListScreen} />
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

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  errorTitle: {
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  errorMessage: {
    lineHeight: 22,
    marginBottom: 24,
    textAlign: 'center',
  },
  errorButton: {
    borderRadius: 12,
    marginBottom: 8,
  },
});
