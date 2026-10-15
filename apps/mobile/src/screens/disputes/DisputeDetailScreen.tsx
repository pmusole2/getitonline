import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useConvex, useMutation, useQuery } from 'convex/react';
import { MotiView } from 'moti';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  Avatar,
  Button,
  Card,
  Chip,
  Dialog,
  Divider,
  Portal,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../../../../convex/_generated/api';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';
import { ASSISTANT_NAME } from '../../config/assistant';
import { useAppAuth } from '../../context/AuthProvider';
import { useAiActions } from '../../hooks/useAiActions';
import { disputeFailureMessage, type DisputeAnalysisView } from '../../services/aiAdapters';
import { requestAIConsent } from '../../services/aiConsent';
import { positiveDecimalMajorAmount } from '../../services/walletOperationState';
import { formatPrice } from '../../theme';
import type { DisputeCategory, DisputeStatus, Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'DisputeDetail'>;
type ModeratorResolution = 'full_refund' | 'partial_refund' | 'no_refund';

const PERSONAL_SCOPE = 'Shown only to you. It is not saved.';
const SAVED_SCOPE = 'Saved for all participants of this dispute.';

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

export default function DisputeDetailScreen(props: Props) {
  const access = useAccountAccess();
  if (access.status !== 'ready') {
    return <AccountAccessNotice access={access} title="Dispute Details" />;
  }
  return <DisputeDetailContent {...props} />;
}

function DisputeDetailContent({ route, navigation }: Props) {
  const theme = useTheme();
  const { disputeId } = route.params;
  const { user, clerkUser } = useAppAuth();
  const convex = useConvex();

  const ai = useAiActions();
  const [aiAnalysis, setAiAnalysis] = useState<DisputeAnalysisView | null>(null);
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
  const [outcomeMessage, setOutcomeMessage] = useState<string | null>(null);

  const dispute = useQuery(api.disputes.getDispute, { disputeId: disputeId as Id<'disputes'> });
  const buyerResolveDispute = useMutation(api.disputes.buyerResolveDispute);
  const assignModerator = useMutation(api.disputes.assignModerator);
  const resolveDisputeMutation = useMutation(api.disputes.resolveDispute);
  const updateDisputeStatus = useMutation(api.disputes.updateDisputeStatus);

  const identity = JSON.stringify([
    clerkUser?.id,
    user?.clerkId,
    user?._id,
    user?.role,
    disputeId,
    dispute?._id,
    dispute?.orderId,
    dispute?.escrowId,
    dispute?.buyerId,
    dispute?.sellerId,
  ]);
  const decision = JSON.stringify([dispute?.resolution, dispute?.moderatorId]);
  const draft = JSON.stringify([
    moderationOutcome,
    moderationNotes,
    partialRefundAmount,
    resolveDialogVisible,
    moderationDialogVisible,
  ]);
  const facts = JSON.stringify([identity, dispute?.status, decision, draft]);
  const committed = useRef({ identity, facts, convex, generation: 0, mounted: false });
  const workEpoch = useRef(0);
  const pendingConfirmation = useRef<object | null>(null);
  const active = useRef<{
    kind: 'buyer' | 'reviewer' | 'assign' | 'close';
    status: string;
    decision: string;
    draft: string;
    expectedStatus: string;
    expectedObserved: boolean;
    expectedResolution?: 'mutual_agreement' | ModeratorResolution;
  } | null>(null);

  useLayoutEffect(() => {
    committed.current.mounted = true;

    return () => {
      committed.current.mounted = false;
      committed.current.generation += 1;
      workEpoch.current += 1;
      active.current = null;
      pendingConfirmation.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const previous = committed.current;
    const identityChanged = previous.identity !== identity || previous.convex !== convex;
    const work = active.current;
    const expectedDecision =
      work &&
      !work.expectedObserved &&
      dispute?.status === work.expectedStatus &&
      (work.kind === 'assign'
        ? dispute.moderatorId === user?._id && !dispute.resolution
        : work.expectedResolution !== undefined &&
          dispute.resolution?.type === work.expectedResolution &&
          dispute.resolution.resolvedBy === user?._id);
    const incompatible =
      work &&
      (identityChanged ||
        !dispute ||
        work.draft !== draft ||
        (work.status !== dispute.status && work.expectedStatus !== dispute.status) ||
        (work.decision !== decision && !expectedDecision));

    if (identityChanged || incompatible) {
      active.current = null;
      pendingConfirmation.current = null;
      workEpoch.current += 1;
      setResolving(false);
      setAssigningModerator(false);
      setClosingCase(false);
      setOutcomeMessage(null);
      setResolveDialogVisible(false);
      setModerationDialogVisible(false);
      if (identityChanged) {
        setModerationNotes('');
        setPartialRefundAmount('');
        setModerationOutcome('no_refund');
      }
    } else if (work && dispute) {
      // An owned atomic resolution may be observed before the mutation reply. A later reversal still retires work.
      if (dispute.status === work.expectedStatus && (work.kind !== 'assign' || expectedDecision)) {
        work.expectedObserved = true;
      }
      work.status = dispute.status;
      work.decision = decision;
    }

    committed.current = {
      identity,
      facts,
      convex,
      mounted: true,
      generation: previous.generation + (previous.facts !== facts || previous.convex !== convex ? 1 : 0),
    };
  }, [identity, facts, convex, dispute, decision, draft, user?._id]);

  const generation =
    committed.current.generation + (committed.current.facts !== facts || committed.current.convex !== convex ? 1 : 0);
  const epoch = workEpoch.current;
  const isCapturedCurrent = (): boolean =>
    committed.current.mounted && committed.current.generation === generation && workEpoch.current === epoch;
  const start = (
    kind: NonNullable<typeof active.current>['kind'],
    expectedStatus: string,
    expectedResolution?: NonNullable<typeof active.current>['expectedResolution'],
    allowed = isCapturedCurrent(),
  ): NonNullable<typeof active.current> | null => {
    if (!allowed || active.current || !user || !dispute || dispute._id !== disputeId) {
      return null;
    }

    const work = {
      kind,
      status: dispute.status,
      decision,
      draft,
      expectedStatus,
      expectedObserved: false,
      expectedResolution,
    };
    active.current = work;
    workEpoch.current += 1;
    setOutcomeMessage(null);
    if (kind === 'assign') {
      setAssigningModerator(true);
    } else if (kind === 'close') {
      setClosingCase(true);
    } else {
      setResolving(true);
    }

    return work;
  };
  const isOwned = (work: NonNullable<typeof active.current>): boolean =>
    committed.current.mounted && active.current === work;
  const finish = (work: NonNullable<typeof active.current>): void => {
    if (!isOwned(work)) {
      return;
    }
    active.current = null;
    if (work.kind === 'assign') {
      setAssigningModerator(false);
    } else if (work.kind === 'close') {
      setClosingCase(false);
    } else {
      setResolving(false);
    }
  };
  const changeControl = (change: () => void): void => {
    if (isCapturedCurrent() && !active.current) {
      pendingConfirmation.current = null;
      setOutcomeMessage(null);
      change();
    }
  };
  const reportReview = (): void => {
    const message = 'Accounting needs review. The resolution and money movement are not confirmed.';
    setOutcomeMessage(message);
    Alert.alert('Accounting review pending', message);
  };
  const matchesDispute = (
    result:
      | FunctionReturnType<typeof api.disputes.buyerResolveDispute>
      | FunctionReturnType<typeof api.disputes.resolveDispute>,
  ): boolean =>
    Boolean(
      result &&
      dispute &&
      result._id === dispute._id &&
      result.orderId === dispute.orderId &&
      result.escrowId === dispute.escrowId &&
      result.buyerId === dispute.buyerId &&
      result.sellerId === dispute.sellerId,
    );

  // A result from another account is discarded by the AI layer. This clears what the previous account was shown.
  useEffect(() => {
    setAiAnalysis(null);
    setAnalysisError(null);
    setLoadingAnalysis(false);
  }, [ai.subject]);

  const handleOpenChat = (): void => {
    if (!isCapturedCurrent()) {
      return;
    }
    navigation.navigate('Chat', { disputeId });
  };

  const handleResolveDispute = async (
    resolutionType: 'withdraw' | 'received_item' | 'issue_resolved' | 'agreed_refund',
  ) => {
    if (
      !isCapturedCurrent() ||
      active.current ||
      !user ||
      !dispute ||
      user._id !== dispute.buyerId ||
      !resolveDialogVisible ||
      !['open', 'in_discussion', 'moderator_review'].includes(dispute.status) ||
      dispute.resolution
    ) {
      return;
    }

    const confirmMessages: Record<string, string> = {
      withdraw: 'Withdraw this dispute and request release to the seller? Accounting may require review.',
      received_item: 'Confirm receipt and request release to the seller? Accounting may require review.',
      issue_resolved: 'Confirm the issue is resolved and request release to the seller? Accounting may require review.',
      agreed_refund:
        'Confirm your refund agreement? Support must process it before any refund is credited to the marketplace wallet.',
    };
    const confirmation = {};
    pendingConfirmation.current = confirmation;
    const confirmationCurrent = (): boolean => isCapturedCurrent() && pendingConfirmation.current === confirmation;

    Alert.alert('Resolve Dispute', confirmMessages[resolutionType], [
      {
        text: 'Cancel',
        style: 'cancel',
        onPress: () => {
          if (confirmationCurrent()) pendingConfirmation.current = null;
        },
      },
      {
        text: 'Confirm',
        style: resolutionType === 'withdraw' ? 'destructive' : 'default',
        onPress: async (): Promise<void> => {
          const work = start(
            'buyer',
            resolutionType === 'agreed_refund' ? 'in_discussion' : 'resolved',
            resolutionType === 'agreed_refund' ? undefined : 'mutual_agreement',
            confirmationCurrent(),
          );
          if (!work) {
            return;
          }
          pendingConfirmation.current = null;

          try {
            const result = await buyerResolveDispute({ disputeId: disputeId as Id<'disputes'>, resolutionType });
            if (!isOwned(work)) {
              return;
            }
            if (result && 'accountingOutcome' in result && result.accountingOutcome === 'review') {
              reportReview();
            } else if (matchesDispute(result) && result) {
              if (
                resolutionType === 'agreed_refund' &&
                !('accountingOutcome' in result) &&
                result.status === 'in_discussion' &&
                !result.resolution
              ) {
                setResolveDialogVisible(false);
                Alert.alert(
                  'Refund agreement pending processing',
                  'Support must process the agreement. No refund is confirmed yet.',
                );
              } else if (
                resolutionType !== 'agreed_refund' &&
                'accountingOutcome' in result &&
                result.accountingOutcome === 'applied' &&
                result.status === 'resolved' &&
                result.resolution?.type === 'mutual_agreement' &&
                result.resolution.resolvedBy === user._id
              ) {
                setResolveDialogVisible(false);
                Alert.alert('Success', 'Dispute has been resolved. Payment released to the seller.');
              } else {
                throw new Error('Dispute resolution was not confirmed. Please check the dispute or contact support.');
              }
            } else {
              throw new Error('Dispute resolution was not confirmed. Please check the dispute or contact support.');
            }
          } catch (error: unknown) {
            if (isOwned(work)) {
              const message = error instanceof Error ? error.message : 'Failed to resolve dispute';
              setOutcomeMessage(message);
              Alert.alert('Error', message);
            }
          } finally {
            finish(work);
          }
        },
      },
    ]);
  };

  const handleRequestAnalysis = async () => {
    if (!user) return;

    setLoadingAnalysis(true);
    setAnalysisError(null);

    try {
      const hasConsent = await requestAIConsent();
      if (!ai.isCurrent()) return;
      if (!hasConsent) {
        setAnalysisError(`${ASSISTANT_NAME} is off until you allow AI features.`);
        return;
      }

      // The backend reads the dispute and the viewer's role. Only the dispute id is sent.
      const analysis = await ai.analyzeDispute({ disputeId });
      if (!ai.isCurrent()) return;
      setAiAnalysis(analysis);
    } catch (error: unknown) {
      if (ai.isCurrent()) setAnalysisError(disputeFailureMessage(error));
    } finally {
      if (ai.isCurrent()) setLoadingAnalysis(false);
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
  const moderatorName = dispute.moderator ? `${dispute.moderator.firstName} ${dispute.moderator.lastName}` : null;
  const assignedToCurrentModerator = dispute.moderator?._id === user?._id;
  const moderationLimit = dispute.escrow?.grossAmount ?? dispute.escrow?.amount ?? dispute.order?.totalAmount ?? 0;

  const handleAssignToMe = async () => {
    if (!user || !isModerator || !['open', 'in_discussion', 'moderator_review'].includes(dispute.status)) {
      return;
    }
    const work = start('assign', 'moderator_review');
    if (!work) return;

    try {
      await assignModerator({
        disputeId: disputeId as Id<'disputes'>,
        moderatorId: user._id,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to assign Reviewer-Approver';
      if (isOwned(work)) Alert.alert('Error', message);
    } finally {
      finish(work);
    }
  };

  const handleSubmitModeration = async (): Promise<void> => {
    if (
      !isCapturedCurrent() ||
      active.current ||
      !moderationDialogVisible ||
      !['open', 'in_discussion', 'moderator_review'].includes(dispute.status) ||
      dispute.resolution ||
      !user ||
      !isModerator
    ) {
      return;
    }

    const trimmedNotes = moderationNotes.trim();

    if (!trimmedNotes) {
      Alert.alert('Add notes', 'Provide resolution notes before submitting.');
      return;
    }

    const parsedRefund =
      moderationOutcome === 'partial_refund'
        ? (positiveDecimalMajorAmount(partialRefundAmount) ?? undefined)
        : undefined;

    if (moderationOutcome === 'partial_refund' && (parsedRefund === undefined || parsedRefund > moderationLimit)) {
      Alert.alert(
        'Invalid refund amount',
        `Enter a positive partial refund with at most two decimal places, up to ${formatPrice(moderationLimit)}.`,
      );
      return;
    }

    const work = start('reviewer', 'resolved', moderationOutcome);
    if (!work) {
      return;
    }

    try {
      const result = await resolveDisputeMutation({
        disputeId: disputeId as Id<'disputes'>,
        resolutionType: moderationOutcome,
        refundAmount: moderationOutcome === 'partial_refund' ? parsedRefund : undefined,
        notes: trimmedNotes,
      });
      if (!isOwned(work)) {
        return;
      }
      if (result?.accountingOutcome === 'review') {
        reportReview();
      } else if (
        matchesDispute(result) &&
        result?.accountingOutcome === 'applied' &&
        result.status === 'resolved' &&
        result.resolution?.type === moderationOutcome &&
        result.resolution.resolvedBy === user._id
      ) {
        setModerationDialogVisible(false);
        setModerationNotes('');
        setPartialRefundAmount('');
        setModerationOutcome('no_refund');
        Alert.alert(
          'Dispute resolved',
          moderationOutcome === 'no_refund'
            ? 'The resolution was applied. Payment released to the seller.'
            : 'The resolution was applied. The approved refund was credited to the buyer marketplace wallet.',
        );
      } else {
        throw new Error('Dispute resolution was not confirmed. Please check the dispute or contact support.');
      }
    } catch (error: unknown) {
      if (isOwned(work)) {
        const message = error instanceof Error ? error.message : 'Failed to resolve dispute';
        setOutcomeMessage(message);
        Alert.alert('Error', message);
      }
    } finally {
      finish(work);
    }
  };

  const handleCloseCase = async (): Promise<void> => {
    if (!user || !isModerator || dispute.status !== 'resolved') {
      return;
    }

    const work = start('close', 'closed');
    if (!work) return;

    try {
      await updateDisputeStatus({
        disputeId: disputeId as Id<'disputes'>,
        status: 'closed',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to close dispute';
      if (isOwned(work)) Alert.alert('Error', message);
    } finally {
      finish(work);
    }
  };

  // The saved reviewer summary and suggestions, shown when no analysis has been generated on this screen. It has no
  // claims, sentiment, or risk level, so none is shown for it.
  const storedAnalysis = dispute.aiSummary
    ? { summary: dispute.aiSummary, suggestions: dispute.aiSuggestions ?? [] }
    : null;
  const hasAnalysis = aiAnalysis !== null || storedAnalysis !== null;
  const analysisScope = aiAnalysis?.viewer === 'participant' ? PERSONAL_SCOPE : SAVED_SCOPE;

  // The sentiment shown on a party's row. A participant sees only their own side and the other party's sentiment.
  const sentimentFor = (party: 'buyer' | 'seller'): string | null => {
    if (aiAnalysis === null) return null;
    if (aiAnalysis.viewer === 'reviewer') {
      return party === 'buyer' ? aiAnalysis.buyerSentiment : aiAnalysis.sellerSentiment;
    }
    return aiAnalysis.side === party ? aiAnalysis.yourSentiment : aiAnalysis.theirSentiment;
  };
  const buyerSentiment = sentimentFor('buyer');
  const sellerSentiment = sentimentFor('seller');

  const renderClaims = (label: string, icon: string, claims: string[]) => (
    <View style={styles.keyPointsGroup}>
      <Text variant="labelMedium" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 8 }}>
        {label}
      </Text>
      {claims.map((claim, index) => (
        <View key={index} style={styles.keyPointItem}>
          <Icon name={icon} size={14} color={theme.colors.tertiary} />
          <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}>
            {claim}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title="Dispute Details" onBackPress={() => navigation.goBack()} showAIIndicator={hasAnalysis} />

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
                  <Text
                    variant="bodySmall"
                    style={{
                      color: isBuyer ? theme.colors.primary : theme.colors.onSurfaceVariant,
                      fontWeight: isBuyer ? '600' : '400',
                    }}
                  >
                    {isBuyer ? 'You (Buyer)' : 'Buyer'}
                  </Text>
                </View>
                {buyerSentiment !== null && (
                  <Icon name={getSentimentIcon(buyerSentiment)} size={24} color={theme.colors.onSurfaceVariant} />
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
                  <Text
                    variant="bodySmall"
                    style={{
                      color: isSeller ? theme.colors.primary : theme.colors.onSurfaceVariant,
                      fontWeight: isSeller ? '600' : '400',
                    }}
                  >
                    {isSeller ? 'You (Seller)' : 'Seller'}
                  </Text>
                </View>
                {sellerSentiment !== null && (
                  <Icon name={getSentimentIcon(sellerSentiment)} size={24} color={theme.colors.onSurfaceVariant} />
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
          {hasAnalysis ? (
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
                  <Text
                    variant="titleMedium"
                    style={{ color: theme.colors.onTertiaryContainer, marginLeft: 8, flex: 1 }}
                  >
                    {ASSISTANT_NAME}'s Analysis
                  </Text>
                  {aiAnalysis !== null && (
                    <Chip
                      compact
                      style={{ backgroundColor: getRiskColor(aiAnalysis.riskLevel) + '30' }}
                      textStyle={{ color: getRiskColor(aiAnalysis.riskLevel), fontSize: 12 }}
                    >
                      {aiAnalysis.riskLevel.toUpperCase()} RISK
                    </Chip>
                  )}
                </View>

                <Text variant="bodyMedium" style={{ color: theme.colors.onTertiaryContainer, marginTop: 12 }}>
                  {aiAnalysis?.summary ?? storedAnalysis?.summary}
                </Text>

                <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginTop: 8 }}>
                  {analysisScope}
                </Text>

                {/* A participant sees their own claims and the other party's, in their own columns */}
                {aiAnalysis?.viewer === 'participant' && (
                  <View style={styles.keyPointsSection}>
                    {aiAnalysis.yourClaims.length > 0 &&
                      renderClaims('Your Position:', 'account-check', aiAnalysis.yourClaims)}
                    {aiAnalysis.theirClaims.length > 0 &&
                      (aiAnalysis.side === 'buyer'
                        ? renderClaims("Seller's Position:", 'store', aiAnalysis.theirClaims)
                        : renderClaims("Buyer's Position:", 'account', aiAnalysis.theirClaims))}
                  </View>
                )}

                {/* A reviewer sees the buyer's claims in the buyer column and the seller's in the seller column */}
                {aiAnalysis?.viewer === 'reviewer' && (
                  <View style={styles.keyPointsSection}>
                    {aiAnalysis.buyerClaims.length > 0 &&
                      renderClaims("Buyer's Position:", 'account', aiAnalysis.buyerClaims)}
                    {aiAnalysis.sellerClaims.length > 0 &&
                      renderClaims("Seller's Position:", 'store', aiAnalysis.sellerClaims)}
                  </View>
                )}

                {aiAnalysis !== null && aiAnalysis.suggestedResolutions.length > 0 && (
                  <View style={styles.suggestions}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 12 }}>
                      Suggested Resolutions:
                    </Text>
                    {aiAnalysis.suggestedResolutions.map((resolution, index) => (
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

                {aiAnalysis === null && storedAnalysis !== null && storedAnalysis.suggestions.length > 0 && (
                  <View style={styles.suggestions}>
                    <Text variant="titleSmall" style={{ color: theme.colors.onTertiaryContainer, marginBottom: 12 }}>
                      Suggested Resolutions:
                    </Text>
                    {storedAnalysis.suggestions.map((suggestion, index) => (
                      <Surface key={index} style={[styles.suggestionCard, { backgroundColor: theme.colors.surface }]}>
                        <Text variant="bodySmall" style={{ color: theme.colors.onSurface }}>
                          {suggestion}
                        </Text>
                      </Surface>
                    ))}
                  </View>
                )}

                {/* Recommended Action - personalized for the viewer */}
                {aiAnalysis !== null && aiAnalysis.recommendedAction !== '' && (
                  <View style={[styles.recommendedAction, { backgroundColor: theme.colors.surface }]}>
                    <Icon
                      name={aiAnalysis.viewer === 'reviewer' ? 'gavel' : 'lightbulb-on-outline'}
                      size={20}
                      color={theme.colors.primary}
                    />
                    <View style={{ marginLeft: 12, flex: 1 }}>
                      <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
                        {aiAnalysis.viewer === 'reviewer' ? 'Recommended Action' : 'What You Can Do'}
                      </Text>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                        {aiAnalysis.recommendedAction}
                      </Text>
                    </View>
                  </View>
                )}

                {analysisError && (
                  <Text variant="bodySmall" style={{ color: theme.colors.error, marginTop: 8 }}>
                    {analysisError}
                  </Text>
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
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 8 }}
                >
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
                  {dispute.resolution.type.replace(/_/g, ' ').charAt(0).toUpperCase() +
                    dispute.resolution.type.replace(/_/g, ' ').slice(1)}
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
            <Button mode="contained" onPress={handleOpenChat} style={styles.actionButton} icon="message-text">
              Open Chat
            </Button>

            {/* Buyer Resolution Options */}
            {isBuyer && (
              <Button
                mode="outlined"
                onPress={() => changeControl(() => setResolveDialogVisible(true))}
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
                onPress={() => changeControl(() => setModerationDialogVisible(true))}
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
        <Dialog visible={resolveDialogVisible} onDismiss={() => changeControl(() => setResolveDialogVisible(false))}>
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
          {outcomeMessage && <Text accessibilityRole="alert">{outcomeMessage}</Text>}
          <Dialog.Actions>
            <Button onPress={() => changeControl(() => setResolveDialogVisible(false))} disabled={resolving}>
              Cancel
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog
          visible={moderationDialogVisible}
          onDismiss={() => {
            if (!resolving) {
              changeControl(() => setModerationDialogVisible(false));
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
                disabled={resolving}
                onPress={() => changeControl(() => setModerationOutcome('no_refund'))}
              >
                No Refund
              </Chip>
              <Chip
                selected={moderationOutcome === 'partial_refund'}
                disabled={resolving}
                onPress={() => changeControl(() => setModerationOutcome('partial_refund'))}
              >
                Partial Refund
              </Chip>
              <Chip
                selected={moderationOutcome === 'full_refund'}
                disabled={resolving}
                onPress={() => changeControl(() => setModerationOutcome('full_refund'))}
              >
                Full Refund
              </Chip>
            </View>

            {moderationOutcome === 'partial_refund' ? (
              <TextInput
                mode="outlined"
                label={`Refund Amount (max ${formatPrice(moderationLimit)})`}
                value={partialRefundAmount}
                disabled={resolving}
                onChangeText={(value) => changeControl(() => setPartialRefundAmount(value))}
                keyboardType="decimal-pad"
                style={styles.moderationInput}
              />
            ) : null}

            <TextInput
              mode="outlined"
              label="Resolution Notes"
              value={moderationNotes}
              disabled={resolving}
              onChangeText={(value) => changeControl(() => setModerationNotes(value))}
              multiline
              numberOfLines={4}
              style={styles.moderationInput}
            />
          </Dialog.Content>
          {outcomeMessage && <Text accessibilityRole="alert">{outcomeMessage}</Text>}
          <Dialog.Actions>
            <Button onPress={() => changeControl(() => setModerationDialogVisible(false))} disabled={resolving}>
              Cancel
            </Button>
            <Button onPress={() => void handleSubmitModeration()} loading={resolving} disabled={resolving}>
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
