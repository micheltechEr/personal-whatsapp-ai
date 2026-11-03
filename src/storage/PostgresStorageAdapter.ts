import pg from 'pg';
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

export class PostgresStorageAdapter implements StorageAdapter {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id VARCHAR(255) PRIMARY KEY,
        contact_id VARCHAR(255) NOT NULL,
        sender_name VARCHAR(255),
        content TEXT NOT NULL,
        timestamp BIGINT NOT NULL,
        from_me BOOLEAN NOT NULL,
        is_group BOOLEAN NOT NULL,
        type VARCHAR(50) NOT NULL,
        raw JSONB
      );

      CREATE TABLE IF NOT EXISTS contact_memories (
        contact_id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255),
        relationship VARCHAR(50) NOT NULL,
        formality_level VARCHAR(50) NOT NULL,
        notes JSONB NOT NULL DEFAULT '[]'::jsonb,
        auto_reply_allowed BOOLEAN NOT NULL DEFAULT true,
        blocked BOOLEAN NOT NULL DEFAULT false,
        max_daily_auto_replies INT NOT NULL DEFAULT 5,
        auto_replies_today INT NOT NULL DEFAULT 0,
        last_auto_reply_timestamp BIGINT NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pending_tasks (
        id VARCHAR(255) PRIMARY KEY,
        contact_id VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        priority VARCHAR(50) NOT NULL,
        state VARCHAR(50) NOT NULL,
        source_message_id VARCHAR(255) NOT NULL,
        action VARCHAR(50) NOT NULL,
        deadline BIGINT
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id VARCHAR(255) PRIMARY KEY,
        message_id VARCHAR(255) NOT NULL,
        contact_id VARCHAR(255) NOT NULL,
        original_message TEXT NOT NULL,
        context_summary TEXT NOT NULL,
        suggested_response TEXT NOT NULL,
        reason TEXT NOT NULL,
        risk_level INT NOT NULL,
        confidence JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        status VARCHAR(50) NOT NULL,
        edited_response TEXT,
        handled_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id VARCHAR(255) PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        contact_id VARCHAR(255) NOT NULL,
        message_id VARCHAR(255) NOT NULL,
        raw_input TEXT NOT NULL,
        intent VARCHAR(100) NOT NULL,
        risk_level INT NOT NULL,
        recommended_decision VARCHAR(50) NOT NULL,
        final_decision VARCHAR(50) NOT NULL,
        confidence JSONB NOT NULL,
        reason TEXT NOT NULL,
        safety_flags JSONB NOT NULL,
        sent_response TEXT,
        blocked_reason TEXT,
        requires_human BOOLEAN NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sent_messages (
        message_id VARCHAR(255) PRIMARY KEY,
        contact_id VARCHAR(255) NOT NULL,
        text TEXT NOT NULL,
        sent_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS heuristic_keyword_rules (
        id VARCHAR(255) PRIMARY KEY,
        word VARCHAR(255) NOT NULL,
        category VARCHAR(50) NOT NULL,
        weight INT NOT NULL,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id VARCHAR(255) PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at BIGINT NOT NULL
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveMessage(msg: NormalizedMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, contact_id, sender_name, content, timestamp, from_me, is_group, type, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET content = $4`,
      [msg.id, msg.contactId, msg.senderName || null, msg.content, msg.timestamp, msg.fromMe, msg.isGroup, msg.type, JSON.stringify(msg.raw || {})]
    );
  }

  async getMessage(id: string): Promise<NormalizedMessage | null> {
    const res = await this.pool.query(`SELECT * FROM messages WHERE id = $1`, [id]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      contactId: r.contact_id,
      senderName: r.sender_name || undefined,
      content: r.content,
      timestamp: Number(r.timestamp),
      fromMe: r.from_me,
      isGroup: r.is_group,
      type: r.type,
      raw: r.raw,
    };
  }

  async getRecentMessages(contactId: string, limit = 20): Promise<NormalizedMessage[]> {
    const query = contactId
      ? `SELECT * FROM messages WHERE contact_id = $1 ORDER BY timestamp ASC LIMIT $2`
      : `SELECT * FROM messages ORDER BY timestamp ASC LIMIT $1`;
    const params = contactId ? [contactId, limit] : [limit];
    const res = await this.pool.query(query, params);
    return res.rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      senderName: r.sender_name || undefined,
      content: r.content,
      timestamp: Number(r.timestamp),
      fromMe: r.from_me,
      isGroup: r.is_group,
      type: r.type,
      raw: r.raw,
    }));
  }

  async hasMessage(id: string): Promise<boolean> {
    const res = await this.pool.query(`SELECT 1 FROM messages WHERE id = $1`, [id]);
    return res.rows.length > 0;
  }

  async getContactMemory(contactId: string): Promise<ContactMemory | null> {
    const res = await this.pool.query(`SELECT * FROM contact_memories WHERE contact_id = $1`, [contactId]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      contactId: r.contact_id,
      name: r.name || undefined,
      relationship: r.relationship,
      formalityLevel: r.formality_level,
      notes: r.notes || [],
      autoReplyAllowed: r.auto_reply_allowed,
      blocked: r.blocked,
      maxDailyAutoReplies: r.max_daily_auto_replies,
      autoRepliesToday: r.auto_replies_today,
      lastAutoReplyTimestamp: Number(r.last_auto_reply_timestamp),
    };
  }

  async saveContactMemory(mem: ContactMemory): Promise<void> {
    await this.pool.query(
      `INSERT INTO contact_memories (
        contact_id, name, relationship, formality_level, notes,
        auto_reply_allowed, blocked, max_daily_auto_replies, auto_replies_today, last_auto_reply_timestamp
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (contact_id) DO UPDATE SET
        name = $2, relationship = $3, formality_level = $4, notes = $5,
        auto_reply_allowed = $6, blocked = $7, max_daily_auto_replies = $8,
        auto_replies_today = $9, last_auto_reply_timestamp = $10`,
      [
        mem.contactId,
        mem.name || null,
        mem.relationship,
        mem.formalityLevel,
        JSON.stringify(mem.notes),
        mem.autoReplyAllowed,
        mem.blocked,
        mem.maxDailyAutoReplies,
        mem.autoRepliesToday,
        mem.lastAutoReplyTimestamp,
      ]
    );
  }

  async savePendingTask(task: PendingTask): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_tasks (id, contact_id, description, created_at, priority, state, source_message_id, action, deadline)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET state = $6`,
      [task.id, task.contactId, task.description, task.createdAt, task.priority, task.state, task.sourceMessageId, task.action, task.deadline || null]
    );
  }

  async getPendingTasks(status?: 'pending' | 'resolved' | 'dismissed'): Promise<PendingTask[]> {
    const query = status ? `SELECT * FROM pending_tasks WHERE state = $1` : `SELECT * FROM pending_tasks`;
    const params = status ? [status] : [];
    const res = await this.pool.query(query, params);
    return res.rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      description: r.description,
      createdAt: Number(r.created_at),
      priority: r.priority,
      state: r.state,
      sourceMessageId: r.source_message_id,
      action: r.action,
      deadline: r.deadline ? Number(r.deadline) : undefined,
    }));
  }

  async updatePendingTaskState(id: string, state: 'pending' | 'resolved' | 'dismissed'): Promise<void> {
    await this.pool.query(`UPDATE pending_tasks SET state = $1 WHERE id = $2`, [state, id]);
  }

  async saveApprovalItem(item: ApprovalQueueItem): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (
        id, message_id, contact_id, original_message, context_summary,
        suggested_response, reason, risk_level, confidence, created_at, status, edited_response, handled_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (id) DO UPDATE SET status = $11, edited_response = $12, handled_at = $13`,
      [
        item.id,
        item.messageId,
        item.contactId,
        item.originalMessage,
        item.contextSummary,
        item.suggestedResponse,
        item.reason,
        item.riskLevel,
        JSON.stringify(item.confidence),
        item.createdAt,
        item.status,
        item.editedResponse || null,
        item.handledAt || null,
      ]
    );
  }

  async getApprovalItem(id: string): Promise<ApprovalQueueItem | null> {
    const res = await this.pool.query(`SELECT * FROM approvals WHERE id = $1`, [id]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      messageId: r.message_id,
      contactId: r.contact_id,
      originalMessage: r.original_message,
      contextSummary: r.context_summary,
      suggestedResponse: r.suggested_response,
      reason: r.reason,
      riskLevel: r.risk_level,
      confidence: r.confidence,
      createdAt: Number(r.created_at),
      status: r.status,
      editedResponse: r.edited_response || undefined,
      handledAt: r.handled_at ? Number(r.handled_at) : undefined,
    };
  }

  async getPendingApprovals(): Promise<ApprovalQueueItem[]> {
    const res = await this.pool.query(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC`);
    return res.rows.map((r) => ({
      id: r.id,
      messageId: r.message_id,
      contactId: r.contact_id,
      originalMessage: r.original_message,
      contextSummary: r.context_summary,
      suggestedResponse: r.suggested_response,
      reason: r.reason,
      riskLevel: r.risk_level,
      confidence: r.confidence,
      createdAt: Number(r.created_at),
      status: r.status,
      editedResponse: r.edited_response || undefined,
      handledAt: r.handled_at ? Number(r.handled_at) : undefined,
    }));
  }

  async updateApprovalStatus(id: string, status: 'approved' | 'rejected' | 'edited', editedResponse?: string): Promise<void> {
    await this.pool.query(
      `UPDATE approvals SET status = $1, edited_response = $2, handled_at = $3 WHERE id = $4`,
      [status, editedResponse || null, Date.now(), id]
    );
  }

  async saveAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_logs (
        id, timestamp, contact_id, message_id, raw_input, intent, risk_level,
        recommended_decision, final_decision, confidence, reason, safety_flags, sent_response, blocked_reason, requires_human
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        entry.id,
        entry.timestamp,
        entry.contactId,
        entry.messageId,
        entry.rawInput,
        entry.intent,
        entry.riskLevel,
        entry.recommendedDecision,
        entry.finalDecision,
        JSON.stringify(entry.confidence),
        entry.reason,
        JSON.stringify(entry.safetyFlags),
        entry.sentResponse || null,
        entry.blockedReason || null,
        entry.requiresHuman,
      ]
    );
  }

  async getAuditLogs(limit = 100): Promise<AuditLogEntry[]> {
    const res = await this.pool.query(`SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT $1`, [limit]);
    return res.rows.map((r) => ({
      id: r.id,
      timestamp: Number(r.timestamp),
      contactId: r.contact_id,
      messageId: r.message_id,
      rawInput: r.raw_input,
      intent: r.intent,
      riskLevel: r.risk_level,
      recommendedDecision: r.recommended_decision,
      finalDecision: r.final_decision,
      confidence: r.confidence,
      reason: r.reason,
      safetyFlags: r.safety_flags,
      sentResponse: r.sent_response || undefined,
      blockedReason: r.blocked_reason || undefined,
      requiresHuman: r.requires_human,
    }));
  }

  async recordSentMessage(messageId: string, contactId: string, text: string): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO sent_messages (message_id, contact_id, text, sent_at) VALUES ($1, $2, $3, $4)`,
        [messageId, contactId, text, Date.now()]
      );
      return true;
    } catch {
      return false;
    }
  }

  async isMessageAlreadySent(messageId: string): Promise<boolean> {
    const res = await this.pool.query(`SELECT 1 FROM sent_messages WHERE message_id = $1`, [messageId]);
    return res.rows.length > 0;
  }

  async getKeywordRules(tenantId?: string): Promise<HeuristicKeywordRule[]> {
    const res = await this.pool.query(`SELECT * FROM heuristic_keyword_rules`);
    return res.rows.map((r) => ({
      id: r.id,
      word: r.word,
      category: r.category,
      weight: r.weight,
      description: r.description || undefined,
    }));
  }

  async saveKeywordRule(rule: HeuristicKeywordRule, tenantId?: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO heuristic_keyword_rules (id, word, category, weight, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET word = $2, category = $3, weight = $4, description = $5`,
      [rule.id, rule.word, rule.category, rule.weight, rule.description || null]
    );
  }

  async deleteKeywordRule(id: string, tenantId?: string): Promise<boolean> {
    const res = await this.pool.query(`DELETE FROM heuristic_keyword_rules WHERE id = $1`, [id]);
    return (res.rowCount || 0) > 0;
  }

  // Tenants
  async createTenant(user: TenantUser): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenants (id, username, name, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET username = $2, name = $3, password_hash = $4`,
      [user.id, user.username, user.name, user.passwordHash, user.createdAt]
    );
  }

  async getTenantByUsername(username: string): Promise<TenantUser | null> {
    const res = await this.pool.query(`SELECT * FROM tenants WHERE LOWER(username) = LOWER($1)`, [username]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      name: r.name,
      passwordHash: r.password_hash,
      createdAt: Number(r.created_at),
    };
  }

  async getTenantById(id: string): Promise<TenantUser | null> {
    const res = await this.pool.query(`SELECT * FROM tenants WHERE id = $1`, [id]);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      username: r.username,
      name: r.name,
      passwordHash: r.password_hash,
      createdAt: Number(r.created_at),
    };
  }

  async getSetting(key: string, tenantId?: string): Promise<string | null> {
    return null;
  }

  async setSetting(key: string, value: string, tenantId?: string): Promise<void> {}

  async saveImportantConversation(summary: any, tenantId?: string): Promise<void> {}

  async getImportantConversations(tenantId?: string): Promise<any[]> {
    return [];
  }

  async deleteImportantConversation(id: string, tenantId?: string): Promise<boolean> {
    return true;
  }

  async saveGroup(group: any, tenantId?: string): Promise<void> {}

  async getGroups(tenantId?: string): Promise<any[]> {
    return [];
  }

  async setGroupBotEnabled(groupId: string, enabled: boolean, tenantId?: string): Promise<void> {}
}
