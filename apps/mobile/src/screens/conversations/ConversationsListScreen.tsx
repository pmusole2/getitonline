import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQuery } from 'convex/react';
import React from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, View } from 'react-native';
import { Badge, Surface, Text, useTheme } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversations'>;

interface Conversation {
  _id: Id<'conversations'>;
  productId: Id<'products'>;
  buyerId: Id<'users'>;
  sellerId: Id<'users'>;
  status: 'active' | 'archived' | 'blocked';
  lastMessageAt?: number;
  lastMessagePreview?: string;
  unreadCount: number;
  isBuyer: boolean;
  product: {
    _id: Id<'products'>;
    title: string;
    price: number;
    images: string[];
    status: string;
  } | null;
  otherUser: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
    avatar?: string;
  } | null;
  createdAt: number;
}

function ConversationItem({
  conversation,
  index,
  onPress
}: {
  conversation: Conversation;
  index: number;
  onPress: () => void;
}) {
  const theme = useTheme();

  const timeAgo = conversation.lastMessageAt
    ? getTimeAgo(conversation.lastMessageAt)
    : getTimeAgo(conversation.createdAt);

  return (
    <Animated.View entering={FadeInDown.delay(index * 50).duration(300)}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          styles.conversationItem,
          {
            backgroundColor: theme.colors.surface,
            opacity: pressed ? 0.8 : 1,
          },
        ]}
      >
        {/* Product Image */}
        <View style={styles.imageContainer}>
          {conversation.product?.images?.[0] ? (
            <Image
              source={{ uri: conversation.product.images[0] }}
              style={styles.productImage}
            />
          ) : (
            <View style={[styles.productImage, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Icon name="image-off" size={24} color={theme.colors.onSurfaceVariant} />
            </View>
          )}
          {conversation.unreadCount > 0 && (
            <Badge style={styles.unreadBadge} size={20}>
              {conversation.unreadCount}
            </Badge>
          )}
        </View>

        {/* Content */}
        <View style={styles.content}>
          <View style={styles.header}>
            <Text
              variant="titleSmall"
              style={{
                color: theme.colors.onSurface,
                fontWeight: conversation.unreadCount > 0 ? '700' : '500',
                flex: 1,
              }}
              numberOfLines={1}
            >
              {conversation.otherUser
                ? `${conversation.otherUser.firstName} ${conversation.otherUser.lastName}`
                : 'Unknown User'}
            </Text>
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
              {timeAgo}
            </Text>
          </View>

          <Text
            variant="bodySmall"
            style={{ color: theme.colors.primary, marginTop: 2 }}
            numberOfLines={1}
          >
            {conversation.product?.title || 'Product unavailable'}
            {conversation.product && ` • ${formatPrice(conversation.product.price)}`}
          </Text>

          {conversation.lastMessagePreview && (
            <Text
              variant="bodySmall"
              style={{
                color: conversation.unreadCount > 0
                  ? theme.colors.onSurface
                  : theme.colors.onSurfaceVariant,
                marginTop: 4,
                fontWeight: conversation.unreadCount > 0 ? '600' : '400',
              }}
              numberOfLines={2}
            >
              {conversation.isBuyer ? '' : 'You: '}{conversation.lastMessagePreview}
            </Text>
          )}

          {/* Role indicator */}
          <View style={styles.roleIndicator}>
            <Icon
              name={conversation.isBuyer ? 'account-arrow-right' : 'store'}
              size={12}
              color={theme.colors.onSurfaceVariant}
            />
            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginLeft: 4 }}>
              {conversation.isBuyer ? 'Buyer' : 'Seller'}
            </Text>
          </View>
        </View>

        <Icon name="chevron-right" size={24} color={theme.colors.onSurfaceVariant} />
      </Pressable>
    </Animated.View>
  );
}

function getTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m`;
  if (hours < 24) return `${hours}h`;
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

export default function ConversationsListScreen(props: Props) {
  // Conversations are read only for a ready account, so no conversation query runs while the account is loading or unavailable.
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Messages" />;
  }
  return <ConversationsListContent {...props} />;
}

function ConversationsListContent({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();

  const conversations = useQuery(
    api.conversations.getUserConversations,
    user ? { userId: user._id } : 'skip'
  ) as Conversation[] | undefined;

  const handleConversationPress = (conversation: Conversation) => {
    navigation.navigate('ConversationChat', {
      conversationId: conversation._id,
      productId: conversation.productId,
    });
  };

  // Loading
  if (conversations === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Messages" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  // Empty state
  if (conversations.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Messages" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Surface style={[styles.emptyState, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
            <Icon name="message-text-outline" size={64} color={theme.colors.onSurfaceVariant} />
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
              No conversations yet
            </Text>
            <Text
              variant="bodyMedium"
              style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 8 }}
            >
              When you message a seller about a product, your conversations will appear here
            </Text>
          </Surface>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Messages"
        subtitle={`${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`}
        onBackPress={() => navigation.goBack()}
      />

      <FlatList
        data={conversations}
        keyExtractor={(item) => item._id}
        renderItem={({ item, index }) => (
          <ConversationItem
            conversation={item}
            index={index}
            onPress={() => handleConversationPress(item)}
          />
        )}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyState: {
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
    maxWidth: 300,
  },
  list: {
    padding: 16,
    paddingBottom: 32,
  },
  separator: {
    height: 12,
  },
  conversationItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
  },
  imageContainer: {
    position: 'relative',
  },
  productImage: {
    width: 56,
    height: 56,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  unreadBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
  },
  content: {
    flex: 1,
    marginHorizontal: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  roleIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
});
