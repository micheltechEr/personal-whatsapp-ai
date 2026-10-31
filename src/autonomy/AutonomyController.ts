import { DecisionContract, DecisionType, ContactMemory } from '../types/index.js';

export interface AutonomyConfig {
  globalMode: 'AUTONOMOUS_CONTROLLED' | 'MANUAL_ONLY' | 'EMERGENCY_STOP';
  minConfidenceThreshold: number; // default 90 for Level 0/1 auto reply
  minReviewThreshold: number; // default 75
  maxDailyAutoRepliesDefault: number;
}

export interface FinalAutonomyEvaluation {
  allowedAction: DecisionType;
  passedSafety: boolean;
  blockedReason?: string;
  recalculatedConfidence: number;
}

export class AutonomyController {
  private config: AutonomyConfig;

  constructor(customConfig?: Partial<AutonomyConfig>) {
    this.config = {
      globalMode: 'AUTONOMOUS_CONTROLLED',
      minConfidenceThreshold: 50, // Responde autonomamente se >= 50%
      minReviewThreshold: 30, // Exige humano apenas se < 30%
      maxDailyAutoRepliesDefault: Number(process.env.MAX_DAILY_AUTO_REPLIES) || 30,
      ...customConfig,
    };
  }

  public setGlobalMode(mode: AutonomyConfig['globalMode']): void {
    this.config.globalMode = mode;
  }

  public getGlobalMode(): AutonomyConfig['globalMode'] {
    return this.config.globalMode;
  }

  public setMaxDailyAutoReplies(limit: number): void {
    if (limit > 0) {
      this.config.maxDailyAutoRepliesDefault = limit;
    }
  }

  public getMaxDailyAutoReplies(): number {
    return this.config.maxDailyAutoRepliesDefault;
  }

  public evaluate(
    proposal: DecisionContract,
    contactMemory: ContactMemory
  ): FinalAutonomyEvaluation {
    // 1. Precedence: Global Exclusion Rules
    if (this.config.globalMode === 'EMERGENCY_STOP') {
      return {
        allowedAction: 'HUMAN_ONLY',
        passedSafety: false,
        blockedReason: 'Botão de emergência ativo (EMERGENCY_STOP). Todos os envios automáticos bloqueados.',
        recalculatedConfidence: 0,
      };
    }

    if (this.config.globalMode === 'MANUAL_ONLY') {
      return {
        allowedAction: 'REVIEW_REQUIRED',
        passedSafety: true,
        blockedReason: 'Sistema configurado em modo MANUAL_ONLY.',
        recalculatedConfidence: proposal.confidence.response,
      };
    }

    if (contactMemory.blocked) {
      return {
        allowedAction: 'IGNORE',
        passedSafety: false,
        blockedReason: 'Contato marcado como bloqueado na memória operacional.',
        recalculatedConfidence: 0,
      };
    }

    if (!contactMemory.autoReplyAllowed) {
      return {
        allowedAction: 'REVIEW_REQUIRED',
        passedSafety: true,
        blockedReason: 'Resposta automática desabilitada especificamente para este contato.',
        recalculatedConfidence: proposal.confidence.response,
      };
    }

    // Daily limit check per contact
    // Se o contato tiver limite customizado diferente do default antigo 5, respeita; caso contrário usa o limite global configurado
    const limit = this.config.maxDailyAutoRepliesDefault;
    if (contactMemory.autoRepliesToday >= limit) {
      return {
        allowedAction: 'REVIEW_REQUIRED',
        passedSafety: true,
        blockedReason: `Limite diário de respostas automáticas atingido (${contactMemory.autoRepliesToday}/${limit}).`,
        recalculatedConfidence: proposal.confidence.response,
      };
    }

    // 2. Precedence: Safety Rules (Prompt Injection & Critical Flags)
    const flags = proposal.safety_flags || (proposal as any).safetyFlags || [];
    if (flags.includes('PROMPT_INJECTION_SUSPECT')) {
      return {
        allowedAction: 'HUMAN_ONLY',
        passedSafety: false,
        blockedReason: 'Violação de segurança: suspeita de prompt injection detectada.',
        recalculatedConfidence: 0,
      };
    }

    // 3. Precedence: Risk Classification (Deterministic)
    // Low risk NEVER overrides safety rules. Level 3 is strictly human only!
    if (proposal.risk_level === 3 || proposal.requires_human) {
      return {
        allowedAction: 'HUMAN_ONLY',
        passedSafety: true,
        blockedReason: `Risco nível 3 ou exigência humana mandatória (${proposal.reason}).`,
        recalculatedConfidence: proposal.confidence.response,
      };
    }

    if (proposal.risk_level === 2) {
      return {
        allowedAction: 'REVIEW_REQUIRED',
        passedSafety: true,
        blockedReason: 'Risco moderado (nível 2): requer aprovação humana antes do envio.',
        recalculatedConfidence: proposal.confidence.response,
      };
    }

    // 4. Precedence: Confidence Dimensions Check
    const { intent, context, factual, response } = proposal.confidence;
    const minEssential = Math.min(intent, context, factual, response);

    // Se confiança for menor que 50%, envia para revisão
    if (minEssential < this.config.minConfidenceThreshold) {
      return {
        allowedAction: 'REVIEW_REQUIRED',
        passedSafety: true,
        blockedReason: `Confiança baixa (${minEssential}% <= ${this.config.minConfidenceThreshold}%): enviado para revisão.`,
        recalculatedConfidence: minEssential,
      };
    }

    // 5. If original proposal was IGNORE, maintain IGNORE
    if (proposal.decision === 'IGNORE' && proposal.intent !== 'CASUAL_CONVERSATION' && proposal.intent !== 'QUESTION_SIMPLE') {
      return {
        allowedAction: 'IGNORE',
        passedSafety: true,
        blockedReason: proposal.reason,
        recalculatedConfidence: minEssential,
      };
    }

    // 6. Passed all gates: eligible for autonomous dispatch!
    return {
      allowedAction: 'AUTO_REPLY',
      passedSafety: true,
      recalculatedConfidence: minEssential,
    };
  }
}
