import { RiskLevel } from '../types/index.js';

export interface RiskAnalysis {
  riskLevel: RiskLevel;
  safetyFlags: string[];
  reasons: string[];
  promptInjectionDetected: boolean;
  isSensitiveTopic: boolean;
  requiresHumanReview: boolean;
}

export class RiskEngine {
  // Regex patterns for Prompt Injection attacks & System Probing (H12)
  private injectionPatterns: RegExp[] = [
    /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
    /desconsidere\s+(as\s+)?instru[çc][õo]es\s+anteriores/i,
    /system\s+prompt/i,
    /sua\s+instru[çc][ãa]o\s+de\s+sistema/i,
    /voc[êe]\s+agora\s+[ée]\s+um/i,
    /you\s+are\s+now/i,
    /revelar\s+(a\s+)?chave/i,
    /show\s+(your\s+)?prompt/i,
    /bypass\s+security/i,
    /esque[çc]a\s+suas\s+regras/i,
    /modo\s+desenvolvedor/i,
    /developer\s+mode/i,
    /jailbreak/i,
    // Sondagem de sistema / LLM / Arquivos internos
    /\b(qual\s+modelo|qual\s+o\s+modelo|modelo\s+de\s+llm|qual\s+llm|qual\s+ia)\b/i,
    /\b(seu\s+ambiente|sobre\s+o\s+seu\s+ambiente|pastas\s+e\s+arquivos|acesso\s+a\s+quais\s+arquivos)\b/i,
    /\b(arquivos\s+vc\s+tem\s+acesso|arquivos\s+voc[êe]\s+tem\s+acesso|prompt\s+inicial)\b/i,
  ];

  // Regex patterns for Level 3: Money, Bank, Pix, Health, Legal, Delicate/Intimate, Conflict
  private moneyPatterns: RegExp[] = [
    /\b(pix|chave\s+pix|transfer[êe]ncia|ted|doc|dep[óo]sito|banco|conta\s+banc[áa]ria|empr[ée]stimo|pagar|pagamento|fatura|cart[ãa]o|cvv|dinheiro|reais|r\$|d[óo]lar)\b/i,
  ];

  private healthPatterns: RegExp[] = [
    /\b(rem[ée]dio|medicamento|diagn[óo]stico|sintoma|doen[çc]a|hospital|m[ée]dico|exame|cirurgia|depress[ãa]o|suic[íi]dio|ansiedade|tratamento|dor\s+no\s+peito)\b/i,
  ];

  private legalPatterns: RegExp[] = [
    /\b(advogado|processo|judicial|juiz|intima[çc][ãa]o|audi[êe]ncia|contrato\s+social|notifica[çc][ãa]o\s+extrajudicial|pol[íi]cia|boletim\s+de\s+ocorr[êe]ncia|delegacia)\b/i,
  ];

  private conflictAndEmotionPatterns: RegExp[] = [
    /\b(odeio|terminar|div[óo]rcio|separar|separada|separado|briga|brigando|trai[çc][ãa]o|traiu|chora|chorando|n[ãa]o\s+aguento\s+mais|desgosto|vergonha|culpa|amante)\b/i,
  ];

  // Patterns for Level 2: Commitments, invitations, negotiations, sensitive preferences
  private moderatePatterns: RegExp[] = [
    /\b(vamos\s+almo[çc]ar|podemos\s+marcar|reuni[ãa]o|fechar\s+o\s+contrato|or[çc]amento|quanto\s+custa|qual\s+o\s+pre[çc]o|parceria|proposta|assinar|compromisso)\b/i,
  ];

  public analyze(messageContent: string, recentHistorySummary: string = ''): RiskAnalysis {
    const text = messageContent.toLowerCase();
    const flags: string[] = [];
    const reasons: string[] = [];

    // 1. Check prompt injection (H12)
    let promptInjectionDetected = false;
    for (const pattern of this.injectionPatterns) {
      if (pattern.test(messageContent)) {
        promptInjectionDetected = true;
        flags.push('PROMPT_INJECTION_SUSPECT');
        reasons.push('Tentativa de manipulação de instruções ou prompt injection detectada.');
        break;
      }
    }

    if (promptInjectionDetected) {
      return {
        riskLevel: 3,
        safetyFlags: flags,
        reasons,
        promptInjectionDetected: true,
        isSensitiveTopic: true,
        requiresHumanReview: true,
      };
    }

    // 2. Check Level 3 categories (Money, Health, Legal, Conflict, Emotion)
    let isLevel3 = false;

    if (this.moneyPatterns.some((p) => p.test(text))) {
      flags.push('FINANCIAL_RISK');
      reasons.push('Menção a finanças, transferências ou pagamentos.');
      isLevel3 = true;
    }

    if (this.healthPatterns.some((p) => p.test(text))) {
      flags.push('HEALTH_SENSITIVE');
      reasons.push('Menção a questões de saúde ou médicas.');
      isLevel3 = true;
    }

    if (this.legalPatterns.some((p) => p.test(text))) {
      flags.push('LEGAL_SENSITIVE');
      reasons.push('Menção a questões jurídicas ou processuais.');
      isLevel3 = true;
    }

    if (this.conflictAndEmotionPatterns.some((p) => p.test(text))) {
      flags.push('EMOTIONAL_CONFLICT');
      reasons.push('Sinais de conflito interpessoal ou sofrimento emocional.');
      isLevel3 = true;
    }

    if (isLevel3) {
      return {
        riskLevel: 3,
        safetyFlags: flags,
        reasons,
        promptInjectionDetected: false,
        isSensitiveTopic: true,
        requiresHumanReview: true,
      };
    }

    // 3. Check Level 2 categories (Invitations, meetings, contracts, negotiations)
    if (this.moderatePatterns.some((p) => p.test(text))) {
      flags.push('MODERATE_COMMITMENT');
      reasons.push('Convite, agendamento de reunião ou negociação comercial.');
      return {
        riskLevel: 2,
        safetyFlags: flags,
        reasons,
        promptInjectionDetected: false,
        isSensitiveTopic: false,
        requiresHumanReview: true,
      };
    }

    // 4. Check Level 0 (Saudações, confirmações e agradecimentos)
    const isGreetingOrThanks =
      /\b(oi|ol[áa]|bom\s+dia|boa\s+tarde|boa\s+noite|valeu|obrigado|obrigada|show|beleza|tranquilo|t[áa]\s+bom|combinado)\b/i.test(text.trim()) &&
      text.split(/\s+/).length <= 6;
    if (isGreetingOrThanks) {
      return {
        riskLevel: 0,
        safetyFlags: [],
        reasons: ['Saudação, agradecimento ou confirmação casual.'],
        promptInjectionDetected: false,
        isSensitiveTopic: false,
        requiresHumanReview: false,
      };
    }

    // Default to Level 1 for general inquiries and ongoing conversation
    return {
      riskLevel: 1,
      safetyFlags: [],
      reasons: ['Conversa ou consulta padrão de baixo risco.'],
      promptInjectionDetected: false,
      isSensitiveTopic: false,
      requiresHumanReview: false,
    };
  }
}
