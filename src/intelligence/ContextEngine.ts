import { NormalizedMessage, ContactMemory, PendingTask } from '../types/index.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';

export interface ConversationContext {
  contactId: string;
  contactMemory: ContactMemory;
  recentMessages: NormalizedMessage[];
  pendingTasks: PendingTask[];
  recentSummary: string;
  lastTopic?: string;
  isOwnerLastSender: boolean;
  ownerSentManualReplyRecently: boolean;
  contextConfidence: number;
}

export class ContextEngine {
  constructor(private storage: StorageAdapter) {}

  public async getContext(contactId: string): Promise<ConversationContext> {
    let mem = await this.storage.getContactMemory(contactId);
    if (!mem) {
      mem = {
        contactId,
        relationship: 'unknown',
        formalityLevel: 'medium',
        notes: [],
        autoReplyAllowed: true,
        blocked: false,
        maxDailyAutoReplies: 5,
        autoRepliesToday: 0,
        lastAutoReplyTimestamp: 0,
      };
      await this.storage.saveContactMemory(mem);
    }

    // Check 24-hour daily quota rollover
    const now = Date.now();
    const isNewDay =
      mem.lastAutoReplyTimestamp > 0 &&
      new Date(mem.lastAutoReplyTimestamp).toDateString() !== new Date(now).toDateString();

    if (isNewDay) {
      mem.autoRepliesToday = 0;
      await this.storage.saveContactMemory(mem);
    }

    const recent = await this.storage.getRecentMessages(contactId, 15);
    const allPending = await this.storage.getPendingTasks('pending');
    const contactPending = allPending.filter((t) => t.contactId === contactId);

    const isOwnerLastSender = recent.length > 0 && recent[recent.length - 1].fromMe;

    // Check if owner sent a manual reply AFTER the latest message from the contact
    // Apenas considera resposta manual do proprietário se tiver ocorrido nos últimos 10 minutos
    let ownerSentManualReplyRecently = false;
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    if (recent.length > 0) {
      const lastContactMsg = [...recent].reverse().find((m) => !m.fromMe);
      const lastOwnerMsg = [...recent].reverse().find((m) => m.fromMe);
      if (
        lastContactMsg &&
        lastOwnerMsg &&
        lastOwnerMsg.timestamp > lastContactMsg.timestamp &&
        lastOwnerMsg.timestamp > tenMinutesAgo
      ) {
        ownerSentManualReplyRecently = true;
      }
    }

    // Build concise context summary
    const summaryLines = recent.slice(-5).map((m) => {
      const sender = m.fromMe ? 'Proprietário' : 'Contato';
      return `${sender}: ${m.content}`;
    });
    const recentSummary = summaryLines.join(' | ') || 'Nenhuma conversa anterior registrada.';

    // Calculate context confidence
    // High confidence (90+) if at least 2 relevant interactions exist or relationship/notes are known
    let contextConfidence = 80;
    if (recent.length >= 3 || (mem.notes && mem.notes.length > 0)) contextConfidence = 95;
    else if (recent.length >= 1) contextConfidence = 88;
    else contextConfidence = 70; // Unknown contact or cold start

    return {
      contactId,
      contactMemory: mem,
      recentMessages: recent,
      pendingTasks: contactPending,
      recentSummary,
      isOwnerLastSender,
      ownerSentManualReplyRecently,
      contextConfidence,
    };
  }

  public async updateMemoryNotes(contactId: string, newFact: string): Promise<void> {
    const mem = await this.storage.getContactMemory(contactId);
    if (mem && !mem.notes.includes(newFact)) {
      mem.notes.push(newFact);
      await this.storage.saveContactMemory(mem);
    }
  }
}
