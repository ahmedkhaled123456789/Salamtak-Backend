import { Schema, model } from 'mongoose';

export const CONVERSATION_TYPES = ['BOOKING', 'SUPPORT'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];
export const MESSAGE_TYPES = ['TEXT', 'SYSTEM'] as const;

/**
 * BOOKING: patient <-> nurse of one paid booking. SUPPORT: one user <-> the support team (any
 * ADMIN with chat access). Arbitrary user-to-user conversations cannot exist: a conversation is
 * created only through these two server-validated paths, identified by a unique `key`.
 */
const participantSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['PATIENT', 'NURSE'], required: true },
    lastReadAt: Date,
  },
  { _id: false },
);
const conversationSchema = new Schema(
  {
    type: { type: String, enum: CONVERSATION_TYPES, required: true },
    key: { type: String, required: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    /** BOOKING: both users; SUPPORT: just the customer (staff access is by role) */
    participants: { type: [participantSchema], required: true },
    lastMessageAt: Date,
  },
  { timestamps: true, versionKey: false, strict: 'throw' },
);
conversationSchema.index({ key: 1 }, { unique: true });
conversationSchema.index({ 'participants.userId': 1, lastMessageAt: -1 });
conversationSchema.index({ type: 1, lastMessageAt: -1 });
export const Conversation = model('Conversation', conversationSchema, 'conversations');
export type ConversationDoc = InstanceType<typeof Conversation>;

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    /** always the authenticated user (never taken from a request body) */
    senderId: { type: Schema.Types.ObjectId, ref: 'User' },
    senderRole: { type: String, enum: ['PATIENT', 'NURSE', 'ADMIN', 'SYSTEM'], required: true },
    type: { type: String, enum: MESSAGE_TYPES, default: 'TEXT' },
    text: { type: String, required: true, maxlength: 10_000 },
    metadata: Schema.Types.Mixed,
    /** client-generated id: retries of the same send are no-ops */
    clientMessageId: { type: String, maxlength: 80 },
    readAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false, strict: 'throw' },
);
messageSchema.index({ conversationId: 1, _id: -1 });
messageSchema.index(
  { conversationId: 1, senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
messageSchema.index({ conversationId: 1, readAt: 1, senderId: 1 });
export const Message = model('Message', messageSchema, 'messages');
export type MessageDoc = InstanceType<typeof Message>;
