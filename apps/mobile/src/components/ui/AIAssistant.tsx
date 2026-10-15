import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { MotiView } from 'moti';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Chip, IconButton, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { AiRequestError } from '@gettitonline/shared';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useAiActions } from '../../hooks/useAiActions';
import { aiErrorMessage, type ChatResponse } from '../../services/aiAdapters';
import { requestAIConsent } from '../../services/aiConsent';
import type { RootStackParamList } from '../../types';

// ============================================================================
// TYPES
// ============================================================================

interface ChatMessage {
  id: string;
  content: string;
  isUser: boolean;
  timestamp: Date;
  actions?: ChatResponse['actions'];
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AIAssistantModalProps {
  visible: boolean;
  onClose: () => void;
  currentScreen?: string;
  productId?: string;
  orderId?: string;
}

// ============================================================================
// FAB COMPONENT
// ============================================================================

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function AIAssistantFAB({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
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
      style={[styles.fab, animatedStyle]}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      <Surface style={[styles.fabSurface, { backgroundColor: theme.colors.primary }]} elevation={4}>
        {/* Pulsing ring */}
        <MotiView
          from={{ scale: 0.8, opacity: 0.8 }}
          animate={{ scale: 1.3, opacity: 0 }}
          transition={{
            scale: { type: 'timing', duration: 1500, loop: true },
            opacity: { type: 'timing', duration: 1500, loop: true },
          }}
          style={[styles.pulseRing, { borderColor: theme.colors.primary }]}
        />
        <Icon name="robot" size={28} color={theme.colors.onPrimary} />
      </Surface>
    </AnimatedPressable>
  );
}

// ============================================================================
// MODAL COMPONENT
// ============================================================================

function initialMessages(): ChatMessage[] {
  return [
    {
      id: '1',
      content: `Hi! I'm ${ASSISTANT_NAME}, your shopping assistant. I can help you discover products, compare prices, track orders, and more. How can I help you today?`,
      isUser: false,
      timestamp: new Date(),
    },
  ];
}

export function AIAssistantModal({
  visible,
  onClose,
  currentScreen = 'Home',
  productId,
}: AIAssistantModalProps) {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const ai = useAiActions();
  const scrollViewRef = useRef<ScrollView>(null);

  const [message, setMessage] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [isConnected, setIsConnected] = useState(true);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([
    'Find trending products',
    'Track my order',
    'How does escrow work?',
    'Help with dispute',
  ]);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [conversationHistory, setConversationHistory] = useState<ConversationMessage[]>([]);

  // The conversation belongs to the account that started it. A change of account starts a new one, and any reply still
  // in flight for the old account is discarded by the AI actions.
  useEffect(() => {
    setMessages(initialMessages());
    setConversationHistory([]);
    setMessage('');
    setIsTyping(false);
  }, [ai.subject]);

  useEffect(() => {
    if (visible) {
      loadQuickActions();
    }
  }, [visible, currentScreen]);

  useEffect(() => {
    if (!visible) {
      setIsKeyboardVisible(false);
      return;
    }

    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSubscription = Keyboard.addListener(showEvent, () => {
      setIsKeyboardVisible(true);
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 120);
    });
    const hideSubscription = Keyboard.addListener(hideEvent, () => {
      setIsKeyboardVisible(false);
    });

    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, [visible]);

  const loadQuickActions = async () => {
    try {
      // For now, use default suggestions - can be replaced with API call
      const screenSuggestions: Record<string, string[]> = {
        Home: ['Find trending products', 'Show popular items', 'Track my order', 'Help with purchase'],
        Browse: ['Filter by price', 'Show new arrivals', 'Find items near me', 'Compare products'],
        ProductDetail: ['Is this compatible?', 'Shipping options?', 'Ask about condition', 'More photos'],
        Cart: ['Checkout help', 'Change shipping', 'Apply discount', 'Save for later'],
        Orders: ['Track order', 'Request refund', 'Contact seller', 'Leave review'],
      };
      setSuggestions(screenSuggestions[currentScreen] || screenSuggestions.Home);
    } catch {
      // Use defaults
    }
  };

  const handleSendMessage = useCallback(async () => {
    if (!message.trim() || isTyping) return;

    // This send belongs to the account active when it started. Every write after an await checks that it still does.
    const actions = ai;
    const userMessageText = message.trim();
    const hasConsent = await requestAIConsent();
    if (!actions.isCurrent()) return;
    if (!hasConsent) {
      const blockedMessage: ChatMessage = {
        id: Date.now().toString(),
        content:
          `${ASSISTANT_NAME} is off until you allow Gettitonline to send AI requests to OpenAI via our backend.`,
        isUser: false,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, blockedMessage]);
      return;
    }

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      content: userMessageText,
      isUser: true,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setMessage('');
    setIsTyping(true);

    // Scroll to bottom
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await actions.chat({
        message: userMessageText,
        conversationHistory,
        currentScreen,
        productId,
      });
      if (!actions.isCurrent()) return;

      const aiMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        content: response.message,
        isUser: false,
        timestamp: new Date(),
        actions: response.actions,
      };

      setMessages((prev) => [...prev, aiMessage]);

      // Update conversation history
      setConversationHistory((prev) => [
        ...prev,
        { role: 'user', content: userMessageText },
        { role: 'assistant', content: response.message },
      ]);

      // Update suggestions if provided
      if (response.suggestions && response.suggestions.length > 0) {
        setSuggestions(response.suggestions);
      }

      setIsConnected(true);
    } catch (error: unknown) {
      // A reply for a previous account is dropped silently. Only a failed connection marks Pinkie offline.
      const content = aiErrorMessage(error);
      if (content === null || !actions.isCurrent()) {
        return;
      }
      console.error('Chat error:', error);
      if (error instanceof AiRequestError && error.code === 'unavailable') {
        setIsConnected(false);
      }

      const errorMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        content,
        isUser: false,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      if (actions.isCurrent()) {
        setIsTyping(false);
      }
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [ai, message, isTyping, conversationHistory, currentScreen, productId]);

