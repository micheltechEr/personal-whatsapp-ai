import { OperationalAction } from '../types/index.js';
import { JevClassifierClient, JevEvaluationResult } from './JevClassifierClient.js';

export interface IntentAnalysis {
  intent: string;
  isQuestion: boolean;
  isUrgent: boolean;
  requiresResponse: boolean; // H03: intelligent silence check
  operationalAction: OperationalAction;
  confidence: number;
  extractedDeadlines?: number;
  jevEvaluation?: JevEvaluationResult;
}

export class IntentClassifier {
  constructor(private jevClient?: JevClassifierClient) {}
  private urgentPatterns: RegExp[] = [
    /\b(urgente|urg[êe]ncia|emerg[êe]ncia|imediato|o\s+quanto\s+antes|r[áa]pido\s+por\s+favor|socorro|prioridade\s+m[áa]xima)\b/i,
  ];

  private schedulingPatterns: RegExp[] = [
    /\b(vamos\s+marcar|reuni[ãa]o|almo[çc]ar|caf[ée]|hor[áa]rio|quando\s+voc[êe]\s+pode|dispon[íi]vel\s+amanh[ãa]|agendar|encontrar)\b/i,
  ];

  private questionPatterns: RegExp[] = [
    /\?/,
    /\b(como|quando|onde|por\s*que|pq|qual|quem|quanto|ser[áa]|consegue|pode)\b/i,
  ];

  private resolutionPatterns: RegExp[] = [
    /\b(preciso\s+que|favor\s+enviar|manda\s+o|faz\s+isso|atualiza|corrige|arruma|ajuda\s+com)\b/i,
  ];

  public classify(content: string, type: string = 'text', recentConversationContext: string = ''): IntentAnalysis {
    const text = content.trim();

    // H03: Intelligent silence detection
    // If just media without caption or meaningless reaction/empty (incluindo figurinhas)
    const isBareMedia =
      type !== 'text' ||
      !text ||
      text === '[Figurinha]' ||
      text.trim() === '[Figurinha]' ||
      text === '[Imagem]' ||
      text === '[Áudio]' ||
      text === '[Vídeo]';

    if (isBareMedia) {
      return {
        intent: 'MEDIA_SHARE_NO_TEXT',
        isQuestion: false,
        isUrgent: false,
        requiresResponse: false,
        operationalAction: 'IGNORAR',
        confidence: 96,
      };
    }

    const isUrgent = this.urgentPatterns.some((p) => p.test(text));
    const isQuestion = this.questionPatterns.some((p) => p.test(text));

    // Despedidas explícitas ou expressões de encerramento/ir dormir (tchau, até mais, fui dormir, boa noite de despedida)
    const isFarewell =
      /\b(tchau|at[ée]\s+mais|at[ée]\s+logo|at[ée]\s+amanh[ãa]|fui|falou|dormir|vou\s+dormir|indo\s+dormir|dorme\s+bem|descansa|bom\s+descanso)\b/i.test(text) ||
      (/\bboa\s+noite\b/i.test(text) && (
        /\b(dormir|beijo|at[ée]|amanh[ãa]|fui|descansar)\b/i.test(text) ||
        Boolean(recentConversationContext && recentConversationContext.length > 20)
      ));

    if (isFarewell && !isQuestion) {
      return {
        intent: 'FAREWELL',
        isQuestion: false,
        isUrgent: false,
        requiresResponse: false, // H16: Encerra a conversa sem mandar resposta sem sentido (Silêncio inteligente)
        operationalAction: 'IGNORAR',
        confidence: 98,
      };
    }

    // Saudações de início de conversa (ex: "boa noite", "olá tudo bem", "bom dia") quando NÃO há contexto recente longo
    if (/\b(oi|ol[áa]|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i.test(text) && text.split(/\s+/).length <= 6) {
      return {
        intent: 'GREETING',
        isQuestion: false,
        isUrgent: false,
        requiresResponse: true,
        operationalAction: 'RESPONDER',
        confidence: 98,
      };
    }

    // Gratitude / Acknowledgment
    if (/\b(valeu|obrigado|obrigada|show|beleza|tranquilo|combinado)\b/i.test(text) && text.split(/\s+/).length <= 4) {
      return {
        intent: 'ACKNOWLEDGMENT',
        isQuestion: false,
        isUrgent,
        requiresResponse: false, // H10/H16: Don't prolong conversation unnecessarily
        operationalAction: 'IGNORAR',
        confidence: 95,
      };
    }

    // Scheduling / Calendar
    if (this.schedulingPatterns.some((p) => p.test(text))) {
      return {
        intent: 'SCHEDULING_INVITATION',
        isQuestion,
        isUrgent,
        requiresResponse: true,
        operationalAction: 'AGENDAR',
        confidence: 92,
      };
    }

    // Resolving requests or urgency
    if (this.resolutionPatterns.some((p) => p.test(text)) || isUrgent) {
      return {
        intent: isUrgent ? 'URGENT_REQUEST' : 'RESOLUTION_REQUEST',
        isQuestion,
        isUrgent,
        requiresResponse: true,
        operationalAction: 'RESOLVER',
        confidence: 90,
      };
    }

    // Questions
    if (isQuestion) {
      const isSimple = text.length < 50;
      // If words indicate specific query about events, dates or project deliverables
      const isAboutDeliverable = /\b(quando|onde|quanto|qual|hor[áa]rio|entrega|projeto|valor|pre[çc]o)\b/i.test(text);
      return {
        intent: isAboutDeliverable || !isSimple ? 'QUESTION_CONTEXTUAL' : 'QUESTION_SIMPLE',
        isQuestion: true,
        isUrgent,
        requiresResponse: true,
        operationalAction: 'RESPONDER',
        confidence: 94,
      };
    }

    // Casual statement
    return {
      intent: 'CASUAL_CONVERSATION',
      isQuestion: false,
      isUrgent,
      requiresResponse: true,
      operationalAction: 'RESPONDER',
      confidence: 88,
    };
  }

  public classifyWithJev(
    content: string,
    type: string = 'text',
    recentConversationContext: string = '',
    jev?: JevEvaluationResult | null
  ): IntentAnalysis {
    const base = this.classify(content, type, recentConversationContext);
    if (!jev) return base;

    if (jev.intent === 'system_probing' || jev.isAttackOrProbing) {
      return {
        ...base,
        intent: 'PROMPT_INJECTION',
        requiresResponse: false,
        operationalAction: 'IGNORAR',
        confidence: Math.max(base.confidence, jev.intentConfidence),
        jevEvaluation: jev,
      };
    }

    if (jev.intent === 'commercial') {
      return {
        ...base,
        intent: 'COMMERCIAL_INQUIRY',
        requiresResponse: true,
        operationalAction: 'RESPONDER',
        confidence: Math.max(base.confidence, jev.intentConfidence),
        jevEvaluation: jev,
      };
    }

    return {
      ...base,
      confidence: Math.round((base.confidence + jev.intentConfidence) / 2),
      jevEvaluation: jev,
    };
  }
}
