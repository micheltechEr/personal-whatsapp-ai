import EventEmitter from 'node:events';
import { StorageAdapter } from '../storage/StorageAdapter.js';
import { WhatsAppGateway } from '../gateway/WhatsAppGateway.js';
import { ContextEngine } from '../intelligence/ContextEngine.js';
import { IntentClassifier } from '../intelligence/IntentClassifier.js';
import { RiskEngine } from '../intelligence/RiskEngine.js';
import { PersonalityEngine } from '../intelligence/PersonalityEngine.js';
import { ResponseGenerator } from '../intelligence/ResponseGenerator.js';
import { AutonomyController } from '../autonomy/AutonomyController.js';
import { MessageDispatcher } from '../autonomy/MessageDispatcher.js';
import { ApprovalManager } from '../autonomy/ApprovalManager.js';
import { ImportantSubjectClassifier } from '../intelligence/ImportantSubjectClassifier.js';
import {
  NormalizedMessage,
  AuditLogEntry,
  PendingTask,
} from '../types/index.js';

export interface ProcessorConfig {
  bufferWindowMs: number; // H02: Debounce window for consecutive messages
}

export class MessageProcessor extends EventEmitter {
  private config: ProcessorConfig;
  private messageBuffer: Map<string, { timer: NodeJS.Timeout; messages: NormalizedMessage[] }> = new Map();
  private importantClassifier: ImportantSubjectClassifier;

  constructor(
    private storage: StorageAdapter,
    private contextEngine: ContextEngine,
    private intentClassifier: IntentClassifier,
    private riskEngine: RiskEngine,
    private personalityEngine: PersonalityEngine,
    private responseGenerator: ResponseGenerator,
    private autonomyController: AutonomyController,
    private dispatcher: MessageDispatcher,
    private approvalManager: ApprovalManager,
    customConfig?: Partial<ProcessorConfig>,
    importantClassifier?: ImportantSubjectClassifier
  ) {
    super();
    this.config = {
      bufferWindowMs: 400, // Janela rápida de 400ms para mensagens consecutivas
      ...customConfig,
    };
    this.importantClassifier = importantClassifier || new ImportantSubjectClassifier(storage);
  }

  public async onIncomingMessage(message: NormalizedMessage): Promise<void> {
    // 1. Descarte estrito de grupos se o bot não estiver expressamente autorizado no grupo
    if (message.isGroup) {
      const groups = await this.storage.getGroups();
      const groupInfo = groups.find((g) => g.id === message.remoteJid || g.id === message.contactId);
      if (!groupInfo || !groupInfo.botEnabled) {
        return;
      }
    }

    // 2. Persist message immediately
    await this.storage.saveMessage(message);

    // 3. If from owner, cancel any active debounce timer for this contact
    if (message.fromMe) {
      this.clearBuffer(message.contactId);
      return;
    }

    // 4. Consecutive grouping window (H02)
    const windowMs = this.config.bufferWindowMs;
    const existing = this.messageBuffer.get(message.contactId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(() => {
        this.processBatch(message.contactId).catch(console.error);
      }, windowMs);
    } else {
      const timer = setTimeout(() => {
        this.processBatch(message.contactId).catch(console.error);
      }, windowMs);

      this.messageBuffer.set(message.contactId, {
        timer,
        messages: [message],
      });
    }
  }

  public clearBuffer(contactId: string): void {
    const existing = this.messageBuffer.get(contactId);
    if (existing) {
      clearTimeout(existing.timer);
      this.messageBuffer.delete(contactId);
    }
  }

  public clearAllBuffers(): void {
    for (const item of this.messageBuffer.values()) {
      clearTimeout(item.timer);
    }
    this.messageBuffer.clear();
  }

  public async processBatch(contactId: string): Promise<void> {
    const buffered = this.messageBuffer.get(contactId);
    this.messageBuffer.delete(contactId);
    if (!buffered || buffered.messages.length === 0) return;

    // Aggregate messages in batch
    const aggregatedContent = buffered.messages.map((m) => m.content).join(' ');
    // Keep the id of the first message in the batch as canonical id
    const primaryMessage = buffered.messages[0];
    // Se alguma das mensagens do lote tiver mediaBase64 (como figurinha ou imagem), preserva para o pipeline de visão
    const messageWithMedia = buffered.messages.find((m) => m.mediaBase64);
    const syntheticMessage: NormalizedMessage = {
      ...primaryMessage,
      content: aggregatedContent,
      type: messageWithMedia ? messageWithMedia.type : primaryMessage.type,
      mediaBase64: messageWithMedia?.mediaBase64,
      mimetype: messageWithMedia?.mimetype || primaryMessage.mimetype,
    };

    await this.processSingleOrAggregated(syntheticMessage);
  }

