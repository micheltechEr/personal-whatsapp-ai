import { OperationalAction } from '../types/index.js';

export interface IntentAnalysis {
  intent: string;
  isQuestion: boolean;
  isUrgent: boolean;
  requiresResponse: boolean; // H03: intelligent silence check
  operationalAction: OperationalAction;
  confidence: number;
  extractedDeadlines?: number;
}

export class IntentClassifier {
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
    // If just media without caption or meaningless reaction/empty
    if (type !== 'text' && (!text || text === '[Imagem]' || text === '[Áudio]' || text === '[Vídeo]')) {
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

    // Simple greetings (ex: "bom dia sr", "olá tudo bem")
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
}
