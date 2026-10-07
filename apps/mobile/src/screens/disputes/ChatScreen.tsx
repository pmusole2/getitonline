import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Avatar, Button, Card, IconButton, Snackbar, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, { FadeIn, FadeOut, SlideInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useAppAuth } from '../../context/AuthProvider';
import { requestAIConsent } from '../../services/aiConsent';
import { apiService, RephraseResponse } from '../../services/api';
import type { Id, MessageWithSender, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { disputeId } = route.params;
  const { user } = useAppAuth();
  const flatListRef = useRef<FlatList>(null);

  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [rephraseResult, setRephraseResult] = useState<RephraseResponse | null>(null);
  const [rephrasing, setRephrasing] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [responseSuggestions, setResponseSuggestions] = useState<string[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');

  const messages = useQuery(api.messages.getMessages, { disputeId: disputeId as Id<'disputes'> });
  const dispute = useQuery(api.disputes.getDispute, { disputeId: disputeId as Id<'disputes'> });
  const sendMessage = useMutation(api.messages.sendMessage);

  useEffect(() => {
    if (messages && messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages?.length]);

  // Reset rephrase result when message changes significantly
  useEffect(() => {
    if (rephraseResult && messageText !== rephraseResult.rephrased && messageText !== rephraseResult.original) {
      setRephraseResult(null);
    }
  }, [messageText, rephraseResult]);

  const handleSend = async (textToSend?: string) => {
    const finalText = textToSend || messageText;
    if (!user || !finalText.trim()) return;

    setSending(true);
    try {
      await sendMessage({
        disputeId: disputeId as Id<'disputes'>,
        senderId: user._id,
        content: finalText.trim(),
      });
      setMessageText('');
      setRephraseResult(null);
      setShowSuggestions(false);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
      setSnackbarMessage(errorMessage);
      setSnackbarVisible(true);
    } finally {
      setSending(false);
    }
  };

  const handleRephrase = async () => {
    if (!messageText.trim() || messageText.length < 10) return;

    setRephrasing(true);
    try {
      const hasConsent = await requestAIConsent();
      if (!hasConsent) {
        setSnackbarMessage(`${ASSISTANT_NAME} is off until you allow AI features.`);
        setSnackbarVisible(true);
        return;
      }

      // Determine user's role in the dispute
      const senderRole = user?._id === dispute?.buyerId ? 'buyer' :
                        user?._id === dispute?.sellerId ? 'seller' : 'buyer';

      const result = await apiService.rephraseMessage({
        message: messageText,
        senderRole,
        disputeContext: dispute?.description || 'Dispute resolution conversation',
      });

      setRephraseResult(result);

      if (!result.isProfessional && result.rephrased !== messageText) {
        setSnackbarMessage(`${ASSISTANT_NAME} suggests a clearer message`);
      } else {
        setSnackbarMessage('Your message looks professional!');
      }
      setSnackbarVisible(true);
    } catch {
      setSnackbarMessage('Unable to check message right now');
      setSnackbarVisible(true);
    } finally {
      setRephrasing(false);
    }
  };

  const handleAcceptRephrase = () => {
    if (rephraseResult?.rephrased) {
      setMessageText(rephraseResult.rephrased);
      setRephraseResult(null);
    }
  };

  const handleLoadSuggestions = useCallback(async () => {
    if (!messages || messages.length === 0 || !dispute) return;

    setLoadingSuggestions(true);
    setShowSuggestions(true);

    try {
      const hasConsent = await requestAIConsent();
      if (!hasConsent) {
        setResponseSuggestions([]);
        return;
      }

      const conversationHistory = messages.slice(-10).map(m => ({
        sender: m.senderId === dispute.buyerId ? 'buyer' :
                m.senderId === dispute.sellerId ? 'seller' : 'moderator',
        message: m.content,
      }));

      const respondAs = user?._id === dispute.buyerId ? 'buyer' :
                       user?._id === dispute.sellerId ? 'seller' : 'buyer';

      const suggestions = await apiService.getResponseSuggestions(
        conversationHistory,
        respondAs as 'buyer' | 'seller' | 'moderator',
        dispute.description || 'Dispute resolution'
      );

      setResponseSuggestions(suggestions);
    } catch {
      setResponseSuggestions([
        "I understand your concern and would like to resolve this.",
        "Could you provide more details about the issue?",
        "I'm willing to work together on a solution.",
      ]);
    } finally {
      setLoadingSuggestions(false);
    }
  }, [messages, dispute, user]);

  const handleUseSuggestion = (suggestion: string) => {
    setMessageText(suggestion);
    setShowSuggestions(false);
  };

  const renderMessage = ({ item }: { item: MessageWithSender }) => {
    const isOwnMessage = item.senderId === user?._id;
    const isSystemMessage = item.isSystemMessage;

    if (isSystemMessage) {
      return (
        <View style={styles.systemMessageContainer}>
          <Text variant="bodySmall" style={[styles.systemMessage, { backgroundColor: theme.colors.surfaceVariant }]}>
            {item.content}
          </Text>
        </View>
      );
    }

    return (
      <View style={[styles.messageRow, isOwnMessage && styles.ownMessageRow]}>
        {!isOwnMessage && (
          <Avatar.Text
            size={32}
            label={item.sender ? `${item.sender.firstName[0]}${item.sender.lastName[0]}` : '?'}
            style={styles.avatar}
          />
        )}
        <View
          style={[
            styles.messageBubble,
            isOwnMessage
              ? { backgroundColor: theme.colors.primary }
              : { backgroundColor: theme.colors.surfaceVariant },
          ]}
        >
          {!isOwnMessage && (
            <Text variant="labelSmall" style={{ color: theme.colors.primary, marginBottom: 4 }}>
              {item.sender ? `${item.sender.firstName} ${item.sender.lastName}` : 'Unknown'}
            </Text>
          )}
          <Text
            variant="bodyMedium"
            style={{ color: isOwnMessage ? theme.colors.onPrimary : theme.colors.onSurface }}
          >
            {item.content}
          </Text>

          {/* AI Rephrased indicator */}
          {item.originalContent && item.aiRephraseAccepted && (
            <View style={styles.rephrasedBadge}>
              <Icon name="robot" size={12} color={theme.colors.tertiary} />
              <Text variant="labelSmall" style={{ color: theme.colors.tertiary, marginLeft: 4 }}>
                Enhanced by {ASSISTANT_NAME}
              </Text>
            </View>
          )}

          <Text
            variant="bodySmall"
            style={{
              color: isOwnMessage ? theme.colors.onPrimary + '99' : theme.colors.onSurfaceVariant,
              marginTop: 4,
              alignSelf: 'flex-end',
            }}
          >
            {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  };

  if (messages === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Chat" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, { flex: 1 }]}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Dispute Chat"
        onBackPress={() => navigation.goBack()}
        showAIIndicator
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {/* Messages List */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.messagesList}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Icon name="message-text-outline" size={48} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
                No messages yet
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
                Start the conversation
              </Text>
            </View>
          }
        />

        {/* AI Response Suggestions */}
        {showSuggestions && (
          <Animated.View
            entering={SlideInUp.springify().damping(18)}
            exiting={FadeOut.duration(200)}
            style={[styles.suggestionsCard, { backgroundColor: theme.colors.surface }]}
          >
            <View style={styles.suggestionsHeader}>
              <Icon name="robot" size={20} color={theme.colors.tertiary} />
              <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginLeft: 8, flex: 1 }}>
                {ASSISTANT_NAME}'s Suggestions
              </Text>
              <IconButton icon="close" size={18} onPress={() => setShowSuggestions(false)} />
            </View>

            {loadingSuggestions ? (
              <ActivityIndicator style={{ marginVertical: 16 }} />
            ) : (
              <View style={styles.suggestionsList}>
                {responseSuggestions.map((suggestion, index) => (
                  <Pressable
                    key={index}
                    style={[styles.suggestionItem, { backgroundColor: theme.colors.surfaceVariant }]}
                    onPress={() => handleUseSuggestion(suggestion)}
                  >
                    <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                      {suggestion}
                    </Text>
                    <Icon name="chevron-right" size={20} color={theme.colors.primary} />
                  </Pressable>
                ))}
              </View>
            )}
          </Animated.View>
        )}

        {/* AI Rephrase Result Card */}
        {rephraseResult && !rephraseResult.isProfessional && rephraseResult.rephrased !== messageText && (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(200)}
            style={[styles.rephraseCard, { backgroundColor: theme.colors.tertiaryContainer }]}
          >
            <View style={styles.rephraseHeader}>
              <Icon name="robot" size={20} color={theme.colors.tertiary} />
              <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8 }}>
                Suggested Improvement
              </Text>
            </View>

            {rephraseResult.issues.length > 0 && (
              <View style={styles.issuesList}>
                {rephraseResult.issues.map((issue, index) => (
                  <View key={index} style={styles.issueItem}>
                    <Icon name="alert-circle-outline" size={14} color={theme.colors.error} />
                    <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 6, flex: 1 }}>
                      {issue}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            <Surface style={[styles.rephrasedText, { backgroundColor: theme.colors.surface }]}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                "{rephraseResult.rephrased}"
              </Text>
            </Surface>

            <View style={styles.rephraseActions}>
              <Button mode="text" onPress={() => setRephraseResult(null)} compact>
                Keep Original
              </Button>
              <Button mode="contained" onPress={handleAcceptRephrase} compact>
                Use Suggestion
              </Button>
            </View>
          </Animated.View>
        )}

        {/* AI Help Card */}
        {messageText.length > 20 && !rephraseResult && !rephrasing && (
          <Card style={[styles.aiCard, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Card.Content style={styles.aiCardContent}>
              <Icon name="shield-check" size={18} color={theme.colors.tertiary} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, marginHorizontal: 8 }}>
                {ASSISTANT_NAME} can help make your message clearer
              </Text>
              <Button
                mode="text"
                onPress={handleRephrase}
                loading={rephrasing}
                disabled={rephrasing}
                compact
              >
                Check
              </Button>
            </Card.Content>
          </Card>
        )}

        {/* Input Area */}
        <View style={[styles.inputContainer, { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.outlineVariant }]}>
          <View style={styles.inputRow}>
            <IconButton
              icon="lightbulb-outline"
              size={22}
              onPress={handleLoadSuggestions}
              iconColor={theme.colors.tertiary}
              disabled={!messages || messages.length === 0}
            />
            <TextInput
              mode="outlined"
              placeholder="Type a message..."
              value={messageText}
              onChangeText={setMessageText}
              style={styles.input}
              multiline
              maxLength={2000}
              dense
              right={
                sending ? (
                  <TextInput.Icon icon={() => <ActivityIndicator size={20} />} />
                ) : (
                  <TextInput.Icon
                    icon="send"
                    onPress={() => handleSend()}
                    disabled={!messageText.trim()}
                  />
                )
              }
            />
          </View>
        </View>

        <Snackbar
          visible={snackbarVisible}
          onDismiss={() => setSnackbarVisible(false)}
          duration={3000}
        >
          {snackbarMessage}
        </Snackbar>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  messagesList: {
    padding: 16,
    flexGrow: 1,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 12,
    alignItems: 'flex-end',
  },
  ownMessageRow: {
    justifyContent: 'flex-end',
  },
  avatar: {
    marginRight: 8,
  },
  messageBubble: {
    maxWidth: '75%',
    padding: 12,
    borderRadius: 16,
  },
  rephrasedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.2)',
  },
  systemMessageContainer: {
    alignItems: 'center',
    marginVertical: 8,
  },
  systemMessage: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 64,
  },
  suggestionsCard: {
    margin: 16,
    borderRadius: 16,
    elevation: 2,
  },
  suggestionsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.1)',
  },
  suggestionsList: {
    padding: 12,
    gap: 8,
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 12,
  },
  rephraseCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 16,
    borderRadius: 16,
  },
  rephraseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  issuesList: {
    marginBottom: 12,
    gap: 4,
  },
  issueItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  rephrasedText: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 12,
  },
  rephraseActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  aiCard: {
    marginHorizontal: 16,
    marginBottom: 8,
    borderRadius: 12,
  },
  aiCardContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  inputContainer: {
    padding: 12,
    borderTopWidth: 1,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    maxHeight: 100,
  },
});