  public async processSingleOrAggregated(message: NormalizedMessage): Promise<void> {
    const context = await this.contextEngine.getContext(message.contactId, message);
    const risk = await this.riskEngine.analyzeAsync(message.content, context.recentSummary);
    const hasQuoted = Boolean(message.quoted?.stanzaId);
    const intent = this.intentClassifier.classifyWithJev(
      message.content,
      message.type,
      context.recentSummary,
      risk.jevEvaluation,
      hasQuoted
    );

    // Generate Proposal
    const proposal = await this.responseGenerator.generateDecision(message, context, risk, intent);

    // Autonomy Controller makes deterministic evaluation
    const evaluation = this.autonomyController.evaluate(proposal, context.contactMemory);

    let sentResponse: string | undefined = undefined;

    // Execute according to deterministic evaluation
    if (evaluation.allowedAction === 'AUTO_REPLY' && proposal.suggested_response) {
      console.log(`[MessageProcessor] AUTO_REPLY disparado para ${message.contactId}: "${proposal.suggested_response}"`);
      const sendResult = await this.dispatcher.dispatch(
        message.id,
        message.contactId,
        proposal.suggested_response,
        message.raw // Passa a mensagem original para citação com quoted
      );
      if (sendResult.sent) {
        sentResponse = proposal.suggested_response;
        console.log(`[MessageProcessor] AUTO_REPLY enviado com sucesso para ${message.contactId}!`);
      } else {
        evaluation.blockedReason = sendResult.reason;
        console.warn(`[MessageProcessor] AUTO_REPLY bloqueado pelo dispatcher: ${sendResult.reason}`);
      }
    } else if (evaluation.allowedAction === 'REVIEW_REQUIRED' && proposal.suggested_response) {
      await this.approvalManager.addToQueue({
        messageId: message.id,
        contactId: message.contactId,
        contactName: message.senderName,
        contactJid: message.contactJid || message.remoteJid,
        originalMessage: message.content,
        contextSummary: context.recentSummary,
        suggestedResponse: proposal.suggested_response,
        reason: evaluation.blockedReason || proposal.reason,
        riskLevel: proposal.risk_level,
        confidence: proposal.confidence,
      });
    }

    // Save pending operational task if needed
    if (proposal.operational_action && proposal.operational_action !== 'IGNORAR') {
      const task: PendingTask = {
        id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        contactId: message.contactId,
        contactName: message.senderName,
        contactJid: message.contactJid || message.remoteJid,
        description: `Ação necessária: ${proposal.operational_action} referente a "${message.content.slice(0, 50)}"`,
        createdAt: Date.now(),
        priority: intent.isUrgent ? 'urgent' : proposal.risk_level >= 2 ? 'high' : 'normal',
        state: 'pending',
        sourceMessageId: message.id,
        action: proposal.operational_action,
      };
      await this.storage.savePendingTask(task);
    }

    // Record Immutable Audit Log
    const auditEntry: AuditLogEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      contactId: message.contactId,
      contactName: message.senderName,
      contactJid: message.contactJid || message.remoteJid,
      messageId: message.id,
      rawInput: message.content,
      intent: proposal.intent,
      riskLevel: proposal.risk_level,
      recommendedDecision: proposal.decision,
      finalDecision: evaluation.allowedAction,
      confidence: proposal.confidence,
      reason: proposal.reason,
      safetyFlags: proposal.safety_flags,
      sentResponse,
      blockedReason: evaluation.blockedReason,
      requiresHuman: evaluation.allowedAction !== 'AUTO_REPLY' && evaluation.allowedAction !== 'IGNORE',
    };

    await this.storage.saveAuditLog(auditEntry);

    // Se o assunto for relevante / importante (propostas, reuniões, orçamentos, contratos, prazos),
    // classifica e atualiza o resumo executivo, decisão tomada e pendências
    this.importantClassifier.analyzeAndSave(message, context, sentResponse, message.tenantId).catch((err) => {
      console.warn('[MessageProcessor] Erro ao classificar assunto importante:', err);
    });

    this.emit('processed', { message, proposal, evaluation, auditEntry });
  }
}
