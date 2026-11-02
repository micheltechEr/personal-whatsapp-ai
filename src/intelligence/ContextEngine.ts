import { NormalizedMessage, ContactMemory, PendingTask } from '../types/index.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';
import { GenderDetector } from './GenderDetector.js';

export interface ConversationContext {
  contactId: string;
  contactName?: string;
  contactMemory: ContactMemory;
  recentMessages: NormalizedMessage[];
  pendingTasks: PendingTask[];
  recentSummary: string;
  lastTopic?: string;
  isOwnerLastSender: boolean;
  ownerSentManualReplyRecently: boolean;
  contextConfidence: number;
  explicitReferencedMessage?: {
    original: NormalizedMessage;
    surroundingContext: string;
  };
}

export class ContextEngine {
  constructor(private storage: StorageAdapter) {}

  public async getContext(contactId: string, currentMessage?: NormalizedMessage): Promise<ConversationContext> {
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

    // Identifica o nome do contato a partir de mensagens recebidas
    const contactMsgWithName = [...recent].reverse().find((m) => !m.fromMe && m.senderName);
    const contactName = contactMsgWithName?.senderName || mem.name || undefined;
    if (contactName && !mem.name) {
      mem.name = contactName;
    }

    // Identifica o gênero a partir do nome
    const detectedGender = GenderDetector.detectGender(contactName);
    mem.gender = detectedGender;

    // Detecção estrita de relacionamento romântico (apenas com expressões amorosas inequívocas)
    const combinedHistory = recent.map((m) => m.content.toLowerCase()).join(' ');
    const isExplicitlyRomantic = /\b(te\s+amo|meu\s+amor|meu\s+namorado|minha\s+namorada|amor\s+da\s+minha\s+vida|moz[ãa]o)\b/i.test(combinedHistory);
    const isFamily = /\b(minha\s+m[ãa]e|meu\s+pai|meu\s+irm[ãa]o|minha\s+irm[ãa]|minha\s+tia|meu\s+tio)\b/i.test(combinedHistory);

    if (isExplicitlyRomantic && mem.relationship !== 'romantic') {
      mem.relationship = 'romantic';
      await this.storage.saveContactMemory(mem);
    } else if (isFamily && (mem.relationship === 'unknown' || mem.relationship === 'informal')) {
      mem.relationship = 'family';
      await this.storage.saveContactMemory(mem);
    }

    // Check if owner sent a manual reply AFTER the latest message from the contact
    // Apenas se o proprietário digitou MANUALMENTE após a última mensagem do contato nos últimos 60 segundos
    let ownerSentManualReplyRecently = false;
    const sixtySecondsAgo = Date.now() - 60 * 1000;
    if (recent.length > 0) {
      const lastContactMsg = [...recent].reverse().find((m) => !m.fromMe);
      const lastOwnerMsg = [...recent].reverse().find((m) => m.fromMe);
      if (
        lastContactMsg &&
        lastOwnerMsg &&
        lastOwnerMsg.timestamp > lastContactMsg.timestamp &&
        lastOwnerMsg.timestamp > sixtySecondsAgo
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

    // Recupera referência explícita (contextInfo.stanzaId) se a mensagem cita/marca uma conversa antiga
    let explicitReferencedMessage: ConversationContext['explicitReferencedMessage'] = undefined;
    if (currentMessage?.quoted?.stanzaId) {
      const original = await this.storage.getMessage(currentMessage.quoted.stanzaId);
      if (original) {
        // Busca vizinhança temporal (mensagens anteriores e posteriores ao ponto citado)
        const allContactMsgs = await this.storage.getRecentMessages(contactId, 60);
        const originalIndex = allContactMsgs.findIndex((m) => m.id === original.id);
        let surrounding: NormalizedMessage[] = [];
        if (originalIndex !== -1) {
          const start = Math.max(0, originalIndex - 2);
          const end = Math.min(allContactMsgs.length, originalIndex + 3);
          surrounding = allContactMsgs.slice(start, end);
        } else {
          surrounding = [original];
        }

        const surroundingContext = surrounding
          .map((m) => `${m.fromMe ? 'Proprietário' : 'Contato'}: "${m.content}"`)
          .join(' -> ');

        explicitReferencedMessage = {
          original,
          surroundingContext,
        };
      } else if (currentMessage.quoted.quotedMessage) {
        // Fallback: se a mensagem original não estava no banco mas o WhatsApp enviou o preview do texto citado
        explicitReferencedMessage = {
          original: {
            id: currentMessage.quoted.stanzaId,
            contactId,
            content: currentMessage.quoted.quotedMessage,
            timestamp: Date.now() - 3600000,
            fromMe: false,
            isGroup: false,
            type: (currentMessage.quoted.quotedType as any) || 'text',
          },
          surroundingContext: `Mensagem citada no WhatsApp: "${currentMessage.quoted.quotedMessage}"`,
        };
      }
    }

    return {
      contactId,
      contactName,
      contactMemory: mem,
      recentMessages: recent,
      pendingTasks: contactPending,
      recentSummary,
      isOwnerLastSender,
      ownerSentManualReplyRecently,
      contextConfidence,
      explicitReferencedMessage,
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
