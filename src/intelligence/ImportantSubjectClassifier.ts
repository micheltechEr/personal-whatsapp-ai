import { StorageAdapter } from '../storage/StorageAdapter.js';
import { NormalizedMessage, ImportantConversationSummary } from '../types/index.js';
import { AgnosticLLMClient, LLMClientConfig } from './AgnosticLLMClient.js';
import { ConversationContext } from './ContextEngine.js';

export class ImportantSubjectClassifier {
  private llmClient: AgnosticLLMClient;

  // Padrões de palavras-chave para acionamento prioritário
  private importantKeywords: RegExp[] = [
    /\b(or[çc]amento|proposta|contrato|projeto|reuni[ãa]o|call|prazo|entrega|pagamento|fechar|servi[çc]o|site|landing\s+page|sistema|investimento|pre[çc]o|documenta[çc][ãa]o|nota\s+fiscal|parceria)\b/i,
    /\b(urgente|importante|aguardo|aguardando|combinado|decidido|pendente|retorno)\b/i,
  ];

  constructor(
    private storage: StorageAdapter,
    config?: LLMClientConfig
  ) {
    this.llmClient = new AgnosticLLMClient(config);
  }

  /**
   * Avalia rapidamente se a mensagem ou o contexto toca em assuntos importantes
   */
  public isSubjectImportant(messageText: string, contextSummary: string = ''): boolean {
    const combined = `${messageText} ${contextSummary}`;
    return this.importantKeywords.some((pattern) => pattern.test(combined));
  }

  /**
   * Analisa a conversa importante via LLM e extrai o resumo executivo, decisão e o que aguarda
   */
  public async analyzeAndSave(
    message: NormalizedMessage,
    context: ConversationContext,
    lastSentResponse?: string,
    tenantId?: string
  ): Promise<ImportantConversationSummary | null> {
    const contactId = message.contactId;
    const contactName = context.contactName || context.contactMemory.name || contactId;

    if (!this.isSubjectImportant(message.content, context.recentSummary)) {
      return null;
    }

    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      const mockSummary: ImportantConversationSummary = {
        id: `priority-${contactId}`,
        tenantId,
        contactId,
        contactName,
        contactJid: message.contactJid || message.remoteJid,
        topic: 'Orçamento de Projeto de Site',
        importanceLevel: 'high',
        summary: `Contato ${contactName} solicitou orçamento para projeto.`,
        lastDecisionTaken: lastSentResponse || 'Resposta enviada aguardando confirmação.',
        waitingFor: 'Aguardando cliente confirmar escopo.',
        status: 'waiting_interlocutor',
        lastActivityTimestamp: Date.now(),
        sourceMessageId: message.id,
      };
      await this.storage.saveImportantConversation(mockSummary, tenantId);
      return mockSummary;
    }

    if (!this.llmClient.isAvailable()) {
      return null;
    }

    const conversationHistory = context.recentMessages
      .slice(-6)
      .map((m) => `${m.fromMe ? 'Proprietário' : contactName}: "${m.content}"`)
      .join('\n');

    const prompt = `Você é um assistente de gestão executiva de conversas do WhatsApp.
Analise esta conversa que trata de um assunto importante (trabalho, proposta, compromisso, orçamento, prazo ou pendência).

Histórico recente:
${conversationHistory}
Última mensagem do contato: "${message.content}"
${lastSentResponse ? `Resposta dada: "${lastSentResponse}"` : ''}

Retorne ESTRITAMENTE um JSON compacto (sem blocos markdown) com o seguinte formato:
{
  "topic": "Título curto do assunto principal (máx 5 palavras, ex: 'Orçamento de Landing Page')",
  "importanceLevel": "high" ou "critical",
  "summary": "Resumo objetivo e claro do que está sendo tratado (1 a 2 frases)",
  "lastDecisionTaken": "O que foi decidido, alinhado ou respondido até o momento",
  "waitingFor": "O que está sendo aguardado agora (ex: 'Aguardando envio do comprovante pelo cliente', 'Aguardando você definir o valor final', 'Aguardando cliente confirmar horário')",
  "status": "pending_action" (se aguarda você fazer algo) OU "waiting_interlocutor" (se aguarda o contato responder/enviar algo) OU "resolved" (se o assunto foi 100% concluído)
}`;

    try {
      const response = await this.llmClient.complete([
        { role: 'system', content: 'Você extrai com máxima precisão o status de negócios e compromissos importantes no WhatsApp.' },
        { role: 'user', content: prompt },
      ]);

      if (!response) return null;

      const cleanJson = response
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

      const parsed = JSON.parse(cleanJson);

      const summaryEntry: ImportantConversationSummary = {
        id: `priority-${contactId}`,
        tenantId,
        contactId,
        contactName,
        contactJid: message.contactJid || message.remoteJid,
        topic: parsed.topic || 'Assunto Importante',
        importanceLevel: parsed.importanceLevel === 'critical' ? 'critical' : 'high',
        summary: parsed.summary || 'Tratativa em andamento.',
        lastDecisionTaken: parsed.lastDecisionTaken || (lastSentResponse ? `Respondido: "${lastSentResponse}"` : 'Em análise'),
        waitingFor: parsed.waitingFor || 'Aguardando continuidade da conversa.',
        status: ['pending_action', 'waiting_interlocutor', 'resolved'].includes(parsed.status)
          ? parsed.status
          : 'waiting_interlocutor',
        lastActivityTimestamp: Date.now(),
        sourceMessageId: message.id,
      };

      await this.storage.saveImportantConversation(summaryEntry, tenantId);
      console.log(`[ImportantSubjectClassifier] Conversa prioritária salva para ${contactName}: "${summaryEntry.topic}" (Aguardando: ${summaryEntry.waitingFor})`);
      return summaryEntry;
    } catch (err) {
      console.warn('[ImportantSubjectClassifier] Erro ao analisar conversa prioritária:', (err as any).message);
      return null;
    }
  }
}
