import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput as RNTextInput,
  StyleSheet,
  View
} from 'react-native';
import { Avatar, IconButton, MD3Theme, Surface, Text, useTheme, } from 'react-native-paper';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'ConversationChat'>;
type ReportReason = 'harassment_or_abuse' | 'spam_or_scam' | 'unsafe_content' | 'other';

interface Message {
  _id: Id<'conversationMessages'>;
  conversationId: Id<'conversations'>;
  senderId: Id<'users'>;
  content: string;
  isRead: boolean;
  isSystemMessage: boolean;
  createdAt: number;
  sender: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
    avatar?: string;
  } | null;
}

interface ConversationWithDetails {
  _id: Id<'conversations'>;
  productId: Id<'products'>;
  buyerId: Id<'users'>;
  sellerId: Id<'users'>;
  status: 'active' | 'archived' | 'blocked';
  product: {
    _id: Id<'products'>;
    title: string;
    price: number;
    images: string[];
    status: string;
  } | null;
  buyer: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
    avatar?: string;
  } | null;
  seller: {
    _id: Id<'users'>;
    firstName: string;
    lastName: string;
    avatar?: string;
  } | null;
}

function MessageBubble({
  message,
  isOwn,
  showAvatar,
  theme,
}: {
  message: Message;
  isOwn: boolean;
  showAvatar: boolean;
  theme: MD3Theme;
}) {
  if (message.isSystemMessage) {
    return (
      <View style={styles.systemMessage}>
        <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
          {message.content}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.messageRow, isOwn && styles.messageRowOwn]}>
      {!isOwn && showAvatar && (
        <Avatar.Text
          size={28}
          label={message.sender ? `${message.sender.firstName[0]}${message.sender.lastName[0]}` : '?'}
          style={styles.messageAvatar}
        />
      )}
      {!isOwn && !showAvatar && <View style={styles.avatarPlaceholder} />}

      <Animated.View
        entering={FadeInUp.duration(200)}
        style={[
          styles.messageBubble,
          isOwn
            ? { backgroundColor: theme.colors.primary }
            : { backgroundColor: theme.colors.surfaceVariant },
        ]}
      >
        <Text
          variant="bodyMedium"
          style={{
            color: isOwn ? theme.colors.onPrimary : theme.colors.onSurface,
          }}
        >
          {message.content}
        </Text>
        <Text
          variant="labelSmall"
          style={{
            color: isOwn ? theme.colors.onPrimary + '80' : theme.colors.onSurfaceVariant,
            marginTop: 4,
            alignSelf: 'flex-end',
          }}
        >
          {new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </Animated.View>
    </View>
  );
}

