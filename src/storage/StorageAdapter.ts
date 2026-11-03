import {
  NormalizedMessage,
  ContactMemory,
  PendingTask,
  ApprovalQueueItem,
  AuditLogEntry,
  HeuristicKeywordRule,
  TenantUser,
  ImportantConversationSummary,
  WhatsAppGroupInfo,
  OwnerFactRule,
} from '../types/index.js';

export interface StorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;

  // Tenants & Auth
  createTenant(user: TenantUser): Promise<void>;
  getTenantByUsername(username: string): Promise<TenantUser | null>;
  getTenantById(id: string): Promise<TenantUser | null>;

  // Messages (scoped by tenantId)
  saveMessage(msg: NormalizedMessage, tenantId?: string): Promise<void>;
  getMessage(id: string, tenantId?: string): Promise<NormalizedMessage | null>;
  getRecentMessages(contactId: string, limit?: number, tenantId?: string): Promise<NormalizedMessage[]>;
  hasMessage(id: string, tenantId?: string): Promise<boolean>;

  // Contact Memory
  getContactMemory(contactId: string, tenantId?: string): Promise<ContactMemory | null>;
  saveContactMemory(mem: ContactMemory, tenantId?: string): Promise<void>;

  // Pending Tasks
  savePendingTask(task: PendingTask, tenantId?: string): Promise<void>;
  getPendingTasks(status?: 'pending' | 'resolved' | 'dismissed', tenantId?: string): Promise<PendingTask[]>;
  updatePendingTaskState(id: string, state: 'pending' | 'resolved' | 'dismissed', tenantId?: string): Promise<void>;

  // Approvals
  saveApprovalItem(item: ApprovalQueueItem, tenantId?: string): Promise<void>;
  getApprovalItem(id: string, tenantId?: string): Promise<ApprovalQueueItem | null>;
  getPendingApprovals(tenantId?: string): Promise<ApprovalQueueItem[]>;
  updateApprovalStatus(id: string, status: 'approved' | 'rejected' | 'edited', editedResponse?: string, tenantId?: string): Promise<void>;

  // Audit Logs
  saveAuditLog(entry: AuditLogEntry, tenantId?: string): Promise<void>;
  getAuditLogs(limit?: number, tenantId?: string): Promise<AuditLogEntry[]>;

  // Idempotency / Dispatch Tracking
  recordSentMessage(messageId: string, contactId: string, text: string, tenantId?: string): Promise<boolean>;
  isMessageAlreadySent(messageId: string, tenantId?: string): Promise<boolean>;

  // Custom Heuristic Keyword Rules (Hybrid Search)
  getKeywordRules(tenantId?: string): Promise<HeuristicKeywordRule[]>;
  saveKeywordRule(rule: HeuristicKeywordRule, tenantId?: string): Promise<void>;
  deleteKeywordRule(id: string, tenantId?: string): Promise<boolean>;

  // Important Conversations (Highlights / Priority Threads)
  saveImportantConversation(summary: ImportantConversationSummary, tenantId?: string): Promise<void>;
  getImportantConversations(tenantId?: string): Promise<ImportantConversationSummary[]>;
  deleteImportantConversation(id: string, tenantId?: string): Promise<boolean>;

  // Group Management (Progressive Enablement)
  saveGroup(group: WhatsAppGroupInfo, tenantId?: string): Promise<void>;
  getGroups(tenantId?: string): Promise<WhatsAppGroupInfo[]>;
  setGroupBotEnabled(groupId: string, enabled: boolean, tenantId?: string): Promise<void>;

  // Owner Facts & Curiosities (Fatos Pessoais / Verdades Absolutas)
  saveOwnerFact(fact: OwnerFactRule, tenantId?: string): Promise<void>;
  getOwnerFacts(tenantId?: string): Promise<OwnerFactRule[]>;
  deleteOwnerFact(id: string, tenantId?: string): Promise<boolean>;

  // Settings & Limits
  getSetting(key: string, tenantId?: string): Promise<string | null>;
  setSetting(key: string, value: string, tenantId?: string): Promise<void>;
}
