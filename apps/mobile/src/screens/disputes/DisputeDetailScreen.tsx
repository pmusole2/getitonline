import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { MotiView } from 'moti';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Avatar, Button, Card, Chip, Dialog, Divider, Portal, Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useAppAuth } from '../../context/AuthProvider';
import { requestAIConsent } from '../../services/aiConsent';
import { apiService, DisputeAnalysisResponse } from '../../services/api';
import { formatPrice } from '../../theme';
import type { DisputeCategory, DisputeStatus, Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'DisputeDetail'>;
type ModeratorResolution = 'full_refund' | 'partial_refund' | 'no_refund';

const categoryLabels: Record<DisputeCategory, string> = {
  not_received: 'Item Not Received',
  not_as_described: 'Item Not As Described',
  defective: 'Defective Item',
  other: 'Other',
};

const statusLabels: Record<DisputeStatus, string> = {
  open: 'Open',
  in_discussion: 'In Discussion',
  moderator_review: 'Under Review',
  resolved: 'Resolved',
  closed: 'Closed',
};

export default function DisputeDetailScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { disputeId } = route.params;
  const { user } = useAppAuth();

  const [aiAnalysis, setAiAnalysis] = useState<DisputeAnalysisResponse | null>(null);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [resolveDialogVisible, setResolveDialogVisible] = useState(false);
  const [moderationDialogVisible, setModerationDialogVisible] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [moderationOutcome, setModerationOutcome] = useState<ModeratorResolution>('no_refund');
  const [moderationNotes, setModerationNotes] = useState('');
  const [partialRefundAmount, setPartialRefundAmount] = useState('');
  const [assigningModerator, setAssigningModerator] = useState(false);
  const [closingCase, setClosingCase] = useState(false);

  const dispute = useQuery(api.disputes.getDispute, { disputeId: disputeId as Id<'disputes'> });
  const buyerResolveDispute = useMutation(api.disputes.buyerResolveDispute);
  const assignModerator = useMutation(api.disputes.assignModerator);
  const resolveDisputeMutation = useMutation(api.disputes.resolveDispute);
  const updateDisputeStatus = useMutation(api.disputes.updateDisputeStatus);

  const handleOpenChat = () => {
    navigation.navigate('Chat', { disputeId });
  };

  const handleResolveDispute = async (
    resolutionType: 'withdraw' | 'received_item' | 'issue_resolved' | 'agreed_refund'
  ) => {
    if (!user) return;

    const confirmMessages: Record<string, string> = {
      withdraw: 'Are you sure you want to withdraw this dispute? The funds will be released to the seller.',
      received_item: 'Confirm that you have received the item? The funds will be released to the seller.',
      issue_resolved: 'Confirm that the seller has resolved your issue? The funds will be released to the seller.',
      agreed_refund: 'Confirm that you have agreed on a refund with the seller? This will notify support to process it.',
    };

    Alert.alert(
      'Resolve Dispute',
      confirmMessages[resolutionType],
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          style: resolutionType === 'withdraw' ? 'destructive' : 'default',
          onPress: async () => {
            setResolving(true);
            try {
              await buyerResolveDispute({
                disputeId: disputeId as Id<'disputes'>,
                buyerId: user._id,
                resolutionType,
              });
              setResolveDialogVisible(false);
              Alert.alert('Success', 'Dispute has been resolved.');
            } catch (error: unknown) {
              const errorMessage = error instanceof Error ? error.message : 'Failed to resolve dispute';
              Alert.alert('Error', errorMessage);
            } finally {
              setResolving(false);
            }
          },
        },
      ]
    );
  };

  // Determine the viewer's role in this dispute
  const getViewerRole = (): 'buyer' | 'seller' | 'moderator' => {
    if (user?.role === 'moderator' || user?.role === 'admin') {
      return 'moderator';
    }
    if (user?._id === dispute?.buyerId) {
      return 'buyer';
    }
    if (user?._id === dispute?.sellerId) {
      return 'seller';
    }
    return 'moderator'; // Default to moderator view for neutral parties
  };

  const handleRequestAnalysis = async () => {
    if (!user) return;

    setLoadingAnalysis(true);
    setAnalysisError(null);

    try {
      const hasConsent = await requestAIConsent();
      if (!hasConsent) {
        setAnalysisError(`${ASSISTANT_NAME} is off until you allow AI features.`);
        return;
      }

      const viewerRole = getViewerRole();
      const analysis = await apiService.analyzeDispute({
        disputeId,
        viewerId: user._id,
        viewerRole,
      });
      setAiAnalysis(analysis);
    } catch (error) {
      setAnalysisError(`${ASSISTANT_NAME} couldn't analyze this dispute right now`);
      console.error('AI Analysis error:', error);
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const getStatusColor = (status: DisputeStatus): string => {
    const colors: Record<DisputeStatus, string> = {
      open: '#F59E0B',
      in_discussion: '#3B82F6',
      moderator_review: '#8B5CF6',
      resolved: '#10B981',
      closed: '#6B7280',
    };
    return colors[status] || theme.colors.outline;
  };

  const getRiskColor = (risk: 'low' | 'medium' | 'high'): string => {
    const colors = {
      low: '#10B981',
      medium: '#F59E0B',
      high: '#EF4444',
    };
    return colors[risk];
  };

  const getSentimentIcon = (sentiment: string): string => {
    const icons: Record<string, string> = {
      cooperative: 'emoticon-happy-outline',
      frustrated: 'emoticon-sad-outline',
      hostile: 'emoticon-angry-outline',
      neutral: 'emoticon-neutral-outline',
    };
    return icons[sentiment] || 'emoticon-neutral-outline';
  };

  if (dispute === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Dispute Details" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, { flex: 1 }]}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  if (dispute === null) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Dispute Details" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, { flex: 1 }]}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant }}>
            Dispute not found
          </Text>
        </View>
      </View>
    );
  }

  const isBuyer = user?._id === dispute.buyerId;
  const isSeller = user?._id === dispute.sellerId;
  const isModerator = user?.role === 'moderator' || user?.role === 'admin';
  const moderatorName = dispute.moderator
    ? `${dispute.moderator.firstName} ${dispute.moderator.lastName}`
    : null;
  const assignedToCurrentModerator = dispute.moderator?._id === user?._id;
  const moderationLimit =
    dispute.escrow?.grossAmount ?? dispute.escrow?.amount ?? dispute.order?.totalAmount ?? 0;

  const handleAssignToMe = async () => {
    if (!user || !isModerator) {
      return;
    }

    setAssigningModerator(true);

    try {
      await assignModerator({
        disputeId: disputeId as Id<'disputes'>,
        moderatorId: user._id,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to assign Reviewer-Approver';
      Alert.alert('Error', message);
    } finally {
      setAssigningModerator(false);
    }
  };

  const handleSubmitModeration = async () => {
    if (!user || !isModerator) {
      return;
    }

    const trimmedNotes = moderationNotes.trim();

    if (!trimmedNotes) {
      Alert.alert('Add notes', 'Provide resolution notes before submitting.');
      return;
    }

    const parsedRefund =
      moderationOutcome === 'partial_refund'
        ? Number.parseFloat(partialRefundAmount.trim())
        : undefined;

    if (
      moderationOutcome === 'partial_refund' &&
      (!Number.isFinite(parsedRefund) || !parsedRefund || parsedRefund <= 0 || parsedRefund > moderationLimit)
    ) {
      Alert.alert(
        'Invalid refund amount',
        `Enter a partial refund between 0 and ${formatPrice(moderationLimit)}.`
      );
      return;
    }

    setResolving(true);

    try {
      await resolveDisputeMutation({
        disputeId: disputeId as Id<'disputes'>,
        moderatorId: user._id,
        resolutionType: moderationOutcome,
        refundAmount: moderationOutcome === 'partial_refund' ? parsedRefund : undefined,
        notes: trimmedNotes,
      });

      setModerationDialogVisible(false);
      setModerationNotes('');
      setPartialRefundAmount('');
      setModerationOutcome('no_refund');
      Alert.alert('Dispute resolved', 'The dispute resolution was applied successfully.');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to resolve dispute';
      Alert.alert('Error', message);
    } finally {
      setResolving(false);
    }
  };

  const handleCloseCase = async () => {
    if (!user || !isModerator) {
      return;
    }

    setClosingCase(true);

    try {
      await updateDisputeStatus({
        disputeId: disputeId as Id<'disputes'>,
        userId: user._id,
        status: 'closed',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to close dispute';
      Alert.alert('Error', message);
    } finally {
      setClosingCase(false);
    }
  };

  // Determine the viewer's role for display
  const viewerRole = getViewerRole();

  // Use local analysis if available, otherwise fall back to stored analysis
  const displayAnalysis = aiAnalysis || (dispute.aiSummary ? {
    summary: dispute.aiSummary,
    keyPoints: {
      yourClaims: [],
      theirClaims: [],
      buyerClaims: [],
      sellerClaims: [],
    },
    sentiment: {
      yours: 'neutral' as const,
      theirs: 'neutral' as const,
      buyer: 'neutral' as const,
      seller: 'neutral' as const,
    },
    suggestedResolutions: (dispute.aiSuggestions || []).map(s => ({
      type: 'mutual_agreement' as const,
      description: s,
      fairnessScore: 7,
    })),
    recommendedAction: '',
    riskLevel: 'medium' as const,
    additionalNotes: '',
    viewerRole: viewerRole,
  } : null);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Dispute Details"
        onBackPress={() => navigation.goBack()}
        showAIIndicator={!!displayAnalysis}
      />

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {/* Dispute Header */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <Card style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Card.Content>
              <View style={styles.headerRow}>
                <Text variant="titleLarge" style={{ color: theme.colors.onSurface, flex: 1 }}>
                  {dispute.title}
                </Text>
                <Chip
                  mode="flat"
                  style={{ backgroundColor: getStatusColor(dispute.status) + '20' }}
                  textStyle={{ color: getStatusColor(dispute.status) }}
                >
                  {statusLabels[dispute.status]}
                </Chip>
              </View>

              <Chip mode="flat" compact style={styles.categoryChip} icon="tag">
                {categoryLabels[dispute.category]}
              </Chip>

              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
                {dispute.description}
              </Text>

              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
                Opened on {new Date(dispute.createdAt).toLocaleDateString()}
              </Text>
            </Card.Content>
          </Card>
        </Animated.View>

        {/* Related Order */}
        {dispute.order && (
          <Animated.View entering={FadeInDown.delay(150).duration(400)}>
            <Card style={[styles.card, { backgroundColor: theme.colors.surface }]}>
              <Card.Content>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 12 }}>
                  Related Order
                </Text>
              <View style={styles.orderInfo}>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                  Order #{dispute.order.orderNumber}
                </Text>
                <Text variant="titleSmall" style={{ color: theme.colors.primary }}>
                  {formatPrice(dispute.order.totalAmount)}
                </Text>
              </View>
              {moderatorName ? (
                <Chip compact icon="gavel" style={styles.moderatorChip}>
                  Assigned to {moderatorName}
                </Chip>
              ) : null}
            </Card.Content>
          </Card>
        </Animated.View>
        )}

        {/* Parties */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Card style={[styles.card, { backgroundColor: theme.colors.surface }]}>
            <Card.Content>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 12 }}>
                Parties Involved
              </Text>

              <View style={styles.partyRow}>
                <Avatar.Text
                  size={40}
                  label={dispute.buyer ? `${dispute.buyer.firstName[0]}${dispute.buyer.lastName[0]}` : '?'}
                />
                <View style={styles.partyInfo}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    {dispute.buyer ? `${dispute.buyer.firstName} ${dispute.buyer.lastName}` : 'Unknown'}
                  </Text>
                  <Text variant="bodySmall" style={{ color: isBuyer ? theme.colors.primary : theme.colors.onSurfaceVariant, fontWeight: isBuyer ? '600' : '400' }}>
                    {isBuyer ? 'You (Buyer)' : 'Buyer'}
                  </Text>
                </View>
                {displayAnalysis && (
                  <Icon
                    name={getSentimentIcon(isBuyer ? (displayAnalysis.sentiment.yours || displayAnalysis.sentiment.buyer) : (displayAnalysis.sentiment.theirs || displayAnalysis.sentiment.buyer))}
                    size={24}
                    color={theme.colors.onSurfaceVariant}
                  />
                )}
              </View>

              <Divider style={styles.divider} />

              <View style={styles.partyRow}>
                <Avatar.Text
                  size={40}
                  label={dispute.seller ? `${dispute.seller.firstName[0]}${dispute.seller.lastName[0]}` : '?'}
                />
                <View style={styles.partyInfo}>
                  <Text variant="bodyMedium" style={{ color: theme.colors.onSurface }}>
                    {dispute.seller ? `${dispute.seller.firstName} ${dispute.seller.lastName}` : 'Unknown'}
                  </Text>
                  <Text variant="bodySmall" style={{ color: isSeller ? theme.colors.primary : theme.colors.onSurfaceVariant, fontWeight: isSeller ? '600' : '400' }}>
                    {isSeller ? 'You (Seller)' : 'Seller'}
                  </Text>
                </View>
                {displayAnalysis && (
                  <Icon
                    name={getSentimentIcon(isSeller ? (displayAnalysis.sentiment.yours || displayAnalysis.sentiment.seller) : (displayAnalysis.sentiment.theirs || displayAnalysis.sentiment.seller))}
                    size={24}
                    color={theme.colors.onSurfaceVariant}
                  />
                )}
              </View>
            </Card.Content>
          </Card>
        </Animated.View>

        {/* Evidence */}
        {dispute.evidence && dispute.evidence.length > 0 && (
          <Animated.View entering={FadeInDown.delay(250).duration(400)}>
            <Card style={[styles.card, { backgroundColor: theme.colors.surface }]}>
              <Card.Content>
                <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginBottom: 12 }}>
                  Evidence ({dispute.evidence.length})
                </Text>
                <View style={styles.evidenceGrid}>
                  {dispute.evidence.map((item, index) => (
                    <View key={index} style={[styles.evidenceItem, { backgroundColor: theme.colors.surfaceVariant }]}>
                      <Icon
                        name={item.type === 'image' ? 'image' : 'video'}
                        size={24}
                        color={theme.colors.onSurfaceVariant}
                      />
                    </View>
                  ))}
                </View>
              </Card.Content>
            </Card>
          </Animated.View>
        )}

        {/* AI Analysis Section */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)}>
          {displayAnalysis ? (
            <Card style={[styles.card, { backgroundColor: theme.colors.tertiaryContainer }]}>
              <Card.Content>
                <View style={styles.aiHeader}>
                  <MotiView
                    from={{ rotate: '0deg' }}
                    animate={{ rotate: '360deg' }}
                    transition={{
                      rotate: { type: 'timing', duration: 3000, loop: true },
                    }}
                  >
                    <Icon name="creation" size={24} color={theme.colors.tertiary} />
                  </MotiView>
                  <Text variant="titleMedium" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}>
                    {ASSISTANT_NAME}'s Analysis
                  </Text>
                  {displayAnalysis.riskLevel && (
                    <Chip
                      compact
                      style={{ backgroundColor: getRiskColor(displayAnalysis.riskLevel) + '30' }}
                      textStyle={{ color: getRiskColor(displayAnalysis.riskLevel), fontSize: 12 }}
                    >
                      {displayAnalysis.riskLevel.toUpperCase()} RISK
                    </Chip>
                  )}
                </View>

                <Text variant="bodyMedium" style={{ color: theme.colors.onTertiaryContainer, marginTop: 12 }}>
                  {displayAnalysis.summary}
                </Text>

                {/* Key Points - Personalized based on viewer role */}
                {((displayAnalysis.keyPoints.yourClaims?.length ?? 0) > 0 || (displayAnalysis.keyPoints.theirClaims?.length ?? 0) > 0) ? (
                  <View style={styles.keyPointsSection}>
                    {(displayAnalysis.keyPoints.yourClaims?.length ?? 0) > 0 && (
                      <View style={styles.keyPointsGroup}>
                        <Text variant="labelMedium" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 8 }}>
                          Your Position:
                        </Text>
                        {displayAnalysis.keyPoints.yourClaims?.map((claim, index) => (
                          <View key={index} style={styles.keyPointItem}>
                            <Icon name="account-check" size={14} color={theme.colors.tertiary} />
                            <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}>
                              {claim}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {(displayAnalysis.keyPoints.theirClaims?.length ?? 0) > 0 && (
                      <View style={styles.keyPointsGroup}>
                        <Text variant="labelMedium" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 8 }}>
                          {viewerRole === 'buyer' ? "Seller's Position:" : viewerRole === 'seller' ? "Buyer's Position:" : "Other Party's Position:"}
                        </Text>
                        {displayAnalysis.keyPoints.theirClaims?.map((claim, index) => (
                          <View key={index} style={styles.keyPointItem}>
                            <Icon name={viewerRole === 'buyer' ? 'store' : 'account'} size={14} color={theme.colors.tertiary} />
                            <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}>
                              {claim}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                ) : (displayAnalysis.keyPoints.buyerClaims?.length > 0 || displayAnalysis.keyPoints.sellerClaims?.length > 0) && (
                  // Fallback for legacy analysis without personalized claims
                  <View style={styles.keyPointsSection}>
                    {displayAnalysis.keyPoints.buyerClaims?.length > 0 && (
                      <View style={styles.keyPointsGroup}>
                        <Text variant="labelMedium" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 8 }}>
                          {isBuyer ? 'Your Position:' : "Buyer's Position:"}
                        </Text>
                        {displayAnalysis.keyPoints.buyerClaims.map((claim, index) => (
                          <View key={index} style={styles.keyPointItem}>
                            <Icon name="account" size={14} color={theme.colors.tertiary} />
                            <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}>
                              {claim}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}

                    {displayAnalysis.keyPoints.sellerClaims?.length > 0 && (
                      <View style={styles.keyPointsGroup}>
                        <Text variant="labelMedium" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 8 }}>
                          {isSeller ? 'Your Position:' : "Seller's Position:"}
                        </Text>
                        {displayAnalysis.keyPoints.sellerClaims.map((claim, index) => (
                          <View key={index} style={styles.keyPointItem}>
                            <Icon name="store" size={14} color={theme.colors.tertiary} />
                            <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}>
                              {claim}
                            </Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                )}

                {/* Suggested Resolutions */}
                {displayAnalysis.suggestedResolutions && displayAnalysis.suggestedResolutions.length > 0 && (
                  <View style={styles.suggestions}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 12 }}>
                      Suggested Resolutions:
                    </Text>
                    {displayAnalysis.suggestedResolutions.map((resolution, index) => (
                      <Surface key={index} style={[styles.suggestionCard, { backgroundColor: theme.colors.surface }]}>
                        <View style={styles.suggestionHeader}>
                          <Icon name="lightbulb-outline" size={16} color={theme.colors.tertiary} />
                          <Text variant="labelMedium" style={{ color: theme.colors.primary, marginLeft: 8 }}>
                            {resolution.type.replace(/_/g, ' ').toUpperCase()}
                          </Text>
                          <View style={styles.fairnessScore}>
                            <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                              Fairness: {resolution.fairnessScore}/10
                            </Text>
                          </View>
                        </View>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginTop: 8 }}>
                          {resolution.description}
                        </Text>
                      </Surface>
                    ))}
                  </View>
                )}

                {/* Recommended Action - personalized for the viewer */}
                {displayAnalysis.recommendedAction && (
                  <View style={[styles.recommendedAction, { backgroundColor: theme.colors.surface }]}>
                    <Icon
                      name={isModerator ? 'gavel' : 'lightbulb-on-outline'}
                      size={20}
                      color={theme.colors.primary}
                    />
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
                        {isModerator ? 'Recommended Action' : 'What You Can Do'}
                      </Text>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                        {displayAnalysis.recommendedAction}
                      </Text>
                    </View>
                  </View>
                )}

                {/* Refresh Analysis Button */}
                <Button
                  mode="text"
                  onPress={handleRequestAnalysis}
                  loading={loadingAnalysis}
                  icon="refresh"
                  style={{ alignSelf: 'flex-end', marginTop: 8 }}
                >
                  Refresh Analysis
                </Button>
              </Card.Content>
            </Card>
          ) : (
            <Card style={[styles.card, { backgroundColor: theme.colors.surfaceVariant }]}>
              <Card.Content style={styles.noAnalysisCard}>
                <Icon name="robot-outline" size={48} color={theme.colors.onSurfaceVariant} />
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
                  {ASSISTANT_NAME}'s Analysis Available
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 8 }}>
                  Ask {ASSISTANT_NAME} for insights about this dispute, including suggested resolutions
                </Text>
                {analysisError && (
                  <Text variant="bodySmall" style={{ color: theme.colors.error, marginTop: 8 }}>
                    {analysisError}
                  </Text>
                )}
                <Button
                  mode="contained"
                  onPress={handleRequestAnalysis}
                  loading={loadingAnalysis}
                  style={{ marginTop: 16 }}
                  icon="creation"
                >
                  Generate Analysis
                </Button>
              </Card.Content>
            </Card>
          )}
        </Animated.View>

        {/* Resolution */}
        {dispute.resolution && (
          <Animated.View entering={FadeInDown.delay(350).duration(400)}>
            <Card style={[styles.card, { backgroundColor: theme.colors.secondaryContainer }]}>
              <Card.Content>
                <View style={styles.resolutionHeader}>
                  <Icon name="check-decagram" size={24} color={theme.colors.secondary} />
                  <Text variant="titleMedium" style={{ color: theme.colors.onSecondaryContainer, marginLeft: 8 }}>
                    Resolution
                  </Text>
                </View>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSecondaryContainer, marginTop: 12 }}>
                  {dispute.resolution.type.replace(/_/g, ' ').charAt(0).toUpperCase() + dispute.resolution.type.replace(/_/g, ' ').slice(1)}
                </Text>
                {typeof dispute.resolution.refundAmount === 'number' ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 8 }}>
                    Refund Amount: {formatPrice(dispute.resolution.refundAmount)}
                  </Text>
                ) : null}
                {dispute.resolution.notes && (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSecondaryContainer, marginTop: 8 }}>
                    {dispute.resolution.notes}
                  </Text>
                )}
              </Card.Content>
            </Card>
          </Animated.View>
        )}

        {/* Actions */}
        {dispute.status !== 'closed' && dispute.status !== 'resolved' && (
          <Animated.View entering={FadeInDown.delay(400).duration(400)} style={styles.actions}>
            <Button
              mode="contained"
              onPress={handleOpenChat}
              style={styles.actionButton}
              icon="message-text"
            >
              Open Chat
            </Button>

            {/* Buyer Resolution Options */}
            {isBuyer && (
              <Button
                mode="outlined"
                onPress={() => setResolveDialogVisible(true)}
                style={[styles.actionButton, { marginTop: 12 }]}
                icon="check-circle-outline"
              >
                Resolve Dispute
              </Button>
            )}

            {isModerator && !assignedToCurrentModerator && (
              <Button
                mode="outlined"
                onPress={() => void handleAssignToMe()}
                style={[styles.actionButton, { marginTop: 12 }]}
                icon="account-plus-outline"
                loading={assigningModerator}
                disabled={assigningModerator || resolving}
              >
                {moderatorName ? 'Take Over Review' : 'Assign to Me'}
              </Button>
            )}

            {isModerator && (
              <Button
                mode="contained-tonal"
                onPress={() => setModerationDialogVisible(true)}
                style={[styles.actionButton, { marginTop: 12 }]}
                icon="gavel"
                disabled={assigningModerator || resolving}
              >
                Resolve as Reviewer-Approver
              </Button>
            )}
          </Animated.View>
        )}

        {isModerator && dispute.status === 'resolved' && (
          <Animated.View entering={FadeInDown.delay(425).duration(400)} style={styles.actions}>
            <Button
              mode="outlined"
              onPress={() => void handleCloseCase()}
              style={styles.actionButton}
              icon="archive-outline"
              loading={closingCase}
              disabled={closingCase}
            >
              Close Case
            </Button>
          </Animated.View>
        )}
      </ScrollView>

      {/* Resolve Dispute Dialog */}
      <Portal>
        <Dialog visible={resolveDialogVisible} onDismiss={() => setResolveDialogVisible(false)}>
          <Dialog.Title>Resolve Dispute</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 16 }}>
              If you've reached an agreement with the seller, you can resolve this dispute:
            </Text>

            <Pressable
              onPress={() => handleResolveDispute('received_item')}
              disabled={resolving}
              style={({ pressed }) => [
                styles.resolveOption,
                { backgroundColor: theme.colors.surfaceVariant, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Icon name="package-variant-closed-check" size={24} color={theme.colors.secondary} />
              <View style={styles.resolveOptionText}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                  I Received the Item
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  The item was eventually delivered
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => handleResolveDispute('issue_resolved')}
              disabled={resolving}
              style={({ pressed }) => [
                styles.resolveOption,
                { backgroundColor: theme.colors.surfaceVariant, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Icon name="handshake" size={24} color={theme.colors.primary} />
              <View style={styles.resolveOptionText}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                  Seller Resolved the Issue
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  The seller fixed the problem
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => handleResolveDispute('agreed_refund')}
              disabled={resolving}
              style={({ pressed }) => [
                styles.resolveOption,
                { backgroundColor: theme.colors.surfaceVariant, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Icon name="cash-refund" size={24} color={theme.colors.tertiary} />
              <View style={styles.resolveOptionText}>
                <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                  Agreed on Refund
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                  Seller agreed to refund (support will process)
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => handleResolveDispute('withdraw')}
              disabled={resolving}
              style={({ pressed }) => [
                styles.resolveOption,
                { backgroundColor: theme.colors.errorContainer, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <Icon name="close-circle-outline" size={24} color={theme.colors.error} />
              <View style={styles.resolveOptionText}>
                <Text variant="titleSmall" style={{ color: theme.colors.onErrorContainer }}>
                  Withdraw Dispute
                </Text>
                <Text variant="bodySmall" style={{ color: theme.colors.onErrorContainer }}>
                  Cancel complaint and release funds to seller
                </Text>
              </View>
            </Pressable>

            {resolving && (
              <View style={styles.resolvingOverlay}>
                <ActivityIndicator size="large" />
              </View>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setResolveDialogVisible(false)} disabled={resolving}>
              Cancel
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog
          visible={moderationDialogVisible}
          onDismiss={() => {
            if (!resolving) {
              setModerationDialogVisible(false);
            }
          }}
        >
          <Dialog.Title>Reviewer-Approver Resolution</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
              Resolve this dispute using a supported escrow outcome.
            </Text>

            <View style={styles.moderationChips}>
              <Chip
                selected={moderationOutcome === 'no_refund'}
                onPress={() => setModerationOutcome('no_refund')}
              >
                No Refund
              </Chip>
              <Chip
                selected={moderationOutcome === 'partial_refund'}
                onPress={() => setModerationOutcome('partial_refund')}
              >
                Partial Refund
              </Chip>
              <Chip
                selected={moderationOutcome === 'full_refund'}
                onPress={() => setModerationOutcome('full_refund')}
              >
                Full Refund
              </Chip>
            </View>

            {moderationOutcome === 'partial_refund' ? (
              <TextInput
                mode="outlined"
                label={`Refund Amount (max ${formatPrice(moderationLimit)})`}
                value={partialRefundAmount}
                onChangeText={setPartialRefundAmount}
                keyboardType="decimal-pad"
                style={styles.moderationInput}
              />
            ) : null}

            <TextInput
              mode="outlined"
              label="Resolution Notes"
              value={moderationNotes}
              onChangeText={setModerationNotes}
              multiline
              numberOfLines={4}
              style={styles.moderationInput}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              onPress={() => setModerationDialogVisible(false)}
              disabled={resolving}
            >
              Cancel
            </Button>
            <Button
              onPress={() => void handleSubmitModeration()}
              loading={resolving}
              disabled={resolving}
            >
              Submit
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    marginBottom: 16,
    borderRadius: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  categoryChip: {
    alignSelf: 'flex-start',
  },
  orderInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  moderatorChip: {
    alignSelf: 'flex-start',
    marginTop: 12,
  },
  partyRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  partyInfo: {
    marginLeft: 12,
    flex: 1,
  },
  divider: {
    marginVertical: 12,
  },
  evidenceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  evidenceItem: {
    width: 64,
    height: 64,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  aiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  keyPointsSection: {
    marginTop: 16,
    gap: 16,
  },
  keyPointsGroup: {
    gap: 6,
  },
  keyPointItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  suggestions: {
    marginTop: 16,
  },
  suggestionCard: {
    padding: 12,
    borderRadius: 12,
    marginBottom: 8,
  },
  suggestionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  fairnessScore: {
    marginLeft: 'auto',
  },
  recommendedAction: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 12,
    marginTop: 16,
    alignItems: 'flex-start',
  },
  noAnalysisCard: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  resolutionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  actions: {
    marginTop: 8,
  },
  actionButton: {
    borderRadius: 12,
  },
  resolveOption: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
  },
  resolveOptionText: {
    flex: 1,
    marginLeft: 12,
  },
  resolvingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 12,
  },
  moderationChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  moderationInput: {
    marginTop: 16,
  },
});
