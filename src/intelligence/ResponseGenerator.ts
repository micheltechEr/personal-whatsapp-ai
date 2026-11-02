import { AgnosticLLMClient, LLMClientConfig } from './AgnosticLLMClient.js';
import { HybridHeuristicInterpreter } from './HybridHeuristicInterpreter.js';
import { OwnerStyleRAG } from './OwnerStyleRAG.js';
import {
  DecisionContract,
  DecisionContractSchema,
  ConfidenceScores,
  NormalizedMessage,
  DecisionType,
} from '../types/index.js';
import { ConversationContext } from './ContextEngine.js';
import { RiskAnalysis } from './RiskEngine.js';
import { IntentAnalysis } from './IntentClassifier.js';
import { PersonalityEngine } from './PersonalityEngine.js';

export class ResponseGenerator {
  private llmClient: AgnosticLLMClient;

  constructor(
    private personalityEngine: PersonalityEngine,
    config?: LLMClientConfig,
    private hybridInterpreter?: HybridHeuristicInterpreter,
    private styleRAG?: OwnerStyleRAG
  ) {
    this.llmClient = new AgnosticLLMClient(config);
  }

  private async generateWithLLM(
    messageText: string,
    contextSummary: string,
    relationship: string,
    contactId?: string
  ): Promise<string | null> {
    let ragFewShotSection = '';
    let styleGuidance = '- Tom: direto, conciso, gírias normais de WhatsApp (ex: kkk, pow, mano, blz), sem formalismo.';

    if (this.styleRAG && contactId) {
      const ragContext = this.styleRAG.retrieveStyleContext(messageText, contactId, 4);
      if (ragContext.fewShotExamples.length > 0) {
        const examplesText = ragContext.fewShotExamples
          .map((ex) => `Contato: "${ex.inboundText}" -> Ângelo respondeu: "${ex.ownerReplyText}"`)
          .join('\n');

        ragFewShotSection = `\n\nEXEMPLOS REAIS DE COMO O ÂNGELO RESPONDE NO WHATSAPP (RAG):\n${examplesText}\nImite exatamente a cadência, tom informal, abreviações e concisão desses exemplos acima.`;
      }

      const { averageWordCount, frequentSlang, lowercaseRatio } = ragContext.metrics;
      styleGuidance += `\n- Média de palavras do Ângelo: cerca de ${averageWordCount} palavras por resposta.`;
      if (frequentSlang.length > 0) {
        styleGuidance += `\n- Gírias/abreviações típicas do Ângelo: ${frequentSlang.join(', ')}.`;
      }
      if (lowercaseRatio > 0.5) {
        styleGuidance += `\n- Preferir respostas sem formalidade, com estilo casual de chat.`;
      }
    }

    let relationshipVocatives = '';
    if (relationship === 'romantic') {
      relationshipVocatives = `\n- RELAÇÃO ROMÂNTICA / NAMORADA: É TOTALMENTE PROIBIDO usar "mano", "vei", "cara", "irmão", "brother", "parça". Responda com afeto de namorado (ex: "amor", "vida", "linda" ou tom carinhoso). Jamais use gírias masculinas de amigos.`;
    } else if (relationship === 'family') {
      relationshipVocatives = `\n- RELAÇÃO FAMILIAR: Proibido usar "mano", "vei" ou gírias de rua. Trate com respeito e carinho.`;
    }

    const systemPrompt = `Você é o Ângelo conversando no seu WhatsApp pessoal com seus amigos/contatos.
Você NUNCA deve responder como robô ou assistente genérico ("Opa, tudo bem? Tudo certo por aqui, e contigo?").
Regras de interpretação e estilo:
${styleGuidance}${relationshipVocatives}
- ATENÇÃO À COERÊNCIA CONTEXTUAL: Interprete quem é o sujeito da ação observando o histórico recente. Se a pessoa falar "Demora pra achar figurinha", "Demora pra responder", etc., ela está justificando a própria ação ou comentando o que ela mesma fez, NÃO você. Não assuma a culpa nem responda como se você estivesse procurando o que o contato procurou.
- Reaja diretamente e com naturalidade ao que a pessoa disse (ex: "kkkk achou?", "mandou logo essa", "valeu a pena kkk").
- Proibido usar jargões de assistente virtual ou saudações prontas engessadas.
- Relação com interlocutor: ${relationship}
- Contexto recente da conversa: ${contextSummary || 'Início de conversa'}${ragFewShotSection}

Gere APENAS a resposta final curta (1 frase no máximo) exatamente como o Ângelo enviaria no WhatsApp.`;

    return this.llmClient.complete([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: messageText },
    ]);
  }

  public async generateDecision(
    message: NormalizedMessage,
    context: ConversationContext,
    risk: RiskAnalysis,
    intent: IntentAnalysis
  ): Promise<DecisionContract> {
    const isOwner = message.fromMe;

    // H15: Se a mensagem em si veio do proprietário ou proprietário acabou de intervir na mesma janela
    if (isOwner || context.ownerSentManualReplyRecently) {
      return DecisionContractSchema.parse({
        message_id: message.id,
        contact_id: message.contactId,
        intent: 'OWNER_ACTIVITY_DETECTED',
        risk_level: risk.riskLevel,
        decision: 'IGNORE',
        confidence: { intent: 99, context: 99, factual: 99, response: 99 },
        context_summary: 'Proprietário interagiu diretamente na conversa.',
        reason: 'H15: Proprietário já respondeu manualmente ou é autor da mensagem.',
        suggested_response: '',
        safety_flags: [],
        requires_human: false,
        memory_candidates: [],
        operational_action: 'IGNORAR',
      });
    }

    // H03: Intelligent silence
    if (!intent.requiresResponse) {
      return DecisionContractSchema.parse({
        message_id: message.id,
        contact_id: message.contactId,
        intent: intent.intent,
        risk_level: risk.riskLevel,
        decision: 'IGNORE',
        confidence: {
          intent: intent.confidence,
          context: context.contextConfidence,
          factual: 98,
          response: 95,
        },
        context_summary: context.recentSummary,
        reason: 'H03: Mensagem não exige resposta (agradecimento conclusivo, confirmação ou mídia sem texto).',
        suggested_response: '',
        safety_flags: risk.safetyFlags,
        requires_human: false,
        memory_candidates: [],
        operational_action: intent.operationalAction,
      });
    }

    // Level 0 or 1 baseline
    let suggested = '';
    let factualConfidence = 95;
    let responseConfidence = 94;
    let decision: DecisionType = 'AUTO_REPLY';
    let reason = 'Mensagem de baixo risco elegível para resposta autônoma.';

    // Hybrid keyword search interpretation
    let hybridBoost = 0;
    const safetyFlags = [...risk.safetyFlags];
    let hybridReason = '';

    if (this.hybridInterpreter) {
      const hybridRes = await this.hybridInterpreter.interpret(message.content);
      hybridBoost = hybridRes.confidenceBoost;
      if (hybridRes.flags.length > 0) {
        safetyFlags.push(...hybridRes.flags);
      }
      if (hybridRes.reasons.length > 0) {
        hybridReason = ` | Heurística híbrida: ${hybridRes.reasons.join('; ')}`;
      }

      if (hybridRes.suggestedAction === 'HUMAN_ONLY') {
        return DecisionContractSchema.parse({
          message_id: message.id,
          contact_id: message.contactId,
          intent: intent.intent,
          risk_level: 3,
          decision: 'HUMAN_ONLY',
          confidence: { intent: intent.confidence, context: context.contextConfidence, factual: 90, response: 30 },
          context_summary: context.recentSummary,
          reason: `Bloqueio por regra de palavras: ${hybridRes.reasons.join('; ')}`,
          suggested_response: '',
          safety_flags: safetyFlags,
          requires_human: true,
          memory_candidates: [],
          operational_action: intent.operationalAction,
        });
      }

      if (hybridRes.suggestedAction === 'REVIEW_REQUIRED' && risk.riskLevel < 2) {
        decision = 'REVIEW_REQUIRED';
        reason = `Palavra-chave cadastrada exige revisão humana: ${hybridRes.reasons.join('; ')}`;
      }
    }

    // High Risk (Level 3) -> STRICT HUMAN ONLY
    if (risk.riskLevel === 3) {
      return DecisionContractSchema.parse({
        message_id: message.id,
        contact_id: message.contactId,
        intent: intent.intent,
        risk_level: 3,
        decision: 'HUMAN_ONLY',
        confidence: {
          intent: intent.confidence,
          context: context.contextConfidence,
          factual: 95,
          response: 50,
        },
        context_summary: context.recentSummary,
        reason: risk.reasons.join('; '),
        suggested_response: '',
        safety_flags: risk.safetyFlags,
        requires_human: true,
        memory_candidates: [],
        operational_action: intent.operationalAction,
      });
    }

    // Moderate Risk (Level 2) -> REVIEW REQUIRED
    if (risk.riskLevel === 2) {
      const suggested = `Oi! Recebi aqui. Vou verificar minha agenda/detalhes e te retorno em breve, combinado?`;
      return DecisionContractSchema.parse({
        message_id: message.id,
        contact_id: message.contactId,
        intent: intent.intent,
        risk_level: 2,
        decision: 'REVIEW_REQUIRED',
        confidence: {
          intent: intent.confidence,
          context: context.contextConfidence,
          factual: 85,
          response: 82,
        },
        context_summary: context.recentSummary,
        reason: 'Assunto moderado (compromisso, negociação ou solicitação pessoal) exige aprovação do proprietário.',
        suggested_response: suggested,
        safety_flags: risk.safetyFlags,
        requires_human: true,
        memory_candidates: [],
        operational_action: intent.operationalAction,
      });
    }

    // Level 0 or 1: Low risk. Check context sufficiency (H05)
    // H05 / H06: If complex contextual question without facts in memory or history
    if (intent.intent === 'QUESTION_CONTEXTUAL') {
      // Check if answer is in contact memory notes
      const matchedFact = context.contactMemory.notes.find((n) =>
        message.content.toLowerCase().split(/\s+/).some((w) => w.length > 4 && n.toLowerCase().includes(w))
      );

      if (!matchedFact && context.recentMessages.length < 2) {
        // H05: Insufficient context -> DO NOT INVENT, demand review!
        decision = 'REVIEW_REQUIRED';
        reason = 'H05: Faltam informações factuais no histórico/memória para responder com segurança.';
        factualConfidence = 60;
        responseConfidence = 65;
        suggested = `Oi! Estou verificando isso e te respondo logo mais.`;
      } else {
        suggested = matchedFact
          ? `Oi! Conforme alinhamos: ${matchedFact}.`
          : `Tudo bem por aqui! Estou acompanhando.`;
      }
    } else if (intent.intent === 'GREETING') {
      suggested = this.personalityEngine.getGreeting(context.contactMemory.relationship);
    } else {
      // Try agnostic LLM response (OmniRoute / OpenAI / Gemini proxy) com RAG de Estilo
      const generated = await this.generateWithLLM(
        message.content,
        context.recentSummary,
        context.contactMemory.relationship,
        message.contactId
      );

      // Fallback para conversas ultra curtas caso o LLM demore ou não retorne
      if (!generated || generated.trim().length === 0) {
        if (intent.intent === 'GREETING') {
          suggested = 'Opa, tudo bem?';
        } else if (intent.intent === 'CASUAL_CONVERSATION') {
          suggested = 'De boa por aqui!';
        } else {
          return DecisionContractSchema.parse({
            message_id: message.id,
            contact_id: message.contactId,
            intent: intent.intent,
            risk_level: 2,
            decision: 'REVIEW_REQUIRED',
            confidence: { intent: intent.confidence, context: context.contextConfidence, factual: 70, response: 60 },
            context_summary: context.recentSummary,
            reason: 'LLM não retornou resposta segura; enviado para revisão.',
            suggested_response: '',
            safety_flags: safetyFlags,
            requires_human: true,
            memory_candidates: [],
            operational_action: intent.operationalAction,
          });
        }
      } else {
        suggested = generated;
      }
    }

    // Formata a resposta: sempre filtra vocativos proibidos para relações românticas e família, e formalidade para trabalho
    suggested = this.personalityEngine.formatResponse(suggested, context.contactMemory);

    const contextConf = risk.riskLevel === 0 ? Math.max(context.contextConfidence, 95) : context.contextConfidence;

    const confidence: ConfidenceScores = {
      intent: Math.min(100, Math.max(0, intent.confidence + hybridBoost)),
      context: Math.min(100, Math.max(0, contextConf + hybridBoost)),
      factual: Math.min(100, Math.max(0, factualConfidence + hybridBoost)),
      response: Math.min(100, Math.max(0, responseConfidence + hybridBoost)),
    };

    return DecisionContractSchema.parse({
      message_id: message.id,
      contact_id: message.contactId,
      intent: intent.intent,
      risk_level: risk.riskLevel,
      decision,
      confidence,
      context_summary: context.recentSummary,
      reason: reason + hybridReason,
      suggested_response: suggested,
      safety_flags: safetyFlags,
      requires_human: decision !== 'AUTO_REPLY',
      memory_candidates: [],
      operational_action: intent.operationalAction,
    });
  }
}
