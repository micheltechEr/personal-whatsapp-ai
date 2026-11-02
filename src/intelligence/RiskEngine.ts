import { RiskLevel } from '../types/index.js';
import { JevClassifierClient, JevEvaluationResult } from './JevClassifierClient.js';

export interface RiskAnalysis {
  riskLevel: RiskLevel;
  safetyFlags: string[];
  reasons: string[];
  promptInjectionDetected: boolean;
  isSensitiveTopic: boolean;
  requiresHumanReview: boolean;
  jevEvaluation?: JevEvaluationResult;
}

export class RiskEngine {
  constructor(private jevClient?: JevClassifierClient) {}
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
    /\b(pix|chave\s+pix|transfer[êe]ncia\s+banc[áa]ria|ted|doc|dep[óo]sito\s+em\s+conta|conta\s+banc[áa]ria|empr[ée]stimo|fatura\s+do\s+cart[ãa]o|cart[ãa]o\s+de\s+cr[ée]dito|cvv|\d+\s*reais|\bR\$\s*\d+|quantos\s+d[óo]lares)\b/i,
  ];

  private healthPatterns: RegExp[] = [
    /\b(rem[ée]dio|medicamento|diagn[óo]stico|sintoma|hospital|m[ée]dico|cirurgia|depress[ãa]o|suic[íi]dio|dor\s+no\s+peito|tratamento\s+m[ée]dico)\b/i,
  ];

  private legalPatterns: RegExp[] = [
    /\b(advogado|processo\s+judicial|juiz|intima[çc][ãa]o|audi[êe]ncia\s+judicial|contrato\s+social|notifica[çc][ãa]o\s+extrajudicial|boletim\s+de\s+ocorr[êe]ncia|mandado\s+de\s+pris[ãa]o)\b/i,
  ];

  private conflictAndEmotionPatterns: RegExp[] = [
    /\b(odeio\s+voc[êe]|terminar\s+o\s+namoro|div[óo]rcio|vamos\s+nos\s+separar|briga|brigando|brigados|trai[çc][ãa]o|traiu|chorando|n[ãa]o\s+aguento\s+mais|amante|magoado|magoada)\b/i,
  ];

  // Patterns for Level 2: Commitments, invitations, negotiations, sensitive preferences
  private moderatePatterns: RegExp[] = [
    /\b(vamos\s+almo[çc]ar|podemos\s+marcar\s+uma\s+reuni[ãa]o|fechar\s+o\s+contrato|qual\s+o\s+valor\s+do\s+or[çc]amento|quanto\s+custa\s+o\s+servi[çc]o|qual\s+o\s+pre[çc]o|fechar\s+parceria|assinar\s+o\s+contrato)\b/i,
  ];

  public async analyzeAsync(messageContent: string, recentHistorySummary: string = ''): Promise<RiskAnalysis> {
    const baseAnalysis = this.analyze(messageContent, recentHistorySummary);

    // Se já foi categorizado como Nível 3 pelas regras locais, preserva bloqueio imediato
    if (baseAnalysis.riskLevel === 3) {
      return baseAnalysis;
    }

    // Consulta classificador neural Jev para validação profunda
    if (this.jevClient && this.jevClient.isAvailable()) {
      const jevResult = await this.jevClient.evaluate(messageContent);
      if (jevResult) {
        if (jevResult.isAttackOrProbing) {
          return {
            riskLevel: 3,
            safetyFlags: [...baseAnalysis.safetyFlags, 'PROMPT_INJECTION_SUSPECT', 'JEV_ATTACK_DETECTED'],
            reasons: [
              ...baseAnalysis.reasons,
              `Jev Classifier detectou ataque/sondagem (score=${jevResult.promptInjectionScore}, intent=${jevResult.intent})`,
            ],
            promptInjectionDetected: true,
            isSensitiveTopic: true,
            requiresHumanReview: true,
            jevEvaluation: jevResult,
          };
        }

        // Se o Jev indicar risco alto (>= 2.0)
        if (jevResult.riskScore >= 2.0 && baseAnalysis.riskLevel < 2) {
          return {
            ...baseAnalysis,
            riskLevel: 2,
            safetyFlags: [...baseAnalysis.safetyFlags, 'JEV_MODERATE_RISK'],
            reasons: [...baseAnalysis.reasons, `Jev Classifier classificou risco como moderado (${jevResult.riskScore})`],
            requiresHumanReview: true,
            jevEvaluation: jevResult,
          };
        }

        return {
          ...baseAnalysis,
          jevEvaluation: jevResult,
        };
      }
    }

    return baseAnalysis;
  }

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
