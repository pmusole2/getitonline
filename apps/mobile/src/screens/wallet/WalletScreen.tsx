import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { MotiView } from 'moti';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import {
  Button,
  Chip,
  Divider,
  Modal,
  Portal,
  SegmentedButtons,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { resolvedWalletAccount, walletAmountCents, type PaymentAccount } from '../../services/walletOperationState';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { usePaymentAvailability } from '../../hooks/usePaymentAvailability';
import { useWallet } from '../../hooks/useWallet';
import {
  formatWalletAmount,
  getTransactionColor,
  getTransactionIcon,
  getTransactionSourceLabel,
  MobileMoneyProvider,
} from '../../services/wallet';
import type { RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Wallet'>;

export default function WalletScreen({ navigation }: Props) {
  const wallet = useWallet();
  const auth = useAppAuth();
  if (wallet.operations.access !== 'ready') {
    return (
      <AccountAccessNotice
        title="Wallet"
        access={{
          status: wallet.operations.access,
          signIn: () => navigation.navigate('Auth'),
          retry: auth.retryUserSync,
          signOut: auth.signOut,
          goBack: () => navigation.goBack(),
        }}
      />
    );
  }
  return <WalletContent key={wallet.operations.sessionKey} navigation={navigation} wallet={wallet} />;
}

function WalletContent({
  navigation,
  wallet,
}: {
  navigation: Props['navigation'];
  wallet: ReturnType<typeof useWallet>;
}) {
  const theme = useTheme();
  const {
    balance,
    activity,
    transactions,
    isLoading,
    error,
    refreshBalance,
    refreshActivity,
    refreshTransactions,
    withdrawToMobileMoney,
    withdrawToBank,
    topUp,
    ensureWallet,
    clearError,
    operations,
  } = wallet;
  const paymentsAvailable = usePaymentAvailability() === 'available';
  // Mirrors the committed render, so a submit captured before availability turned off reads the current value when it
  // runs. It is written in a layout effect, not during render, so a render that React abandons cannot open a submit.
  const paymentsAvailableRef = useRef(paymentsAvailable);
  useLayoutEffect(() => {
    paymentsAvailableRef.current = paymentsAvailable;
  }, [paymentsAvailable]);

  const [refreshing, setRefreshing] = useState(false);
  const [withdrawModalVisible, setWithdrawModalVisible] = useState(false);
  const [topUpModalVisible, setTopUpModalVisible] = useState(false);
  const [withdrawMethod, setWithdrawMethod] = useState<'mobile_money' | 'bank'>('mobile_money');
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [provider, setProvider] = useState<MobileMoneyProvider>('mtn');
  const [bankId, setBankId] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [approval, setApproval] = useState<{ account: PaymentAccount; cents: number; revision: number } | null>(null);
  const mounted = useRef(false);
  const formRevision = useRef(0);
  const submitting = useRef(false);
  const processing = operations.working;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = () => mounted.current && operations.isCurrent();
  const edit = (change: () => void) => {
    if (!current() || draftRevision !== formRevision.current) return;
    formRevision.current += 1;
    operations.cancelDraft();
    setApproval(null);
    change();
  };
  const dismiss = (close: () => void) => {
    edit(close);
  };
  const draftRevision = formRevision.current;
  const approved =
    approval !== null &&
    approval.cents === walletAmountCents(amount) &&
    approval.revision === operations.approvalRevision &&
    operations.accounts.some(
      (account) =>
        account.accountId === approval.account.accountId &&
        account.destinationKey === approval.account.destinationKey &&
        resolvedWalletAccount(account),
    );
  const committedForm = useRef({ approved, approval, draftRevision });
  useLayoutEffect(() => {
    committedForm.current = { approved, approval, draftRevision };
  });

  useEffect(() => {
    // Ensure wallet exists when screen loads
    ensureWallet();
  }, [ensureWallet]);

  const displayedError = useRef({ error, revision: 0 });
  useLayoutEffect(() => {
    if (displayedError.current.error !== error) {
      displayedError.current = { error, revision: displayedError.current.revision + 1 };
    }
  }, [error]);

  useEffect(() => {
    const errorRevision = displayedError.current.revision;
    if (error && current()) {
      Alert.alert('Error', error, [
        {
          text: 'OK',
          onPress: () => {
            if (
              current() &&
              displayedError.current.error === error &&
              displayedError.current.revision === errorRevision
            )
              clearError();
          },
        },
      ]);
    }
  }, [error, clearError]);

  const handleRefresh = async () => {
    if (!current()) return;
    setRefreshing(true);
    await Promise.all([refreshBalance(), refreshActivity(), refreshTransactions()]);
    if (current()) setRefreshing(false);
  };

  const handleWithdraw = async () => {
    if (
      !current() ||
      draftRevision !== formRevision.current ||
      !paymentsAvailableRef.current ||
      !committedForm.current.approved ||
      committedForm.current.approval !== approval ||
      !approval ||
      submitting.current
    )
      return;
    submitting.current = true;
    try {
      const send = approval.account.type === 'mobile_money' ? withdrawToMobileMoney : withdrawToBank;
      await send(amount, approval.account.accountId, approval.account.destinationKey);
    } finally {
      if (current()) submitting.current = false;
    }
  };

  const handleTopUp = async () => {
    if (!current() || draftRevision !== formRevision.current || !paymentsAvailableRef.current || submitting.current)
      return;
    submitting.current = true;
    try {
      await topUp(amount, phone, provider);
    } finally {
      if (current()) submitting.current = false;
    }
  };

  const resolveDestination = async () => {
    if (!current() || draftRevision !== formRevision.current || submitting.current) return;
    setApproval(null);
    await operations.registerDestination(
      withdrawMethod === 'mobile_money'
        ? { type: 'mobile_money', phone, operator: provider }
        : { type: 'bank_account', bankId, accountNumber },
    );
  };

  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    if (operations.outcome !== 'completed' || !operations.recovery || !operations.isCurrent()) return;
    if (refreshed.current === operations.recovery.requestId) return;
    refreshed.current = operations.recovery.requestId;
    void Promise.all([refreshBalance(), refreshActivity(), refreshTransactions()]);
  }, [
    operations.outcome,
    operations.recovery,
    operations.isCurrent,
    refreshBalance,
    refreshActivity,
    refreshTransactions,
  ]);

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-ZM', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader title="Wallet" onBackPress={() => navigation.goBack()} variant="gradient" />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        {/* Balance Card */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <LinearGradient
            colors={[theme.colors.primary, theme.colors.tertiary]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.balanceCard}
          >
            <View style={styles.balanceHeader}>
              <Text variant="titleMedium" style={styles.balanceLabel}>
                Available Balance
              </Text>
              {balance?.isFrozen && (
                <Chip
                  compact
                  icon="lock"
                  style={{ backgroundColor: 'rgba(255,255,255,0.2)' }}
                  textStyle={{ color: '#fff' }}
                >
                  Frozen
                </Chip>
              )}
            </View>

            <MotiView
              from={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{
                scale: { type: 'spring', damping: 15 },
                opacity: { type: 'timing', duration: 300 },
              }}
            >
              <Text variant="displayLarge" style={styles.balanceAmount}>
                {balance ? formatWalletAmount(balance.balance) : 'K0.00'}
              </Text>
            </MotiView>

            {balance && balance.pendingBalance > 0 && (
              <Text variant="bodySmall" style={styles.pendingBalance}>
                + {formatWalletAmount(balance.pendingBalance)} pending
              </Text>
            )}

            {/* Action Buttons */}
            <View style={styles.balanceActions}>
              <Pressable
                style={[styles.actionButton, { backgroundColor: 'rgba(255,255,255,0.2)' }]}
                onPress={() => {
                  if (current() && paymentsAvailableRef.current) setTopUpModalVisible(true);
                }}
                disabled={!paymentsAvailable || !operations.ready || !!operations.recovery}
              >
                <Icon name="plus" size={24} color="#fff" />
                <Text style={styles.actionButtonText}>Top Up</Text>
              </Pressable>

              <Pressable
                style={[styles.actionButton, { backgroundColor: 'rgba(255,255,255,0.2)' }]}
                onPress={() => {
                  if (current() && paymentsAvailableRef.current) setWithdrawModalVisible(true);
                }}
                disabled={
                  !paymentsAvailable ||
                  !operations.ready ||
                  !!operations.recovery ||
                  !balance ||
                  balance.balance <= 0 ||
                  balance.isFrozen
                }
              >
                <Icon name="bank-transfer-out" size={24} color="#fff" />
                <Text style={styles.actionButtonText}>Withdraw</Text>
              </Pressable>
            </View>

            {paymentsAvailable ? null : (
              <Text variant="bodySmall" style={{ color: 'rgba(255,255,255,0.85)', marginTop: 12 }}>
                Payments are temporarily unavailable
              </Text>
            )}
          </LinearGradient>
        </Animated.View>

        {operations.error ? <Text accessibilityRole="alert">{operations.error}</Text> : null}
        {!operations.ready ? (
          <Text>
            {operations.error
              ? 'Wallet recovery is blocked. Check storage or contact support.'
              : 'Loading wallet recovery. New payments are unavailable until recovery is checked.'}
          </Text>
        ) : null}
        {operations.recovery ? (
          <Surface style={styles.infoBox} elevation={0}>
            <View>
              <Text variant="titleMedium">Wallet request: {operations.outcome}</Text>
              <Text>
                {operations.outcome === 'completed'
                  ? 'Wallet accounting confirms this request completed.'
                  : operations.outcome === 'failed'
                    ? 'This request failed or was reversed. No funds success is being claimed.'
                    : operations.outcome === 'review'
                      ? 'This request needs support review. Do not send another payment.'
                      : 'This request is not confirmed as complete. Keep it and check status before sending another payment.'}
              </Text>
              <Text>
                Provider fee:{' '}
                {!(operations.status instanceof Error) &&
                operations.status?.result === 'found' &&
                operations.status.feeCents !== null
                  ? formatWalletAmount(operations.status.feeCents / 100)
                  : 'Unknown'}
              </Text>
              <Button onPress={operations.checkStatus} disabled={processing} loading={processing}>
                Check Status
              </Button>
              {operations.outcome === 'completed' || operations.outcome === 'failed' ? (
                <Button onPress={operations.newSubmission} disabled={processing}>
                  Start New Request
                </Button>
              ) : null}
            </View>
          </Surface>
        ) : null}

        {/* Stats Cards */}
        {activity && (
          <Animated.View entering={FadeInDown.delay(200).duration(400)}>
            <View style={styles.statsRow}>
              <Surface style={[styles.statCard, { backgroundColor: theme.colors.primaryContainer }]} elevation={0}>
                <Icon name="trending-up" size={24} color={theme.colors.primary} />
                <Text variant="titleMedium" style={{ color: theme.colors.onPrimaryContainer, fontWeight: '700' }}>
                  {formatWalletAmount(activity.thisMonthEarnings)}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
                  This Month
                </Text>
              </Surface>

              <Surface style={[styles.statCard, { backgroundColor: theme.colors.secondaryContainer }]} elevation={0}>
                <Icon name="clock-outline" size={24} color={theme.colors.secondary} />
                <Text variant="titleMedium" style={{ color: theme.colors.onSecondaryContainer, fontWeight: '700' }}>
                  {formatWalletAmount(activity.pendingWithdrawals)}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onSecondaryContainer }}>
                  Pending
                </Text>
              </Surface>

              <Surface style={[styles.statCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
                <Icon name="cash-check" size={24} color={theme.colors.tertiary} />
                <Text variant="titleMedium" style={{ color: theme.colors.onTertiaryContainer, fontWeight: '700' }}>
                  {balance ? formatWalletAmount(balance.totalEarned) : 'K0'}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onTertiaryContainer }}>
                  Total Earned
                </Text>
              </Surface>
            </View>
          </Animated.View>
        )}

        {/* Transactions */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)}>
          <View style={styles.sectionHeader}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '700' }}>
              Recent Transactions
            </Text>
            <Pressable onPress={() => navigation.navigate('WalletTransactions' as never)}>
              <Text variant="labelMedium" style={{ color: theme.colors.primary }}>
                See All
              </Text>
            </Pressable>
          </View>

          {isLoading && transactions.length === 0 ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" />
            </View>
          ) : transactions.length === 0 ? (
            <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
              <Icon name="wallet-outline" size={48} color={theme.colors.onSurfaceVariant} />
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
                No transactions yet
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
                Your wallet transactions will appear here
              </Text>
            </Surface>
          ) : (
            <Surface style={[styles.transactionsCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
              {transactions.slice(0, 10).map((tx, index) => (
                <React.Fragment key={tx._id}>
                  <Pressable style={styles.transactionItem}>
                    <View
                      style={[
                        styles.transactionIcon,
                        { backgroundColor: getTransactionColor(tx.type, tx.status) + '20' },
                      ]}
                    >
                      <Icon
                        name={getTransactionIcon(tx.type, tx.source)}
                        size={20}
                        color={getTransactionColor(tx.type, tx.status)}
                      />
                    </View>
                    <View style={styles.transactionDetails}>
                      <Text variant="bodyMedium" style={{ color: theme.colors.onSurface, fontWeight: '600' }}>
                        {getTransactionSourceLabel(tx.source)}
                      </Text>
                      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                        {formatDate(tx.createdAt)}
                      </Text>
                    </View>
                    <View style={styles.transactionAmount}>
                      <Text
                        variant="titleSmall"
                        style={{
                          color: getTransactionColor(tx.type, tx.status),
                          fontWeight: '700',
                        }}
                      >
                        {tx.type === 'credit' || tx.type === 'refund' ? '+' : '-'}
                        {formatWalletAmount(tx.amount)}
                      </Text>
                      {tx.status === 'pending' && (
                        <Chip compact style={{ marginTop: 4 }}>
                          Pending
                        </Chip>
                      )}
                    </View>
                  </Pressable>
                  {index < Math.min(transactions.length, 10) - 1 && <Divider />}
                </React.Fragment>
              ))}
            </Surface>
          )}
        </Animated.View>
      </ScrollView>

      {/* Withdraw Modal */}
      <Portal>
        <Modal
          visible={withdrawModalVisible}
          onDismiss={() => dismiss(() => setWithdrawModalVisible(false))}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginBottom: 12 }}>
            Withdraw Funds
          </Text>
          {operations.error ? <Text accessibilityRole="alert">{operations.error}</Text> : null}
          {operations.recovery ? (
            <Text>
              This request is {operations.outcome}. Close this form to check status before sending another payment.
            </Text>
          ) : null}

          <SegmentedButtons
            value={withdrawMethod}
            onValueChange={(value) => {
              if (value === 'mobile_money' || value === 'bank') edit(() => setWithdrawMethod(value));
            }}
            buttons={[
              { value: 'mobile_money', label: 'Mobile Money', icon: 'cellphone' },
              { value: 'bank', label: 'Bank Account', icon: 'bank' },
            ]}
            style={{ marginBottom: 12 }}
          />

          <TextInput
            mode="outlined"
            label="Amount (ZMW)"
            value={amount}
            onChangeText={(value) => edit(() => setAmount(value))}
            keyboardType="decimal-pad"
            left={<TextInput.Affix text="K" />}
            style={{ marginBottom: 12 }}
          />

          {withdrawMethod === 'mobile_money' ? (
            <>
              <TextInput
                mode="outlined"
                label="Phone Number"
                value={phone}
                onChangeText={(value) => edit(() => setPhone(value))}
                keyboardType="phone-pad"
                placeholder="260XXXXXXXXX"
                style={{ marginBottom: 12 }}
              />

              <Text variant="labelMedium" style={{ marginBottom: 6, color: theme.colors.onSurface }}>
                Select Provider
              </Text>
              <View style={[styles.providerRow, { marginBottom: 0 }]}>
                {(['mtn', 'airtel', 'zamtel'] as const).map((p) => (
                  <Pressable
                    key={p}
                    style={[
                      styles.providerButton,
                      {
                        backgroundColor: provider === p ? theme.colors.primary : theme.colors.surfaceVariant,
                      },
                    ]}
                    onPress={() => edit(() => setProvider(p))}
                  >
                    <Text
                      style={{
                        color: provider === p ? '#fff' : theme.colors.onSurfaceVariant,
                        fontWeight: '600',
                        textTransform: 'uppercase',
                      }}
                    >
                      {p}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              <Button onPress={operations.loadBanks} loading={processing} disabled={processing}>
                Load Banks
              </Button>
              {operations.banks.map((bank) => (
                <Button
                  key={bank.id}
                  mode={bankId === bank.id ? 'contained' : 'text'}
                  onPress={() => edit(() => setBankId(bank.id))}
                >
                  {bank.name}
                </Button>
              ))}
              <TextInput
                mode="outlined"
                label="Account Number"
                value={accountNumber}
                onChangeText={(value) => edit(() => setAccountNumber(value))}
                keyboardType="number-pad"
              />
            </>
          )}

          <Button onPress={resolveDestination} disabled={processing || !!operations.recovery} loading={processing}>
            Resolve Destination
          </Button>
          <Text>Choose a resolved destination, review the amount, then approve withdrawal.</Text>
          {operations.accountsPending ? <Text>Loading owned destinations</Text> : null}
          {operations.accountsError ? <Text>Destinations unavailable. Check your connection.</Text> : null}
          {operations.accounts.filter(resolvedWalletAccount).map((account) => (
            <Button
              key={account.accountId}
              onPress={() => {
                const cents = walletAmountCents(amount);
                if (current() && draftRevision === formRevision.current && cents !== null)
                  setApproval({ account, cents, revision: operations.approvalRevision });
              }}
            >
              Review {account.accountName ?? 'Name unavailable'}:{' '}
              {account.type === 'mobile_money'
                ? account.phone
                : `${account.bankName ?? account.bankId} ${account.accountNumber}`}
            </Button>
          ))}
          {approved && approval ? (
            <Text>
              Approved destination: {approval.account.accountName ?? 'Name unavailable'}. Amount: {amount} ZMW. Press
              Withdraw to confirm.
            </Text>
          ) : null}
          {paymentsAvailable ? null : (
            <Text variant="bodyMedium" style={{ color: theme.colors.error, marginTop: 12 }}>
              Payments are temporarily unavailable
            </Text>
          )}
          <Button
            mode="contained"
            onPress={handleWithdraw}
            loading={processing}
            disabled={processing || !paymentsAvailable || !operations.ready || !!operations.recovery || !approved}
            style={{ marginTop: withdrawMethod === 'mobile_money' ? 8 : 12 }}
          >
            Withdraw
          </Button>
        </Modal>
      </Portal>

      {/* Top Up Modal */}
      <Portal>
        <Modal
          visible={topUpModalVisible}
          onDismiss={() => dismiss(() => setTopUpModalVisible(false))}
          contentContainerStyle={[styles.modal, { backgroundColor: theme.colors.surface }]}
        >
          <Text variant="titleLarge" style={{ color: theme.colors.onSurface, marginBottom: 12 }}>
            Top Up Wallet
          </Text>
          {operations.error ? <Text accessibilityRole="alert">{operations.error}</Text> : null}
          {operations.recovery ? (
            <Text>
              This request is {operations.outcome}. Close this form to check status before sending another payment.
            </Text>
          ) : null}

          <TextInput
            mode="outlined"
            label="Amount (ZMW)"
            value={amount}
            onChangeText={(value) => edit(() => setAmount(value))}
            keyboardType="decimal-pad"
            left={<TextInput.Affix text="K" />}
            style={{ marginBottom: 12 }}
          />

          <>
            <TextInput
              mode="outlined"
              label="Phone Number"
              value={phone}
              onChangeText={(value) => edit(() => setPhone(value))}
              keyboardType="phone-pad"
              placeholder="260XXXXXXXXX"
              style={{ marginBottom: 12 }}
            />

            <Text variant="labelMedium" style={{ marginBottom: 6, color: theme.colors.onSurface }}>
              Select Provider
            </Text>
            <View style={[styles.providerRow, { marginBottom: 0 }]}>
              {(['mtn', 'airtel', 'zamtel'] as const).map((p) => (
                <Pressable
                  key={p}
                  style={[
                    styles.providerButton,
                    {
                      backgroundColor: provider === p ? theme.colors.primary : theme.colors.surfaceVariant,
                    },
                  ]}
                  onPress={() => edit(() => setProvider(p))}
                >
                  <Text
                    style={{
                      color: provider === p ? '#fff' : theme.colors.onSurfaceVariant,
                      fontWeight: '600',
                      textTransform: 'uppercase',
                    }}
                  >
                    {p}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>

          {paymentsAvailable ? null : (
            <Text variant="bodyMedium" style={{ color: theme.colors.error, marginTop: 12 }}>
              Payments are temporarily unavailable
            </Text>
          )}
          <Button
            mode="contained"
            onPress={handleTopUp}
            loading={processing}
            disabled={processing || !paymentsAvailable || !operations.ready || !!operations.recovery}
            style={{ marginTop: 8 }}
          >
            Top Up
          </Button>
        </Modal>
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
  content: {
    padding: 16,
  },
  balanceCard: {
    borderRadius: 20,
    padding: 24,
    marginBottom: 16,
  },
  balanceHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  balanceLabel: {
    color: 'rgba(255,255,255,0.8)',
  },
  balanceAmount: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 40,
  },
  pendingBalance: {
    color: 'rgba(255,255,255,0.7)',
    marginTop: 4,
  },
  balanceActions: {
    flexDirection: 'row',
    marginTop: 24,
    gap: 12,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 12,
    gap: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  statsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  statCard: {
    flex: 1,
    padding: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  transactionsCard: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  transactionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
  },
  transactionIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  transactionDetails: {
    flex: 1,
    marginLeft: 12,
  },
  transactionAmount: {
    alignItems: 'flex-end',
  },
  loadingContainer: {
    padding: 40,
    alignItems: 'center',
  },
  emptyCard: {
    padding: 32,
    borderRadius: 16,
    alignItems: 'center',
  },
  modal: {
    margin: 20,
    padding: 20,
    borderRadius: 16,
  },
  modalContent: {
    paddingBottom: 20,
  },
  providerRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  providerButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  infoBox: {
    flexDirection: 'row',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 16,
  },
});
