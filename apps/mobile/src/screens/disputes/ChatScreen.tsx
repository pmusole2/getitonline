import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Avatar, Button, Card, IconButton, Snackbar, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, { FadeIn, FadeOut, SlideInUp } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useAppAuth } from '../../context/AuthProvider';
import { useAiActions } from '../../hooks/useAiActions';
import { requestAIConsent } from '../../services/aiConsent';
import { disputeFailureMessage } from '../../services/aiAdapters';
import type { Id, MessageWithSender, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Chat'>;

export default function ChatScreen(props: Props) {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Dispute Chat" />;
  }
  return <ChatContent {...props} />;
}

function ChatContent({ route, navigation }: Props) {
  const theme = useTheme();
  const { disputeId } = route.params;
  const { user } = useAppAuth();
  const flatListRef = useRef<FlatList>(null);

  const ai = useAiActions();
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  // A rewrite is kept with the draft it was made from, so it is offered only while that draft is still in the composer.
  const [rephraseSuggestion, setRephraseSuggestion] = useState<{ draft: string; text: string } | null>(null);
  const [rephrasing, setRephrasing] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [responseSuggestions, setResponseSuggestions] = useState<string[]>([]);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
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

  // Reset the rewrite when the composer no longer holds the draft it was made from
  useEffect(() => {
    if (rephraseSuggestion && messageText !== rephraseSuggestion.draft) {
      setRephraseSuggestion(null);
    }
  }, [messageText, rephraseSuggestion]);

  // A result from another account is discarded by the AI layer. This clears what the previous account was shown.
  useEffect(() => {
    setRephraseSuggestion(null);
    setRephrasing(false);
    setShowSuggestions(false);
    setResponseSuggestions([]);
    setSuggestionError(null);
    setLoadingSuggestions(false);
  }, [ai.subject]);

  const handleSend = async (textToSend?: string) => {
    const finalText = textToSend || messageText;
    if (!user || !finalText.trim()) return;

    setSending(true);
    try {
      await sendMessage({
        disputeId: disputeId as Id<'disputes'>,
        content: finalText.trim(),
      });
      setMessageText('');
      setRephraseSuggestion(null);
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
      if (!ai.isCurrent()) return;
      if (!hasConsent) {
        setSnackbarMessage(`${ASSISTANT_NAME} is off until you allow AI features.`);
        setSnackbarVisible(true);
        return;
      }

      // The backend reads the dispute and the viewer's side. Only the dispute id and the draft are sent.
      const outcome = await ai.rephraseMessage({ disputeId, message: messageText });
      if (!ai.isCurrent()) return;

      if (outcome.kind === 'suggested') {
        setRephraseSuggestion({ draft: messageText, text: outcome.text });
        setSnackbarMessage(`${ASSISTANT_NAME} suggests a clearer message`);
      } else {
        setRephraseSuggestion(null);
        setSnackbarMessage(outcome.message);
      }
      setSnackbarVisible(true);
    } catch (error: unknown) {
      const message = disputeFailureMessage(error);
      if (message !== null && ai.isCurrent()) {
        setSnackbarMessage(message);
        setSnackbarVisible(true);
      }
    } finally {
      if (ai.isCurrent()) setRephrasing(false);
    }
  };

  const handleAcceptRephrase = () => {
    if (rephraseSuggestion) {
      setMessageText(rephraseSuggestion.text);
      setRephraseSuggestion(null);
    }
  };

  const handleLoadSuggestions = useCallback(async () => {
    if (!messages || messages.length === 0 || !dispute) return;

    setLoadingSuggestions(true);
    setShowSuggestions(true);
    setResponseSuggestions([]);
    setSuggestionError(null);

    try {
      const hasConsent = await requestAIConsent();
      if (!ai.isCurrent()) return;
      if (!hasConsent) {
        setSuggestionError(`${ASSISTANT_NAME} is off until you allow AI features.`);
        return;
      }

      const suggestions = await ai.suggestResponses({ disputeId });
      if (!ai.isCurrent()) return;
      setResponseSuggestions(suggestions);
    } catch (error: unknown) {
      // A refused or failed request shows its reason. No suggestion is made up in its place.
      if (ai.isCurrent()) setSuggestionError(disputeFailureMessage(error));
    } finally {
      if (ai.isCurrent()) setLoadingSuggestions(false);
    }
  }, [messages, dispute, ai, disputeId]);

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
            isOwnMessage ? { backgroundColor: theme.colors.primary } : { backgroundColor: theme.colors.surfaceVariant },
          ]}
        >
          {!isOwnMessage && (
            <Text variant="labelSmall" style={{ color: theme.colors.primary, marginBottom: 4 }}>
              {item.sender ? `${item.sender.firstName} ${item.sender.lastName}` : 'Unknown'}
            </Text>
          )}
          <Text variant="bodyMedium" style={{ color: isOwnMessage ? theme.colors.onPrimary : theme.colors.onSurface }}>
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

  // The conversation waits for the requested dispute, so no composer shows before the dispute is known.
  if (messages === undefined || dispute === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Chat" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, { flex: 1 }]}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  if (dispute === null) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Dispute Chat" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, styles.missingState]}>
          <Icon name="alert-circle-outline" size={48} color={theme.colors.onSurfaceVariant} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16, textAlign: 'center' }}>
            This dispute is no longer available.
          </Text>
          <Button mode="contained" onPress={() => navigation.goBack()} style={styles.missingAction}>
            Back to disputes
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title="Dispute Chat" onBackPress={() => navigation.goBack()} showAIIndicator />

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
            ) : suggestionError !== null ? (
              <Text variant="bodySmall" style={{ color: theme.colors.error, padding: 12 }}>
                {suggestionError}
              </Text>
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

        {/* AI Rephrase Result Card, shown only for a rewrite the backend made */}
        {rephraseSuggestion && (
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

            <Surface style={[styles.rephrasedText, { backgroundColor: theme.colors.surface }]}>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                "{rephraseSuggestion.text}"
              </Text>
            </Surface>

            <View style={styles.rephraseActions}>
              <Button mode="text" onPress={() => setRephraseSuggestion(null)} compact>
                Keep Original
              </Button>
              <Button mode="contained" onPress={handleAcceptRephrase} compact>
                Use Suggestion
              </Button>
            </View>
          </Animated.View>
        )}

        {/* AI Help Card */}
        {messageText.length > 20 && !rephraseSuggestion && !rephrasing && (
          <Card style={[styles.aiCard, { backgroundColor: theme.colors.surfaceVariant }]}>
            <Card.Content style={styles.aiCardContent}>
              <Icon name="shield-check" size={18} color={theme.colors.tertiary} />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, flex: 1, marginHorizontal: 8 }}>
                {ASSISTANT_NAME} can help make your message clearer
              </Text>
              <Button mode="text" onPress={handleRephrase} loading={rephrasing} disabled={rephrasing} compact>
                Check
              </Button>
            </Card.Content>
          </Card>
        )}

        {/* Input Area */}
        <View
          style={[
            styles.inputContainer,
            { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.outlineVariant },
          ]}
        >
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
                  <TextInput.Icon icon="send" onPress={() => handleSend()} disabled={!messageText.trim()} />
                )
              }
            />
          </View>
        </View>

        <Snackbar visible={snackbarVisible} onDismiss={() => setSnackbarVisible(false)} duration={3000}>
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
  missingState: {
    flex: 1,
    padding: 24,
  },
  missingAction: {
    marginTop: 24,
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
