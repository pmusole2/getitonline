import React, { useState, useEffect, useRef } from 'react';
import { View, StyleSheet, ScrollView, Alert, Pressable } from 'react-native';
import { Text, TextInput, Button, useTheme, Avatar, Surface } from 'react-native-paper';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../../types';
import { useAppAuth } from '../../context/AuthProvider';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { AccountAccessNotice } from '../../components/auth/AccountAccessNotice';
import { useAccountAccess } from '../../components/auth/useAccountAccess';
import { StackHeader } from '../../components/ui/Header';

type Props = NativeStackScreenProps<RootStackParamList, 'EditProfile'>;
type Account = NonNullable<ReturnType<typeof useAppAuth>['user']>;

export default function EditProfileScreen(props: Props) {
  const access = useAccountAccess();
  const { user } = useAppAuth();
  if (access.status !== 'ready' || !user) {
    return <AccountAccessNotice access={access} title="Edit Profile" />;
  }
  // Keyed by account, so another account never inherits this draft, and losing access drops the draft with the content.
  return <EditProfileContent key={user._id} {...props} user={user} />;
}

function EditProfileContent({ navigation, user }: Props & { user: Account }) {
  const theme = useTheme();

  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [phone, setPhone] = useState(user.phone || '');
  const [loading, setLoading] = useState(false);

  const updateProfile = useMutation(api.users.updateProfile);

  // A save that finishes after this screen has unmounted must not report success or navigate for another session.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim()) {
      Alert.alert('Error', 'First name and last name are required');
      return;
    }

    setLoading(true);

    try {
      await updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim() || undefined,
      });

      if (!mounted.current) return;
      Alert.alert('Success', 'Profile updated successfully', [{ text: 'OK', onPress: () => navigation.goBack() }]);
    } catch (error: unknown) {
      if (!mounted.current) return;
      const errorMessage = error instanceof Error ? error.message : 'Failed to update profile';
      Alert.alert('Error', errorMessage);
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      {/* Custom Futuristic Header */}
      <StackHeader
        title="Edit Profile"
        subtitle="Update your information"
        onBackPress={() => navigation.goBack()}
        variant="gradient"
      />

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        {/* Avatar Section */}
        <Animated.View entering={FadeIn.duration(400)} style={styles.avatarSection}>
          <View style={styles.avatarContainer}>
            <Avatar.Text
              size={100}
              label={`${firstName[0] || '?'}${lastName[0] || '?'}`}
              style={{ backgroundColor: theme.colors.primary }}
              labelStyle={{ fontWeight: '600' }}
            />
            <Pressable style={[styles.editAvatarButton, { backgroundColor: theme.colors.primaryContainer }]}>
              <Icon name="camera" size={20} color={theme.colors.primary} />
            </Pressable>
          </View>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 12 }}>
            Tap to change profile photo
          </Text>
        </Animated.View>

        {/* Form Section */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <Surface style={[styles.formCard, { backgroundColor: theme.colors.surface }]} elevation={2}>
            <Text variant="titleMedium" style={{ color: theme.colors.onSurface, fontWeight: '600', marginBottom: 16 }}>
              Personal Information
            </Text>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                First Name *
              </Text>
              <TextInput
                mode="outlined"
                value={firstName}
                onChangeText={setFirstName}
                autoCapitalize="words"
                style={styles.input}
                outlineStyle={styles.inputOutline}
                left={<TextInput.Icon icon="account-outline" />}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                Last Name *
              </Text>
              <TextInput
                mode="outlined"
                value={lastName}
                onChangeText={setLastName}
                autoCapitalize="words"
                style={styles.input}
                outlineStyle={styles.inputOutline}
                left={<TextInput.Icon icon="account-outline" />}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                Phone Number
              </Text>
              <TextInput
                mode="outlined"
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                placeholder="+260..."
                style={styles.input}
                outlineStyle={styles.inputOutline}
                left={<TextInput.Icon icon="phone-outline" />}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                Email Address
              </Text>
              <TextInput
                mode="outlined"
                value={user.email}
                disabled
                style={[styles.input, styles.disabledInput]}
                outlineStyle={styles.inputOutline}
                left={<TextInput.Icon icon="email-outline" />}
              />
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
                Email cannot be changed
              </Text>
            </View>
          </Surface>
        </Animated.View>

        {/* Verification Status */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Surface
            style={[
              styles.verificationCard,
              { backgroundColor: user.isVerified ? theme.colors.secondaryContainer : theme.colors.surfaceVariant },
            ]}
            elevation={0}
          >
            <View style={styles.verificationContent}>
              <View
                style={[
                  styles.verificationIcon,
                  {
                    backgroundColor: user.isVerified
                      ? theme.colors.secondary + '30'
                      : theme.colors.onSurfaceVariant + '20',
                  },
                ]}
              >
                <Icon
                  name={user.isVerified ? 'check-decagram' : 'shield-alert-outline'}
                  size={24}
                  color={user.isVerified ? theme.colors.secondary : theme.colors.onSurfaceVariant}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  variant="titleSmall"
                  style={{
                    color: user.isVerified ? theme.colors.onSecondaryContainer : theme.colors.onSurfaceVariant,
                    fontWeight: '600',
                  }}
                >
                  {user.isVerified ? 'Verified Account' : 'Account Not Verified'}
                </Text>
                <Text
                  variant="bodySmall"
                  style={{
                    color: user.isVerified ? theme.colors.onSecondaryContainer : theme.colors.onSurfaceVariant,
                    opacity: 0.8,
                  }}
                >
                  {user.isVerified
                    ? 'Your account is verified and trusted'
                    : 'Verification helps build trust and speeds up support checks'}
                </Text>
              </View>
              {!user.isVerified && <Icon name="chevron-right" size={20} color={theme.colors.onSurfaceVariant} />}
            </View>
          </Surface>
        </Animated.View>

        {/* Save Button */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)} style={styles.buttonContainer}>
          <Button
            mode="contained"
            onPress={handleSave}
            loading={loading}
            disabled={loading || !firstName.trim() || !lastName.trim()}
            style={styles.saveButton}
            contentStyle={styles.saveButtonContent}
            icon="content-save"
          >
            Save Changes
          </Button>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  avatarSection: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  avatarContainer: {
    position: 'relative',
  },
  editAvatarButton: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  formCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  inputGroup: {
    marginBottom: 16,
  },
  input: {
    backgroundColor: 'transparent',
  },
  inputOutline: {
    borderRadius: 12,
  },
  disabledInput: {
    opacity: 0.6,
  },
  verificationCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 16,
  },
  verificationContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  verificationIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  buttonContainer: {
    paddingHorizontal: 16,
  },
  saveButton: {
    borderRadius: 12,
  },
  saveButtonContent: {
    paddingVertical: 8,
  },
});
