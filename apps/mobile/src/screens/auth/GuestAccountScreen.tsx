import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React from "react";
import { StyleSheet, View } from "react-native";
import { Button, Surface, Text, useTheme } from "react-native-paper";
import Icon from "react-native-vector-icons/MaterialCommunityIcons";
import { TabHeader } from "../../components/ui/Header";
import type { RootStackParamList } from "../../types";

export default function GuestAccountScreen() {
  const theme = useTheme();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <TabHeader
        title="Account"
        subtitle="Sign in when you're ready to check out"
        showAIAssistant
      />

      <View style={styles.content}>
        <Surface
          style={[styles.card, { backgroundColor: theme.colors.surface }]}
          elevation={2}
        >
          <View
            style={[
              styles.iconWrap,
              { backgroundColor: theme.colors.primaryContainer },
            ]}
          >
            <Icon name="account-circle-outline" size={44} color={theme.colors.primary} />
          </View>

          <Text
            variant="headlineSmall"
            style={[styles.title, { color: theme.colors.onSurface }]}
          >
            Welcome to Gettitonline
          </Text>
          <Text
            variant="bodyMedium"
            style={[styles.subtitle, { color: theme.colors.onSurfaceVariant }]}
          >
            Browse products freely, keep a local cart, and sign in only when
            you need account features or checkout.
          </Text>

          <View style={styles.actions}>
            <Button
              mode="contained"
              onPress={() => navigation.navigate("Auth", { screen: "SignIn" })}
              style={styles.button}
              contentStyle={styles.buttonContent}
            >
              Sign In
            </Button>
            <Button
              mode="outlined"
              onPress={() => navigation.navigate("Auth", { screen: "SignUp" })}
              style={styles.button}
              contentStyle={styles.buttonContent}
            >
              Create Account
            </Button>
          </View>
        </Surface>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: "center",
    padding: 16,
    paddingBottom: 104,
  },
  card: {
    borderRadius: 24,
    padding: 24,
    alignItems: "center",
  },
  iconWrap: {
    width: 88,
    height: 88,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: {
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    marginTop: 10,
    textAlign: "center",
    lineHeight: 22,
  },
  actions: {
    width: "100%",
    marginTop: 24,
    gap: 12,
  },
  button: {
    borderRadius: 14,
  },
  buttonContent: {
    minHeight: 48,
  },
});