  const handleSuggestionPress = (suggestion: string) => {
    setMessage(suggestion);
  };

  const handleClose = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);

  const handleActionPress = (action: NonNullable<ChatResponse['actions']>[number]) => {
    switch (action.type) {
      case 'navigate':
        handleClose();
        if (action.payload.screen) {
          // Use type assertion to bypass TypeScript's strict navigate typing
          navigation.navigate({
            name: action.payload.screen as any,
            params: undefined,
          } as any);
        }
        break;
      case 'search':
        handleClose();
        navigation.navigate('Search', { query: action.payload.query });
        break;
      case 'filter':
        // Handle filter action
        break;
    }
  };

  const handleClearChat = () => {
    setMessages([
      {
        id: '1',
        content: `Hi! I'm ${ASSISTANT_NAME}, your shopping assistant. I can help you discover products, compare prices, track orders, and more. How can I help you today?`,
        isUser: false,
        timestamp: new Date(),
      },
    ]);
    setConversationHistory([]);
    loadQuickActions();
  };

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        behavior="height"
        style={styles.modalOverlay}
        keyboardVerticalOffset={0}
      >
        <Pressable style={styles.modalBackdrop} onPress={handleClose} />

        <Animated.View
          entering={FadeIn.duration(180)}
          exiting={FadeOut.duration(140)}
          style={[
            styles.modalContent,
            isKeyboardVisible && styles.modalContentKeyboard,
            { backgroundColor: theme.colors.surface },
          ]}
        >
          {/* Header */}
          <View style={[styles.modalHeader, { borderBottomColor: theme.colors.outlineVariant }]}>
            <View style={styles.headerLeft}>
              <View style={[styles.aiAvatar, { backgroundColor: theme.colors.primaryContainer }]}>
                <Icon name="robot" size={24} color={theme.colors.primary} />
              </View>
              <View style={styles.headerInfo}>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                  {ASSISTANT_NAME}
                </Text>
                <View style={styles.statusRow}>
                  <View
                    style={[
                      styles.statusDot,
                      { backgroundColor: isConnected ? theme.colors.secondary : theme.colors.error },
                    ]}
                  />
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                    {isConnected ? 'Online' : 'Offline'}
                  </Text>
                </View>
              </View>
            </View>
            <View style={styles.headerActions}>
              <IconButton icon="refresh" size={20} onPress={handleClearChat} />
              <IconButton icon="close" size={20} onPress={handleClose} />
            </View>
          </View>

          {/* Messages */}
          <View style={styles.keyboardView}>
            <ScrollView
              ref={scrollViewRef}
              style={styles.messagesContainer}
              contentContainerStyle={styles.messagesContent}
              showsVerticalScrollIndicator={false}
              keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
            >
              {messages.map((msg, index) => (
                <Animated.View
                  key={msg.id}
                  entering={FadeIn.delay(index === messages.length - 1 ? 0 : index * 50).duration(300)}
                  style={[
                    styles.messageBubble,
                    msg.isUser ? styles.userMessage : styles.aiMessage,
                    {
                      backgroundColor: msg.isUser
                        ? theme.colors.primary
                        : theme.colors.surfaceVariant,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: msg.isUser ? theme.colors.onPrimary : theme.colors.onSurface,
                      lineHeight: 20,
                    }}
                  >
                    {msg.content}
                  </Text>

                  {/* Action buttons */}
                  {msg.actions && msg.actions.length > 0 && (
                    <View style={styles.actionsContainer}>
                      {msg.actions.map((action, actionIndex) => (
                        <Chip
                          key={actionIndex}
                          mode="outlined"
                          onPress={() => handleActionPress(action)}
                          style={styles.actionChip}
                          textStyle={{ fontSize: 12 }}
                          icon={() => (
                            <Icon
                              name={
                                action.type === 'navigate'
                                  ? 'arrow-right'
                                  : action.type === 'search'
                                    ? 'magnify'
                                    : 'filter'
                              }
                              size={14}
                              color={theme.colors.primary}
                            />
                          )}
                        >
                          {action.label}
                        </Chip>
                      ))}
                    </View>
                  )}
                </Animated.View>
              ))}

              {isTyping && (
                <Animated.View
                  entering={FadeIn.duration(300)}
                  exiting={FadeOut.duration(200)}
                  style={[styles.typingIndicator, { backgroundColor: theme.colors.surfaceVariant }]}
                >
                  <MotiView
                    from={{ opacity: 0.3 }}
                    animate={{ opacity: 1 }}
                    transition={{ opacity: { type: 'timing', duration: 500, loop: true } }}
                    style={[styles.typingDot, { backgroundColor: theme.colors.onSurfaceVariant }]}
                  />
                  <MotiView
                    from={{ opacity: 0.3 }}
                    animate={{ opacity: 1 }}
                    transition={{ opacity: { type: 'timing', duration: 500, delay: 150, loop: true } }}
                    style={[styles.typingDot, { backgroundColor: theme.colors.onSurfaceVariant }]}
                  />
                  <MotiView
                    from={{ opacity: 0.3 }}
                    animate={{ opacity: 1 }}
                    transition={{ opacity: { type: 'timing', duration: 500, delay: 300, loop: true } }}
                    style={[styles.typingDot, { backgroundColor: theme.colors.onSurfaceVariant }]}
                  />
                </Animated.View>
              )}
            </ScrollView>

            {/* Suggestions */}
            {messages.length <= 3 && !isTyping && !isKeyboardVisible && (
              <Animated.View
                entering={FadeIn.delay(200).duration(300)}
                style={styles.suggestionsContainer}
              >
                <Text
                  variant="labelMedium"
                  style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}
                >
                  Quick Actions
                </Text>
                <View style={styles.suggestionsRow}>
                  {suggestions.map((suggestion, index) => (
                    <Pressable
                      key={index}
                      style={[styles.suggestionChip, { backgroundColor: theme.colors.surfaceVariant }]}
                      onPress={() => handleSuggestionPress(suggestion)}
                    >
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {suggestion}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </Animated.View>
            )}

            {/* Input */}
            <View style={[styles.inputContainer, { borderTopColor: theme.colors.outlineVariant }]}>
              <TextInput
                mode="outlined"
                placeholder="Ask me anything..."
                value={message}
                onChangeText={setMessage}
                style={styles.input}
                dense
                disabled={isTyping}
                right={
                  isTyping ? (
                    <TextInput.Icon icon={() => <ActivityIndicator size={20} />} />
                  ) : (
                    <TextInput.Icon
                      icon="send"
                      onPress={handleSendMessage}
                      disabled={!message.trim()}
                    />
                  )
                }
                onSubmitEditing={handleSendMessage}
                onFocus={() => {
                  setTimeout(() => {
                    scrollViewRef.current?.scrollToEnd({ animated: true });
                  }, 120);
                }}
                returnKeyType="send"
              />
            </View>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ============================================================================
// AI INSIGHT CARD
// ============================================================================

export function AIInsightCard({
  title,
  description,
  icon = 'lightbulb-outline',
  onPress,
}: {
  title: string;
  description: string;
  icon?: string;
  onPress?: () => void;
}) {
  const theme = useTheme();

  return (
    <Pressable onPress={onPress}>
      <Surface style={[styles.insightCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={1}>
        <View style={styles.insightContent}>
          <View style={[styles.insightIcon, { backgroundColor: theme.colors.tertiary + '20' }]}>
            <Icon name={icon} size={24} color={theme.colors.tertiary} />
          </View>
          <View style={styles.insightText}>
            <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer }}>
              {title}
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onTertiaryContainer, marginTop: 4, opacity: 0.8 }}
              numberOfLines={2}
            >
              {description}
            </Text>
          </View>
          <Icon name="chevron-right" size={24} color={theme.colors.tertiary} />
        </View>
      </Surface>
    </Pressable>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 80,
    zIndex: 100,
  },
  fabSurface: {
    width: 60,
    height: 60,
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalContent: {
    height: '80%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
  },
  modalContentKeyboard: {
    height: '92%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  aiAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerInfo: {
    marginLeft: 12,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  keyboardView: {
    flex: 1,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    padding: 16,
    paddingBottom: 24,
  },
  messageBubble: {
    maxWidth: '85%',
    padding: 12,
    borderRadius: 16,
    marginBottom: 12,
  },
  userMessage: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 4,
  },
  aiMessage: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 4,
  },
  actionsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  actionChip: {
    height: 32,
  },
  typingIndicator: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: 12,
    borderRadius: 16,
    gap: 4,
  },
  typingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  suggestionsContainer: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  suggestionChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  inputContainer: {
    padding: 16,
    borderTopWidth: 1,
  },
  input: {
    marginBottom: 0,
  },
  insightCard: {
    borderRadius: 16,
    marginBottom: 12,
  },
  insightContent: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  insightIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  insightText: {
    flex: 1,
    marginHorizontal: 12,
  },
});
