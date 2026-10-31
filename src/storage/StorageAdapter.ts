import {
  NormalizedMessage,
  ContactMemory,
  PendingTask,
  ApprovalQueueItem,
  AuditLogEntry,
  HeuristicKeywordRule,
} from '../types/index.js';

export interface StorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;

  // Messages
  saveMessage(msg: NormalizedMessage): Promise<void>;
  getMessage(id: string): Promise<NormalizedMessage | null>;
  getRecentMessages(contactId: string, limit?: number): Promise<NormalizedMessage[]>;
  hasMessage(id: string): Promise<boolean>;

  // Contact Memory
  getContactMemory(contactId: string): Promise<ContactMemory | null>;
  saveContactMemory(mem: ContactMemory): Promise<void>;

  // Pending Tasks
  savePendingTask(task: PendingTask): Promise<void>;
  getPendingTasks(status?: 'pending' | 'resolved' | 'dismissed'): Promise<PendingTask[]>;
  updatePendingTaskState(id: string, state: 'pending' | 'resolved' | 'dismissed'): Promise<void>;

  // Approvals
  saveApprovalItem(item: ApprovalQueueItem): Promise<void>;
  getApprovalItem(id: string): Promise<ApprovalQueueItem | null>;
  getPendingApprovals(): Promise<ApprovalQueueItem[]>;
  updateApprovalStatus(id: string, status: 'approved' | 'rejected' | 'edited', editedResponse?: string): Promise<void>;

  // Audit Logs
  saveAuditLog(entry: AuditLogEntry): Promise<void>;
  getAuditLogs(limit?: number): Promise<AuditLogEntry[]>;

  // Idempotency / Dispatch Tracking
  recordSentMessage(messageId: string, contactId: string, text: string): Promise<boolean>;
  isMessageAlreadySent(messageId: string): Promise<boolean>;

  // Custom Heuristic Keyword Rules (Hybrid Search)
  getKeywordRules(): Promise<HeuristicKeywordRule[]>;
  saveKeywordRule(rule: HeuristicKeywordRule): Promise<void>;
  deleteKeywordRule(id: string): Promise<boolean>;
}
