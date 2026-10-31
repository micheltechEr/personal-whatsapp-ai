import fs from 'node:fs/promises';
import path from 'node:path';
import { StorageAdapter } from './StorageAdapter.js';
import {
  NormalizedMessage,
  ContactMemory,
  PendingTask,
  ApprovalQueueItem,
  AuditLogEntry,
  HeuristicKeywordRule,
} from '../types/index.js';

export class MemoryFileStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private messages: Map<string, NormalizedMessage> = new Map();
  private contactMemories: Map<string, ContactMemory> = new Map();
  private pendingTasks: Map<string, PendingTask> = new Map();
  private approvals: Map<string, ApprovalQueueItem> = new Map();
  private auditLogs: AuditLogEntry[] = [];
  private sentMessages: Set<string> = new Set();
  private keywordRules: Map<string, HeuristicKeywordRule> = new Map();
  private writeLock: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.resolve(process.cwd(), '.data');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.baseDir, { recursive: true });
    await this.loadAll();
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.persistAll();
  }

  private async loadAll(): Promise<void> {
    try {
      const filePath = path.join(this.baseDir, 'state.json');
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);

      if (parsed.messages) {
        for (const m of parsed.messages) this.messages.set(m.id, m);
      }
      if (parsed.contactMemories) {
        for (const c of parsed.contactMemories) this.contactMemories.set(c.contactId, c);
      }
      if (parsed.pendingTasks) {
        for (const t of parsed.pendingTasks) this.pendingTasks.set(t.id, t);
      }
      if (parsed.approvals) {
        for (const a of parsed.approvals) this.approvals.set(a.id, a);
      }
      if (parsed.auditLogs) {
        this.auditLogs = parsed.auditLogs;
      }
      if (parsed.sentMessages) {
        this.sentMessages = new Set(parsed.sentMessages);
      }
      if (parsed.keywordRules) {
        for (const r of parsed.keywordRules) this.keywordRules.set(r.id, r);
      }
    } catch {
      // file might not exist initially, safe to start empty
    }
  }

  private async persistAll(): Promise<void> {
    this.writeLock = this.writeLock
      .catch(() => {})
      .then(() => this.executePersist());
    return this.writeLock;
  }

  private async executePersist(): Promise<void> {
    const filePath = path.join(this.baseDir, 'state.json');
    const tempPath = path.join(
      this.baseDir,
      `state.${Date.now()}.${Math.random().toString(36).slice(2, 7)}.tmp`
    );
    const payload = {
      messages: Array.from(this.messages.values()),
      contactMemories: Array.from(this.contactMemories.values()),
      pendingTasks: Array.from(this.pendingTasks.values()),
      approvals: Array.from(this.approvals.values()),
      auditLogs: this.auditLogs.slice(-2000),
      sentMessages: Array.from(this.sentMessages),
      keywordRules: Array.from(this.keywordRules.values()),
    };

    try {
      await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
      try {
        await fs.rename(tempPath, filePath);
      } catch {
        await fs.copyFile(tempPath, filePath);
        await fs.rm(tempPath, { force: true });
      }
    } catch (err) {
      console.warn('[MemoryFileStorageAdapter] Erro ao persistir estado:', err instanceof Error ? err.message : err);
      try {
        await fs.rm(tempPath, { force: true });
      } catch {}
    }
  }

  // Messages
  async saveMessage(msg: NormalizedMessage): Promise<void> {
    this.messages.set(msg.id, msg);
    await this.persistAll();
  }

  async getMessage(id: string): Promise<NormalizedMessage | null> {
    return this.messages.get(id) || null;
  }

  async getRecentMessages(contactId: string, limit: number = 20): Promise<NormalizedMessage[]> {
    const list = Array.from(this.messages.values())
      .filter((m) => m.contactId === contactId)
      .sort((a, b) => a.timestamp - b.timestamp);
    return list.slice(-limit);
  }

  async hasMessage(id: string): Promise<boolean> {
    return this.messages.has(id);
  }

  // Contact Memory
  async getContactMemory(contactId: string): Promise<ContactMemory | null> {
    return this.contactMemories.get(contactId) || null;
  }

  async saveContactMemory(mem: ContactMemory): Promise<void> {
    this.contactMemories.set(mem.contactId, mem);
    await this.persistAll();
  }

  // Pending Tasks
  async savePendingTask(task: PendingTask): Promise<void> {
    this.pendingTasks.set(task.id, task);
    await this.persistAll();
  }

  async getPendingTasks(status?: 'pending' | 'resolved' | 'dismissed'): Promise<PendingTask[]> {
    const all = Array.from(this.pendingTasks.values());
    if (!status) return all;
    return all.filter((t) => t.state === status);
  }

  async updatePendingTaskState(id: string, state: 'pending' | 'resolved' | 'dismissed'): Promise<void> {
    const task = this.pendingTasks.get(id);
    if (task) {
      task.state = state;
      await this.persistAll();
    }
  }

  // Approvals
  async saveApprovalItem(item: ApprovalQueueItem): Promise<void> {
    this.approvals.set(item.id, item);
    await this.persistAll();
  }

  async getApprovalItem(id: string): Promise<ApprovalQueueItem | null> {
    return this.approvals.get(id) || null;
  }

  async getPendingApprovals(): Promise<ApprovalQueueItem[]> {
    return Array.from(this.approvals.values())
      .filter((a) => a.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateApprovalStatus(
    id: string,
    status: 'approved' | 'rejected' | 'edited',
    editedResponse?: string
  ): Promise<void> {
    const item = this.approvals.get(id);
    if (item) {
      item.status = status;
      item.handledAt = Date.now();
      if (editedResponse !== undefined) {
        item.editedResponse = editedResponse;
      }
      await this.persistAll();
    }
  }

  // Audit Logs
  async saveAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLogs.push(entry);
    await this.persistAll();
  }

  async getAuditLogs(limit: number = 100): Promise<AuditLogEntry[]> {
    return this.auditLogs.slice(-limit).reverse();
  }

  // Idempotency
  async recordSentMessage(messageId: string, contactId: string, text: string): Promise<boolean> {
    if (this.sentMessages.has(messageId)) {
      return false;
    }
    this.sentMessages.add(messageId);
    await this.persistAll();
    return true;
  }

  async isMessageAlreadySent(messageId: string): Promise<boolean> {
    return this.sentMessages.has(messageId);
  }

  // Custom Heuristic Keyword Rules
  async getKeywordRules(): Promise<HeuristicKeywordRule[]> {
    return Array.from(this.keywordRules.values());
  }

  async saveKeywordRule(rule: HeuristicKeywordRule): Promise<void> {
    this.keywordRules.set(rule.id, rule);
    await this.persistAll();
  }

  async deleteKeywordRule(id: string): Promise<boolean> {
    const deleted = this.keywordRules.delete(id);
    if (deleted) {
      await this.persistAll();
    }
    return deleted;
  }
}
