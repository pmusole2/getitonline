import { z } from "zod";

// Message attachment
export const MessageAttachmentSchema = z.object({
  type: z.enum(["image", "video"]),
  url: z.string().url("Invalid URL"),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

// Send message
export const SendMessageSchema = z.object({
  disputeId: z.string().min(1, "Dispute ID is required"),
  content: z
    .string()
    .min(1, "Message cannot be empty")
    .max(2000, "Message must be less than 2000 characters"),
  attachments: z.array(MessageAttachmentSchema).max(5, "Maximum 5 attachments").optional(),
  originalContent: z.string().optional(), // If AI suggested rephrasing
  aiRephraseAccepted: z.boolean().optional(),
});
export type SendMessage = z.infer<typeof SendMessageSchema>;

// Message output
export const MessageSchema = z.object({
  _id: z.string(),
  disputeId: z.string(),
  senderId: z.string(),
  content: z.string(),
  originalContent: z.string().optional().nullable(),
  attachments: z.array(MessageAttachmentSchema).optional().nullable(),
  isSystemMessage: z.boolean(),
  aiRephraseAccepted: z.boolean().optional().nullable(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof MessageSchema>;

// Message with sender
export const MessageWithSenderSchema = MessageSchema.extend({
  sender: z
    .object({
      _id: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      avatar: z.string().optional().nullable(),
      role: z.enum(["user", "catalog_manager", "moderator", "admin"]),
    })
    .nullable(),
});
export type MessageWithSender = z.infer<typeof MessageWithSenderSchema>;

// AI rephrase request
export const AIRephraseRequestSchema = z.object({
  message: z.string().min(1, "Message is required"),
  context: z.enum(["dispute", "general"]).optional().default("dispute"),
});
export type AIRephraseRequest = z.infer<typeof AIRephraseRequestSchema>;

// AI rephrase response
export const AIRephraseResponseSchema = z.object({
  original: z.string(),
  rephrased: z.string(),
  isProfessional: z.boolean(),
  suggestions: z.array(z.string()).optional(),
});
export type AIRephraseResponse = z.infer<typeof AIRephraseResponseSchema>;
