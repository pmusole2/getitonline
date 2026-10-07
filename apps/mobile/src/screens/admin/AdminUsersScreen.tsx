import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  Portal,
  Searchbar,
  Surface,
  Text,
  TextInput,
  useTheme,
} from 'react-native-paper';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import type { RootStackParamList, User, UserRole } from '../../types';
import { getRoleLabel } from '../../utils/roles';

type Props = NativeStackScreenProps<RootStackParamList, 'AdminUsers'>;
type RoleFilter = 'all' | UserRole;

const roleOptions: UserRole[] = ['user', 'catalog_manager', 'moderator', 'admin'];

function getRoleIcon(role: UserRole) {
  switch (role) {
    case 'catalog_manager':
      return 'store-cog-outline';
    case 'moderator':
      return 'gavel';
    case 'admin':
      return 'shield-crown-outline';
    default:
      return 'account-outline';
  }
}

export default function AdminUsersScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user } = useAppAuth();
  const isAdmin = user?.role === 'admin';

  const usersResult = useQuery(
    api.users.getAllUsers,
    user?._id && isAdmin ? { adminId: user._id, limit: 100 } : 'skip'
  );
  const platformSettings = useQuery(
    api.platform.getPlatformSettingsForAdmin,
    user?._id && isAdmin ? { adminId: user._id } : 'skip'
  );

  const updateUserRole = useMutation(api.users.updateUserRole);
  const toggleUserBan = useMutation(api.users.toggleUserBan);
  const freezeWallet = useMutation(api.wallet.freezeWallet);
  const unfreezeWallet = useMutation(api.wallet.unfreezeWallet);

  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [selectedRole, setSelectedRole] = useState<UserRole>('user');
  const [walletUser, setWalletUser] = useState<User | null>(null);
  const [walletReason, setWalletReason] = useState('');
  const [savingUserId, setSavingUserId] = useState<string | null>(null);

  const selectedWallet = useQuery(
    api.wallet.getWallet,
    user?._id && isAdmin && walletUser ? { userId: walletUser._id } : 'skip'
  );

  const users = usersResult?.items ?? [];
  const companySellerUserId = platformSettings?.companySellerUserId ?? null;

  const filteredUsers = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return [...users]
      .sort((left, right) =>
        `${left.firstName} ${left.lastName}`.localeCompare(
          `${right.firstName} ${right.lastName}`
        )
      )
      .filter((listedUser) => {
        if (roleFilter !== 'all' && listedUser.role !== roleFilter) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        return [
          listedUser.firstName,
          listedUser.lastName,
          listedUser.email,
          getRoleLabel(listedUser.role),
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      });
  }, [roleFilter, searchQuery, users]);

  const openRoleDialog = (listedUser: User) => {
    setSelectedUser(listedUser);
    setSelectedRole(listedUser.role);
  };

  const closeRoleDialog = () => {
    setSelectedUser(null);
  };

  const openWalletDialog = (listedUser: User) => {
    setWalletUser(listedUser);
    setWalletReason('');
  };

  const closeWalletDialog = () => {
    setWalletUser(null);
    setWalletReason('');
  };

  const handleSaveRole = async () => {
    if (!user || user.role !== 'admin' || !selectedUser || selectedRole === selectedUser.role) {
      closeRoleDialog();
      return;
    }

    setSavingUserId(selectedUser._id);

    try {
      await updateUserRole({
        adminId: user._id,
        targetUserId: selectedUser._id,
        newRole: selectedRole,
      });
      closeRoleDialog();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to update role';
      Alert.alert('Error', message);
    } finally {
      setSavingUserId(null);
    }
  };

  const handleBanToggle = (listedUser: User) => {
    if (!user || user.role !== 'admin') {
      return;
    }

    const nextIsBanned = !listedUser.isBanned;

    Alert.alert(
      nextIsBanned ? 'Ban User' : 'Unban User',
      nextIsBanned
        ? `Ban ${listedUser.firstName} ${listedUser.lastName}?`
        : `Restore access for ${listedUser.firstName} ${listedUser.lastName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: nextIsBanned ? 'Ban' : 'Unban',
          style: nextIsBanned ? 'destructive' : 'default',
          onPress: async () => {
            setSavingUserId(listedUser._id);

            try {
              await toggleUserBan({
                adminId: user._id,
                targetUserId: listedUser._id,
                isBanned: nextIsBanned,
              });
            } catch (error: unknown) {
              const message =
                error instanceof Error ? error.message : 'Failed to update ban status';
              Alert.alert('Error', message);
            } finally {
              setSavingUserId(null);
            }
          },
        },
      ]
    );
  };

  const handleWalletUpdate = async () => {
    if (!user || user.role !== 'admin' || !walletUser || !selectedWallet) {
      return;
    }

    setSavingUserId(walletUser._id);

    try {
      if (selectedWallet.isFrozen) {
        await unfreezeWallet({
          adminId: user._id,
          walletId: selectedWallet._id,
        });
      } else {
        const reason = walletReason.trim();
        if (!reason) {
          Alert.alert('Reason required', 'Add a reason before freezing this wallet.');
          return;
        }

        await freezeWallet({
          adminId: user._id,
          walletId: selectedWallet._id,
          reason,
        });
      }

      closeWalletDialog();
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to update wallet status';
      Alert.alert('Error', message);
    } finally {
      setSavingUserId(null);
    }
  };

  if (!user) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="User Management"
          subtitle="Roles and account controls"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Sign in required
          </Text>
        </View>
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="User Management"
          subtitle="Roles and account controls"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <Icon name="shield-lock-outline" size={48} color={theme.colors.primary} />
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface, marginTop: 16 }}>
            Access Restricted
          </Text>
          <Text
            variant="bodyMedium"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
          >
            Only Super Admins can manage user roles and ban status.
          </Text>
        </View>
      </View>
    );
  }

  if (usersResult === undefined || platformSettings === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader
          title="User Management"
          subtitle="Roles and account controls"
          onBackPress={() => navigation.goBack()}
          variant="gradient"
        />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="User Management"
        subtitle="Roles and account controls"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <Surface style={[styles.infoCard, { backgroundColor: theme.colors.surface }]} elevation={1}>
          <View style={styles.infoHeader}>
            <View style={styles.infoText}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Company seller account
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}
              >
                Storefront assignment now lives in mobile Store Management. This screen keeps the
                company seller user visible so role and ban changes stay safe.
              </Text>
            </View>
            <View
              style={[
                styles.infoIcon,
                { backgroundColor: theme.colors.primaryContainer },
              ]}
            >
              <Icon name="store-cog-outline" size={22} color={theme.colors.primary} />
            </View>
          </View>

          <View style={[styles.storefrontRow, { borderColor: theme.colors.outlineVariant }]}>
            <View style={{ flex: 1 }}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                Current storefront
              </Text>
              <Text variant="bodyLarge" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
                {platformSettings.companyDisplayName}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                {platformSettings.companySeller
                  ? `${platformSettings.companySeller.firstName} ${platformSettings.companySeller.lastName} (${platformSettings.companySeller.email})`
                  : 'No company seller configured yet'}
              </Text>
            </View>
            <Button mode="contained-tonal" onPress={() => navigation.navigate('AdminStores')}>
              Open Stores
            </Button>
          </View>
        </Surface>

        <Searchbar
          placeholder="Search users by name or email"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={[styles.searchbar, { backgroundColor: theme.colors.surface }]}
        />

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          <Chip selected={roleFilter === 'all'} onPress={() => setRoleFilter('all')}>
            All
          </Chip>
          {roleOptions.map((role) => (
            <Chip
              key={role}
              selected={roleFilter === role}
              onPress={() => setRoleFilter(role)}
            >
              {getRoleLabel(role)}
            </Chip>
          ))}
        </ScrollView>

        <View style={styles.resultsHeader}>
          <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
            Users
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {filteredUsers.length} visible
          </Text>
        </View>

        {filteredUsers.length === 0 ? (
          <Surface style={[styles.emptyCard, { backgroundColor: theme.colors.surface }]} elevation={0}>
            <Icon name="account-search-outline" size={42} color={theme.colors.primary} />
            <Text variant="titleSmall" style={{ color: theme.colors.onSurface, marginTop: 12 }}>
              No users match this filter
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginTop: 8, textAlign: 'center' }}
            >
              Clear the search or switch role filters to see more accounts.
            </Text>
          </Surface>
        ) : (
          <View style={styles.userList}>
            {filteredUsers.map((listedUser) => {
              const isCompanySeller = listedUser._id === companySellerUserId;
              const isSaving = savingUserId === listedUser._id;

              return (
                <Surface
                  key={listedUser._id}
                  style={[styles.userCard, { backgroundColor: theme.colors.surface }]}
                  elevation={0}
                >
                  <View style={styles.userHeader}>
                    <View style={styles.userIdentity}>
                      <Avatar.Text
                        size={50}
                        label={`${listedUser.firstName[0]}${listedUser.lastName[0]}`}
                        style={{ backgroundColor: theme.colors.primaryContainer }}
                        labelStyle={{ color: theme.colors.primary }}
                      />
                      <View style={{ flex: 1 }}>
                        <Text variant="titleSmall" style={{ color: theme.colors.onSurface }}>
                          {listedUser.firstName} {listedUser.lastName}
                        </Text>
                        <Text
                          variant="bodySmall"
                          style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                        >
                          {listedUser.email}
                        </Text>
                      </View>
                    </View>
                    {isSaving ? (
                      <ActivityIndicator size="small" color={theme.colors.primary} />
                    ) : null}
                  </View>

                  <View style={styles.chipRow}>
                    <Chip compact icon={getRoleIcon(listedUser.role)}>
                      {getRoleLabel(listedUser.role)}
                    </Chip>
                    <Chip
                      compact
                      style={{
                        backgroundColor: listedUser.isBanned
                          ? theme.colors.errorContainer
                          : theme.colors.secondaryContainer,
                      }}
                      textStyle={{
                        color: listedUser.isBanned
                          ? theme.colors.onErrorContainer
                          : theme.colors.onSecondaryContainer,
                      }}
                    >
                      {listedUser.isBanned ? 'Banned' : 'Active'}
                    </Chip>
                    {isCompanySeller ? (
                      <Chip compact icon="storefront-outline">
                        Company Seller
                      </Chip>
                    ) : null}
                  </View>

                  <View style={styles.actionsRow}>
                    <Button
                      mode="outlined"
                      onPress={() => openRoleDialog(listedUser)}
                      disabled={isSaving}
                      style={styles.actionButton}
                    >
                      Change Role
                    </Button>
                    <Button
                      mode={listedUser.isBanned ? 'contained-tonal' : 'contained'}
                      buttonColor={listedUser.isBanned ? undefined : theme.colors.error}
                      textColor={listedUser.isBanned ? undefined : theme.colors.onError}
                      onPress={() => handleBanToggle(listedUser)}
                      disabled={isSaving}
                      style={styles.actionButton}
                    >
                      {listedUser.isBanned ? 'Unban' : 'Ban'}
                    </Button>
                  </View>

                  <Button
                    mode="text"
                    onPress={() => openWalletDialog(listedUser)}
                    disabled={isSaving}
                    style={styles.walletButton}
                  >
                    Wallet Controls
                  </Button>
                </Surface>
              );
            })}
          </View>
        )}
      </ScrollView>

      <Portal>
        <Dialog visible={selectedUser !== null} onDismiss={closeRoleDialog}>
          <Dialog.Title>Update Role</Dialog.Title>
          <Dialog.Content>
            {selectedUser ? (
              <>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Change role for {selectedUser.firstName} {selectedUser.lastName}.
                </Text>
                <View style={styles.dialogChipRow}>
                  {roleOptions.map((role) => (
                    <Chip
                      key={role}
                      selected={selectedRole === role}
                      onPress={() => setSelectedRole(role)}
                    >
                      {getRoleLabel(role)}
                    </Chip>
                  ))}
                </View>
              </>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeRoleDialog}>Cancel</Button>
            <Button
              onPress={() => void handleSaveRole()}
              loading={selectedUser ? savingUserId === selectedUser._id : false}
              disabled={selectedUser ? savingUserId === selectedUser._id : false}
            >
              Save
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={walletUser !== null} onDismiss={closeWalletDialog}>
          <Dialog.Title>Wallet Controls</Dialog.Title>
          <Dialog.Content>
            {walletUser ? (
              <>
                <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant }}>
                  Manage the wallet for {walletUser.firstName} {walletUser.lastName}.
                </Text>

                {selectedWallet === undefined ? (
                  <View style={styles.walletLoading}>
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  </View>
                ) : selectedWallet === null ? (
                  <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
                    This user does not have a wallet yet.
                  </Text>
                ) : (
                  <>
                    <View style={styles.walletStatusRow}>
                      <Chip compact>{selectedWallet.isFrozen ? 'Frozen' : 'Active'}</Chip>
                      <Chip compact>Balance {selectedWallet.balance.toLocaleString()} ZMW</Chip>
                    </View>

                    <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
                      {selectedWallet.isFrozen
                        ? selectedWallet.freezeReason || 'Wallet is currently frozen.'
                        : 'Freezing a wallet blocks normal wallet usage until it is manually restored.'}
                    </Text>

                    {!selectedWallet.isFrozen ? (
                      <TextInput
                        mode="outlined"
                        label="Freeze Reason"
                        value={walletReason}
                        onChangeText={setWalletReason}
                        multiline
                        numberOfLines={3}
                        style={styles.walletReasonInput}
                      />
                    ) : null}
                  </>
                )}
              </>
            ) : null}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={closeWalletDialog}>Cancel</Button>
            {selectedWallet ? (
              <Button
                onPress={() => void handleWalletUpdate()}
                loading={walletUser ? savingUserId === walletUser._id : false}
                disabled={walletUser ? savingUserId === walletUser._id : false}
              >
                {selectedWallet.isFrozen ? 'Unfreeze' : 'Freeze'}
              </Button>
            ) : null}
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  infoCard: {
    borderRadius: 20,
    padding: 18,
  },
  infoHeader: {
    flexDirection: 'row',
    gap: 16,
  },
  infoText: {
    flex: 1,
  },
  infoIcon: {
    width: 48,
    height: 48,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  storefrontRow: {
    marginTop: 18,
    paddingTop: 18,
    borderTopWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  searchbar: {
    marginTop: 16,
    borderRadius: 16,
  },
  filterRow: {
    paddingTop: 16,
    gap: 10,
  },
  resultsHeader: {
    marginTop: 20,
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  emptyCard: {
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
  },
  userList: {
    gap: 12,
  },
  userCard: {
    borderRadius: 18,
    padding: 16,
  },
  userHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  userIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 16,
  },
  actionButton: {
    flex: 1,
  },
  walletButton: {
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  dialogChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 16,
  },
  walletLoading: {
    marginTop: 20,
    alignItems: 'center',
  },
  walletStatusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 16,
  },
  walletReasonInput: {
    marginTop: 16,
  },
});
