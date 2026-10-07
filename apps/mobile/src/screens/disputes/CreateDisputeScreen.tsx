import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useMutation, useQuery } from 'convex/react';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Surface, Text, TextInput, useTheme } from 'react-native-paper';
import Animated, { FadeInDown } from 'react-native-reanimated';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { api } from '../../../../../convex/_generated/api';
import { StackHeader } from '../../components/ui/Header';
import { useAppAuth } from '../../context/AuthProvider';
import { formatPrice } from '../../theme';
import type { DisputeCategory, Id, RootStackParamList } from '../../types';

type Props = NativeStackScreenProps<RootStackParamList, 'CreateDispute'>;

const CATEGORIES: { value: DisputeCategory; label: string; description: string; icon: string }[] = [
  {
    value: 'not_received',
    label: 'Item Not Received',
    description: "I haven't received my order",
    icon: 'package-variant-closed-remove',
  },
  {
    value: 'not_as_described',
    label: 'Item Not As Described',
    description: 'The item is different from the listing',
    icon: 'file-document-alert-outline',
  },
  {
    value: 'defective',
    label: 'Defective Item',
    description: 'The item arrived damaged or defective',
    icon: 'alert-circle-outline',
  },
  {
    value: 'other',
    label: 'Other',
    description: 'Other issue with my order',
    icon: 'help-circle-outline',
  },
];

