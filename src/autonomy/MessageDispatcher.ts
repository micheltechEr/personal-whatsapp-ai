import { StorageAdapter } from '../storage/StorageAdapter.js';
import { WhatsAppGateway } from '../gateway/WhatsAppGateway.js';

export interface DispatcherConfig {
  minIntervalBetweenRepliesMs: number; // e.g. 5000 ms to avoid spamming
  maxGlobalPerHour: number;
}

export class MessageDispatcher {
  private config: DispatcherConfig;
  private recentDispatches: Map<string, number> = new Map(); // contactId -> timestamp
  private globalSentCountInHour = 0;
  private hourWindowStart = Date.now();

  constructor(
    private storage: StorageAdapter,
    private gateway?: WhatsAppGateway,
    customConfig?: Partial<DispatcherConfig>
  ) {
    this.config = {
      minIntervalBetweenRepliesMs: 3000,
      maxGlobalPerHour: 120,
      ...customConfig,
    };
  }

  public async dispatch(
    messageId: string,
    contactId: string,
    text: string
  ): Promise<{ sent: boolean; reason?: string; sentMessageId?: string }> {
    if (!text || !text.trim()) {
      return { sent: false, reason: 'Texto de resposta vazio.' };
    }

    // 1. Idempotency Check: prevent duplicate reply to the same message
    const isAlreadySent = await this.storage.isMessageAlreadySent(messageId);
    if (isAlreadySent) {
      return { sent: false, reason: 'Mensagem já respondida previamente (idempotência garantida).' };
    }

    // 2. Loop Protection & Minimum Interval Check
    const now = Date.now();
    const lastSentForContact = this.recentDispatches.get(contactId) || 0;
    if (now - lastSentForContact < 1000) { // Reduzido para 1s
      return {
        sent: false,
        reason: `Proteção contra loop ativa: intervalo mínimo não atingido.`,
      };
    }

    // 3. Global send rate limit check
    if (now - this.hourWindowStart > 60 * 60 * 1000) {
      this.hourWindowStart = now;
      this.globalSentCountInHour = 0;
    }

    if (this.globalSentCountInHour >= this.config.maxGlobalPerHour) {
      return {
        sent: false,
        reason: `Limite global de envios por hora (${this.config.maxGlobalPerHour}) atingido.`,
      };
    }

    // 4. Execute network dispatch via Gateway FIRST, only record on success!
    let sentId = `sim-sent-${now}`;
    if (this.gateway) {
      try {
        sentId = await this.gateway.sendMessage(contactId, text);
      } catch (err) {
        console.error(`[MessageDispatcher] Erro ao enviar mensagem para ${contactId}:`, err);
        return {
          sent: false,
          reason: `Falha na conexão do WhatsApp Gateway: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // 5. Record sent status and update quotas ONLY after successful dispatch
    await this.storage.recordSentMessage(messageId, contactId, text);
    this.recentDispatches.set(contactId, now);
    this.globalSentCountInHour++;

    const mem = await this.storage.getContactMemory(contactId);
    if (mem) {
      const isNewDay =
        mem.lastAutoReplyTimestamp > 0 &&
        new Date(mem.lastAutoReplyTimestamp).toDateString() !== new Date(now).toDateString();

      mem.autoRepliesToday = isNewDay ? 1 : (mem.autoRepliesToday || 0) + 1;
      mem.lastAutoReplyTimestamp = now;
      await this.storage.saveContactMemory(mem);
    }

    return {
      sent: true,
      sentMessageId: sentId,
    };
  }
}
