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
  TenantUser,
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
  private tenants: Map<string, TenantUser> = new Map();
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
      if (parsed.tenants) {
        for (const t of parsed.tenants) this.tenants.set(t.id, t);
      }

      // Migração automática de registros legados pré-multi-tenant para a conta principal
      const primaryTenant = Array.from(this.tenants.values()).find(
        (t) => t.username === 'admin' || t.username === 'omigueldev'
      );
      if (primaryTenant) {
        for (const m of this.messages.values()) {
          if (!m.tenantId) m.tenantId = primaryTenant.id;
        }
        for (const a of this.auditLogs) {
          if (!a.tenantId) a.tenantId = primaryTenant.id;
        }
        for (const t of this.pendingTasks.values()) {
          if (!t.tenantId) t.tenantId = primaryTenant.id;
        }
        for (const ap of this.approvals.values()) {
          if (!ap.tenantId) ap.tenantId = primaryTenant.id;
        }
      }

      // Mapeia nomes de contatos conhecidos para preencher logs antigos que estavam sem nome
      // ATENÇÃO: Apenas mensagens vindas da outra pessoa (fromMe: false) devem definir o nome do contato!
      // Mensagens enviadas pelo proprietário (fromMe: true) têm pushName = "Miguel" e NÃO devem sobrescrever o interlocutor.
      const nameMap = new Map<string, string>();
      for (const m of this.messages.values()) {
        if (!m.fromMe && m.senderName && m.contactId) {
          nameMap.set(m.contactId, m.senderName);
          if (m.lid) nameMap.set(m.lid, m.senderName);
        }
      }
      for (const a of this.auditLogs) {
        // Se o log estava com "Miguel" ou sem nome, tenta pegar o nome real do interlocutor (fromMe: false)
        if ((!a.contactName || a.contactName === 'Miguel') && nameMap.has(a.contactId)) {
          a.contactName = nameMap.get(a.contactId);
        } else if (a.contactName === 'Miguel' && !nameMap.has(a.contactId)) {
          // Se não há nome conhecido do interlocutor, remove o "Miguel" para não induzir a erro
          a.contactName = undefined;
        }
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
      tenants: Array.from(this.tenants.values()),
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

  // Tenants & Auth
  async createTenant(user: TenantUser): Promise<void> {
    this.tenants.set(user.id, user);
    await this.persistAll();
  }

  async getTenantByUsername(username: string): Promise<TenantUser | null> {
    for (const t of this.tenants.values()) {
      if (t.username.toLowerCase() === username.toLowerCase()) return t;
    }
    return null;
  }

  async getTenantById(id: string): Promise<TenantUser | null> {
    return this.tenants.get(id) || null;
  }

  // Messages
  async saveMessage(msg: NormalizedMessage, tenantId?: string): Promise<void> {
    if (tenantId) msg.tenantId = tenantId;
    this.messages.set(msg.id, msg);
    await this.persistAll();
  }

  async getMessage(id: string, tenantId?: string): Promise<NormalizedMessage | null> {
    const m = this.messages.get(id);
    if (!m) return null;
    if (tenantId && m.tenantId && m.tenantId !== tenantId) return null;
    return m;
  }

  async getRecentMessages(contactId: string, limit: number = 20, tenantId?: string): Promise<NormalizedMessage[]> {
    const primaryIds = Array.from(this.tenants.values())
      .filter((t) => t.username === 'admin' || t.username === 'omigueldev')
      .map((t) => t.id);
    const isPrimaryQuery = !tenantId || (tenantId && primaryIds.includes(tenantId));

    const list = Array.from(this.messages.values())
      .filter((m) => {
        const contactMatch = !contactId || m.contactId === contactId;
        if (!contactMatch) return false;
        if (isPrimaryQuery) {
          return !m.tenantId || primaryIds.includes(m.tenantId) || m.tenantId === tenantId;
        }
        return m.tenantId === tenantId;
      })
      .sort((a, b) => a.timestamp - b.timestamp);
    return list.slice(-limit);
  }

  async hasMessage(id: string, tenantId?: string): Promise<boolean> {
    const m = this.messages.get(id);
    if (!m) return false;
    if (tenantId && m.tenantId && m.tenantId !== tenantId) return false;
    return true;
  }

  // Contact Memory
  async getContactMemory(contactId: string, tenantId?: string): Promise<ContactMemory | null> {
    const key = tenantId ? `${tenantId}:${contactId}` : contactId;
    return this.contactMemories.get(key) || this.contactMemories.get(contactId) || null;
  }

  async saveContactMemory(mem: ContactMemory, tenantId?: string): Promise<void> {
    if (tenantId) mem.tenantId = tenantId;
    const key = tenantId ? `${tenantId}:${mem.contactId}` : mem.contactId;
    this.contactMemories.set(key, mem);
    await this.persistAll();
  }

  // Pending Tasks
  async savePendingTask(task: PendingTask, tenantId?: string): Promise<void> {
    if (tenantId) task.tenantId = tenantId;
    this.pendingTasks.set(task.id, task);
    await this.persistAll();
  }

  async getPendingTasks(status?: 'pending' | 'resolved' | 'dismissed', tenantId?: string): Promise<PendingTask[]> {
    const primaryIds = Array.from(this.tenants.values())
      .filter((t) => t.username === 'admin' || t.username === 'omigueldev')
      .map((t) => t.id);
    const isPrimaryQuery = !tenantId || (tenantId && primaryIds.includes(tenantId));

    const all = Array.from(this.pendingTasks.values()).filter((t) => {
      if (isPrimaryQuery) {
        return !t.tenantId || primaryIds.includes(t.tenantId) || t.tenantId === tenantId;
      }
      return t.tenantId === tenantId;
    });
    if (!status) return all;
    return all.filter((t) => t.state === status);
  }

  async updatePendingTaskState(id: string, state: 'pending' | 'resolved' | 'dismissed', tenantId?: string): Promise<void> {
    const task = this.pendingTasks.get(id);
    if (task && (!tenantId || task.tenantId === tenantId)) {
      task.state = state;
      await this.persistAll();
    }
  }

  // Approvals
  async saveApprovalItem(item: ApprovalQueueItem, tenantId?: string): Promise<void> {
    if (tenantId) item.tenantId = tenantId;
    this.approvals.set(item.id, item);
    await this.persistAll();
  }

  async getApprovalItem(id: string, tenantId?: string): Promise<ApprovalQueueItem | null> {
    const item = this.approvals.get(id) || null;
    if (item && tenantId && item.tenantId && item.tenantId !== tenantId) return null;
    return item;
  }

  async getPendingApprovals(tenantId?: string): Promise<ApprovalQueueItem[]> {
    return Array.from(this.approvals.values())
      .filter((a) => a.status === 'pending' && (!tenantId || a.tenantId === tenantId))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async updateApprovalStatus(
    id: string,
    status: 'approved' | 'rejected' | 'edited',
    editedResponse?: string,
    tenantId?: string
  ): Promise<void> {
    const item = this.approvals.get(id);
    if (item && (!tenantId || item.tenantId === tenantId)) {
      item.status = status;
      item.handledAt = Date.now();
      if (editedResponse !== undefined) {
        item.editedResponse = editedResponse;
      }
      await this.persistAll();
    }
  }

  // Audit Logs
  async saveAuditLog(entry: AuditLogEntry, tenantId?: string): Promise<void> {
    if (tenantId) entry.tenantId = tenantId;
    this.auditLogs.push(entry);
    await this.persistAll();
  }

  async getAuditLogs(limit: number = 100, tenantId?: string): Promise<AuditLogEntry[]> {
    const primaryIds = Array.from(this.tenants.values())
      .filter((t) => t.username === 'admin' || t.username === 'omigueldev')
      .map((t) => t.id);
    const isPrimaryQuery = !tenantId || (tenantId && primaryIds.includes(tenantId));

    const filtered = this.auditLogs.filter((a) => {
      if (isPrimaryQuery) {
        return !a.tenantId || primaryIds.includes(a.tenantId) || a.tenantId === tenantId;
      }
      return a.tenantId === tenantId;
    });

    return filtered.slice(-limit).reverse();
  }

  // Idempotency
  async recordSentMessage(messageId: string, contactId: string, text: string, tenantId?: string): Promise<boolean> {
    const key = tenantId ? `${tenantId}:${messageId}` : messageId;
    if (this.sentMessages.has(key)) {
      return false;
    }
    this.sentMessages.add(key);
    await this.persistAll();
    return true;
  }

  async isMessageAlreadySent(messageId: string, tenantId?: string): Promise<boolean> {
    const key = tenantId ? `${tenantId}:${messageId}` : messageId;
    return this.sentMessages.has(key) || this.sentMessages.has(messageId);
  }

  // Custom Heuristic Keyword Rules
  async getKeywordRules(tenantId?: string): Promise<HeuristicKeywordRule[]> {
    const all = Array.from(this.keywordRules.values());
    if (!tenantId) return all;
    return all.filter((r) => !r.tenantId || r.tenantId === tenantId);
  }

  async saveKeywordRule(rule: HeuristicKeywordRule, tenantId?: string): Promise<void> {
    if (tenantId) rule.tenantId = tenantId;
    this.keywordRules.set(rule.id, rule);
    await this.persistAll();
  }

  async deleteKeywordRule(id: string, tenantId?: string): Promise<boolean> {
    const rule = this.keywordRules.get(id);
    if (rule && tenantId && rule.tenantId && rule.tenantId !== tenantId) return false;
    const deleted = this.keywordRules.delete(id);
    if (deleted) {
      await this.persistAll();
    }
    return deleted;
  }
}
