import { z } from 'zod';

export const DecisionSchema = z.enum([
  'AUTO_REPLY',
  'REVIEW_REQUIRED',
  'HUMAN_ONLY',
  'IGNORE',
]);
export type DecisionType = z.infer<typeof DecisionSchema>;

export const RiskLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const OperationalActionSchema = z.enum([
  'RESPONDER',
  'RESOLVER',
  'AGENDAR',
  'LEMBRAR',
  'ACOMPANHAR',
  'IGNORAR',
]);
export type OperationalAction = z.infer<typeof OperationalActionSchema>;

export const ConfidenceScoresSchema = z.object({
  intent: z.number().min(0).max(100),
  context: z.number().min(0).max(100),
  factual: z.number().min(0).max(100),
  response: z.number().min(0).max(100),
});
export type ConfidenceScores = z.infer<typeof ConfidenceScoresSchema>;

export const DecisionContractSchema = z.object({
  message_id: z.string(),
  contact_id: z.string(),
  intent: z.string(),
  risk_level: RiskLevelSchema,
  decision: DecisionSchema,
  confidence: ConfidenceScoresSchema,
  context_summary: z.string(),
  reason: z.string(),
  suggested_response: z.string().optional().default(''),
  safety_flags: z.array(z.string()).default([]),
  requires_human: z.boolean().default(false),
  memory_candidates: z.array(z.string()).default([]),
  operational_action: OperationalActionSchema.optional().default('IGNORAR'),
});
export type DecisionContract = z.infer<typeof DecisionContractSchema>;

export interface NormalizedMessage {
  id: string;
  contactId: string;
  remoteJid?: string;
  senderName?: string;
  content: string;
  timestamp: number;
  fromMe: boolean;
  isGroup: boolean;
  type: 'text' | 'image' | 'audio' | 'video' | 'document' | 'other';
  raw?: unknown;
}

export interface ContactMemory {
  contactId: string;
  name?: string;
  relationship: 'friend' | 'family' | 'work' | 'professional' | 'informal' | 'unknown';
  formalityLevel: 'low' | 'medium' | 'high';
  notes: string[];
  autoReplyAllowed: boolean;
  blocked: boolean;
  maxDailyAutoReplies: number;
  autoRepliesToday: number;
  lastAutoReplyTimestamp: number;
}

export interface PendingTask {
  id: string;
  contactId: string;
  description: string;
  createdAt: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  state: 'pending' | 'resolved' | 'dismissed';
  sourceMessageId: string;
  action: OperationalAction;
  deadline?: number;
}

export interface ApprovalQueueItem {
  id: string;
  messageId: string;
  contactId: string;
  originalMessage: string;
  contextSummary: string;
  suggestedResponse: string;
  reason: string;
  riskLevel: RiskLevel;
  confidence: ConfidenceScores;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected' | 'edited';
  editedResponse?: string;
  handledAt?: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  contactId: string;
  messageId: string;
  rawInput: string;
  intent: string;
  riskLevel: RiskLevel;
  recommendedDecision: DecisionType;
  finalDecision: DecisionType;
  confidence: ConfidenceScores;
  reason: string;
  safetyFlags: string[];
  sentResponse?: string;
  blockedReason?: string;
  requiresHuman: boolean;
}

export interface HeuristicKeywordRule {
  id: string;
  word: string;
  category: 'high_confidence' | 'review' | 'blocked';
  weight: number; // 0 to 100
  description?: string;
}