export default function ConversationChatScreen({ route, navigation }: Props) {
  const theme = useTheme() as MD3Theme;
  const { conversationId, productId } = route.params;
  const { user, isLoading: authLoading } = useAppAuth();
  const flatListRef = useRef<FlatList>(null);

  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [safetyActionPending, setSafetyActionPending] = useState(false);

  const conversation = useQuery(
    api.conversations.getConversation,
    user
      ? { conversationId: conversationId as Id<'conversations'>, viewerId: user._id }
      : 'skip'
  ) as ConversationWithDetails | null | undefined;

  const messages = useQuery(
    api.conversations.getConversationMessages,
    user
      ? { conversationId: conversationId as Id<'conversations'>, viewerId: user._id }
      : 'skip'
  ) as Message[] | undefined;

  const sendMessage = useMutation(api.conversations.sendConversationMessage);
  const markRead = useMutation(api.conversations.markConversationRead);
  const blockConversation = useMutation(api.conversations.blockConversation);
  const reportConversation = useMutation(api.conversations.reportConversation);

  // Mark messages as read when viewing
  useEffect(() => {
    if (user && conversation) {
      markRead({ conversationId: conversationId as Id<'conversations'>, userId: user._id });
    }
  }, [user, conversation, conversationId, markRead]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages && messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages?.length]);

  const handleSend = async () => {
    if (!user || !messageText.trim() || sending) return;

    setSending(true);
    try {
      await sendMessage({
        conversationId: conversationId as Id<'conversations'>,
        senderId: user._id,
        content: messageText.trim(),
      });
      setMessageText('');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      Alert.alert('Message not sent', errorMessage);
    } finally {
      setSending(false);
    }
  };

  const handleViewProduct = () => {
    if (conversation?.product) {
      navigation.navigate('ProductDetail', { productId: conversation.product._id });
    }
  };

  const submitReport = async (reason: ReportReason = 'other') => {
    if (!user || safetyActionPending) return;

    setSafetyActionPending(true);
    try {
      await reportConversation({
        conversationId: conversationId as Id<'conversations'>,
        reporterId: user._id,
        reason,
      });
      Alert.alert('Report sent', 'This conversation was sent to moderation for review.');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to report conversation';
      Alert.alert('Report failed', errorMessage);
    } finally {
      setSafetyActionPending(false);
    }
  };

  const performBlock = async () => {
    if (!user || safetyActionPending) return;

    setSafetyActionPending(true);
    try {
      await blockConversation({
        conversationId: conversationId as Id<'conversations'>,
        userId: user._id,
      });
      Alert.alert('Conversation blocked', 'You will no longer receive messages in this conversation.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to block conversation';
      Alert.alert('Block failed', errorMessage);
    } finally {
      setSafetyActionPending(false);
    }
  };

  const confirmBlock = () => {
    Alert.alert(
      'Block conversation',
      'This stops buyer/seller messaging for this conversation.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Block', style: 'destructive', onPress: () => void performBlock() },
      ]
    );
  };

  const handleSafetyMenu = () => {
    Alert.alert(
      'Conversation safety',
      'Report abusive or unsafe messaging, or block this conversation.',
      [
        { text: 'Report', onPress: () => void submitReport('other') },
        { text: 'Block', style: 'destructive', onPress: confirmBlock },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  if (authLoading) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Chat" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Chat" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Icon name="lock-outline" size={64} color={theme.colors.error} />
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
            Sign in to view this conversation
          </Text>
        </View>
      </View>
    );
  }

  // Loading
  if (conversation === undefined || messages === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Chat" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  // Not found
  if (conversation === null) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Chat" onBackPress={() => navigation.goBack()} />
        <View style={styles.centered}>
          <Icon name="message-off" size={64} color={theme.colors.error} />
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
            Conversation not found
          </Text>
        </View>
      </View>
    );
  }

  const isBuyer = user?._id === conversation.buyerId;
  const otherUser = isBuyer ? conversation.seller : conversation.buyer;
  const otherUserName = otherUser ? `${otherUser.firstName} ${otherUser.lastName}` : 'Unknown';
  const isBlocked = conversation.status === 'blocked';

  const renderMessage = ({ item, index }: { item: Message; index: number }) => {
    const isOwn = item.senderId === user?._id;
    const prevMessage = index > 0 ? messages[index - 1] : null;
    const showAvatar = !isOwn && (!prevMessage || prevMessage.senderId !== item.senderId);

    return (
      <MessageBubble
        message={item}
        isOwn={isOwn}
        showAvatar={showAvatar}
        theme={theme}
      />
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <StackHeader
        title={otherUserName}
        subtitle={isBuyer ? 'Seller' : 'Buyer'}
        onBackPress={() => navigation.goBack()}
        rightActions={[
          {
            icon: 'shield-alert-outline',
            onPress: handleSafetyMenu,
            disabled: safetyActionPending || isBlocked,
          },
        ]}
      />

      {/* Product Info Card */}
      {conversation.product && (
        <Animated.View entering={FadeInDown.duration(300)}>
          <Pressable
            onPress={handleViewProduct}
            style={({ pressed }) => [
              styles.productCard,
              { backgroundColor: theme.colors.surfaceVariant, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            {conversation.product.images?.[0] ? (
              <Image
                source={{ uri: conversation.product.images[0] }}
                style={styles.productCardImage}
              />
            ) : (
              <View style={[styles.productCardImage, { backgroundColor: theme.colors.surface }]}>
                <Icon name="image-off" size={20} color={theme.colors.onSurfaceVariant} />
              </View>
            )}
            <View style={styles.productCardContent}>
              <Text variant="labelLarge" style={{ color: theme.colors.onSurface }} numberOfLines={1}>
                {conversation.product.title}
              </Text>
              <Text variant="titleSmall" style={{ color: theme.colors.primary }}>
                {formatPrice(conversation.product.price)}
              </Text>
            </View>
            <Icon name="chevron-right" size={24} color={theme.colors.onSurfaceVariant} />
          </Pressable>
        </Animated.View>
      )}

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item._id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messagesList}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
        ListEmptyComponent={() => (
          <View style={styles.emptyMessages}>
            <Icon name="message-outline" size={48} color={theme.colors.onSurfaceVariant} />
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
              No messages yet. Start the conversation!
            </Text>
          </View>
        )}
      />

      {/* Input Area */}
      {isBlocked ? (
        <Surface style={[styles.blockedContainer, { backgroundColor: theme.colors.errorContainer }]} elevation={2}>
          <Icon name="block-helper" size={20} color={theme.colors.onErrorContainer} />
          <Text variant="bodyMedium" style={{ color: theme.colors.onErrorContainer, marginLeft: 8 }}>
            This conversation is blocked.
          </Text>
        </Surface>
      ) : (
        <Surface style={[styles.inputContainer, { backgroundColor: theme.colors.surface }]} elevation={2}>
          <RNTextInput
            style={[
              styles.textInput,
              {
                backgroundColor: theme.colors.surfaceVariant,
                color: theme.colors.onSurface,
              },
            ]}
            placeholder="Type a message..."
            placeholderTextColor={theme.colors.onSurfaceVariant}
            value={messageText}
            onChangeText={setMessageText}
            multiline
            maxLength={2000}
          />
          <IconButton
            icon="send"
            iconColor={messageText.trim() ? theme.colors.primary : theme.colors.onSurfaceVariant}
            size={24}
            onPress={handleSend}
            disabled={!messageText.trim() || sending}
            loading={sending}
          />
        </Surface>
      )}
    </KeyboardAvoidingView>
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
  },
  productCard: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    padding: 12,
    borderRadius: 12,
  },
  productCardImage: {
    width: 48,
    height: 48,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  productCardContent: {
    flex: 1,
    marginHorizontal: 12,
  },
  messagesList: {
    padding: 16,
    paddingBottom: 8,
  },
  emptyMessages: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 48,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 8,
    maxWidth: '80%',
  },
  messageRowOwn: {
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
  },
  messageAvatar: {
    marginRight: 8,
    marginTop: 4,
  },
  avatarPlaceholder: {
    width: 36,
  },
  messageBubble: {
    padding: 12,
    borderRadius: 16,
    maxWidth: '100%',
  },
  systemMessage: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 24 : 8,
  },
  textInput: {
    flex: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxHeight: 100,
    fontSize: 16,
  },
  blockedContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    paddingBottom: Platform.OS === 'ios' ? 28 : 14,
  },
});