export default function CreateDisputeScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const { orderId } = route.params;
  const { user } = useAppAuth();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<DisputeCategory>('not_received');
  const [loading, setLoading] = useState(false);

  const order = useQuery(api.orders.getOrder, { orderId: orderId as Id<'orders'> });
  const createDispute = useMutation(api.disputes.createDispute);

  const handleSubmit = async () => {
    if (!user || !order) return;

    if (!title.trim() || !description.trim()) {
      Alert.alert('Error', 'Please fill in all required fields');
      return;
    }

    setLoading(true);

    try {
      const disputeId = await createDispute({
        orderId: order._id,
        buyerId: user._id,
        title: title.trim(),
        description: description.trim(),
        category,
        evidence: [],
      });

      Alert.alert('Dispute Created', 'Your dispute has been submitted. The seller will be notified.', [
        { text: 'OK', onPress: () => navigation.replace('DisputeDetail', { disputeId: disputeId as string }) },
      ]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create dispute';
      Alert.alert('Error', errorMessage);
    } finally {
      setLoading(false);
    }
  };

  if (order === undefined) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Report Issue" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, { flex: 1 }]}>
          <ActivityIndicator size="large" />
        </View>
      </View>
    );
  }

  if (order === null) {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <StackHeader title="Report Issue" onBackPress={() => navigation.goBack()} />
        <View style={[styles.centered, { flex: 1 }]}>
          <Icon name="alert-circle-outline" size={64} color={theme.colors.error} />
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurfaceVariant, marginTop: 16 }}>
            Order not found
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <StackHeader
        title="Report Issue"
        subtitle={`Order #${order.orderNumber}`}
        onBackPress={() => navigation.goBack()}
      />

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.content}>
        {/* Order Info Card */}
        <Animated.View entering={FadeInDown.delay(100).duration(400)}>
          <Surface style={[styles.orderCard, { backgroundColor: theme.colors.surfaceVariant }]} elevation={0}>
            <View style={styles.orderIconContainer}>
              <Icon name="package-variant" size={32} color={theme.colors.primary} />
            </View>
            <View style={styles.orderInfo}>
              <Text variant="titleMedium" style={{ color: theme.colors.onSurface }}>
                Order #{order.orderNumber}
              </Text>
              <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
                {order.items.length} item(s) • {formatPrice(order.totalAmount)}
              </Text>
            </View>
          </Surface>
        </Animated.View>

        {/* Category Selection */}
        <Animated.View entering={FadeInDown.delay(150).duration(400)}>
          <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
            What's the issue?
          </Text>
          <View style={styles.categoryGrid}>
            {CATEGORIES.map((cat, index) => {
              const isSelected = category === cat.value;
              return (
                <Pressable
                  key={cat.value}
                  onPress={() => setCategory(cat.value)}
                  style={({ pressed }) => [
                    styles.categoryCard,
                    {
                      backgroundColor: isSelected
                        ? theme.colors.primaryContainer
                        : theme.colors.surface,
                      borderColor: isSelected
                        ? theme.colors.primary
                        : theme.colors.surfaceVariant,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.categoryIconContainer,
                      {
                        backgroundColor: isSelected
                          ? theme.colors.primary
                          : theme.colors.surfaceVariant
                      }
                    ]}
                  >
                    <Icon
                      name={cat.icon}
                      size={24}
                      color={isSelected ? theme.colors.onPrimary : theme.colors.onSurfaceVariant}
                    />
                  </View>
                  <Text
                    variant="labelLarge"
                    style={{
                      color: isSelected ? theme.colors.onPrimaryContainer : theme.colors.onSurface,
                      marginTop: 8,
                      textAlign: 'center',
                    }}
                  >
                    {cat.label}
                  </Text>
                  <Text
                    variant="bodySmall"
                    style={{
                      color: isSelected ? theme.colors.onPrimaryContainer : theme.colors.onSurfaceVariant,
                      textAlign: 'center',
                      marginTop: 4,
                    }}
                    numberOfLines={2}
                  >
                    {cat.description}
                  </Text>
                  {isSelected && (
                    <View style={[styles.selectedIndicator, { backgroundColor: theme.colors.primary }]}>
                      <Icon name="check" size={12} color={theme.colors.onPrimary} />
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        </Animated.View>

        {/* Issue Details */}
        <Animated.View entering={FadeInDown.delay(200).duration(400)}>
          <Text variant="titleMedium" style={[styles.sectionTitle, { color: theme.colors.onSurface }]}>
            Describe the Issue
          </Text>

          <TextInput
            mode="outlined"
            label="Title"
            value={title}
            onChangeText={setTitle}
            placeholder="Brief summary of the issue"
            maxLength={100}
            style={styles.input}
            left={<TextInput.Icon icon="format-title" />}
            outlineStyle={styles.inputOutline}
          />

          <TextInput
            mode="outlined"
            label="Description"
            value={description}
            onChangeText={setDescription}
            placeholder="Please describe the issue in detail. Include what you expected vs. what you received..."
            multiline
            numberOfLines={6}
            maxLength={2000}
            style={styles.input}
            outlineStyle={styles.inputOutline}
          />

          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'right' }}>
            {description.length}/2000
          </Text>
        </Animated.View>

        {/* Info Box */}
        <Animated.View entering={FadeInDown.delay(250).duration(400)}>
          <Surface style={[styles.infoCard, { backgroundColor: theme.colors.tertiaryContainer }]} elevation={0}>
            <Icon name="information-outline" size={24} color={theme.colors.tertiary} />
            <View style={styles.infoContent}>
              <Text variant="labelMedium" style={{ color: theme.colors.onTertiaryContainer }}>
                What happens next?
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onTertiaryContainer, marginTop: 4 }}>
                After submitting, you'll be able to chat with the seller and upload evidence. A Reviewer-Approver may be assigned to help resolve the dispute.
              </Text>
            </View>
          </Surface>
        </Animated.View>

        {/* Submit Button */}
        <Animated.View entering={FadeInDown.delay(300).duration(400)}>
          <Pressable
            onPress={handleSubmit}
            disabled={loading || !title.trim() || !description.trim()}
            style={({ pressed }) => [
              styles.submitButton,
              { opacity: (loading || !title.trim() || !description.trim()) ? 0.5 : pressed ? 0.9 : 1 }
            ]}
          >
            <LinearGradient
              colors={[theme.colors.primary, theme.colors.tertiary]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={styles.submitGradient}
            >
              {loading ? (
                <ActivityIndicator color={theme.colors.onPrimary} />
              ) : (
                <>
                  <Icon name="send" size={20} color={theme.colors.onPrimary} />
                  <Text variant="titleMedium" style={{ color: theme.colors.onPrimary, marginLeft: 8 }}>
                    Submit Dispute
                  </Text>
                </>
              )}
            </LinearGradient>
          </Pressable>
        </Animated.View>
      </ScrollView>
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
    paddingBottom: 40,
  },
  orderCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 24,
  },
  orderIconContainer: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  orderInfo: {
    flex: 1,
    marginLeft: 16,
  },
  sectionTitle: {
    marginBottom: 16,
    fontWeight: '600',
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 24,
  },
  categoryCard: {
    width: '47%',
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    position: 'relative',
  },
  categoryIconContainer: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectedIndicator: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  input: {
    marginBottom: 12,
  },
  inputOutline: {
    borderRadius: 12,
  },
  infoCard: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 16,
    marginBottom: 24,
    alignItems: 'flex-start',
  },
  infoContent: {
    flex: 1,
    marginLeft: 12,
  },
  submitButton: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  submitGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
  },
});
