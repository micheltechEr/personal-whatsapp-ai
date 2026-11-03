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

import { VisionStickerInterpreter } from './VisionStickerInterpreter.js';

import { StorageAdapter } from '../storage/StorageAdapter.js';

export class ResponseGenerator {
  private llmClient: AgnosticLLMClient;
  private visionInterpreter: VisionStickerInterpreter;

  constructor(
    private personalityEngine: PersonalityEngine,
    config?: LLMClientConfig,
    private hybridInterpreter?: HybridHeuristicInterpreter,
    private styleRAG?: OwnerStyleRAG,
    visionInterpreter?: VisionStickerInterpreter,
    private storage?: StorageAdapter
  ) {
    this.llmClient = new AgnosticLLMClient(config);
    this.visionInterpreter = visionInterpreter || new VisionStickerInterpreter(config);
  }

  public setStorage(storage: StorageAdapter): void {
    this.storage = storage;
  }

  private async generateWithLLM(
    messageText: string,
    contextSummary: string,
    relationship: string,
    contactId?: string,
    contactName?: string,
    gender?: string,
    explicitReferencedMessage?: ConversationContext['explicitReferencedMessage']
  ): Promise<string | null> {
    const ownerName = this.personalityEngine.getOwnerName();
    let ragFewShotSection = '';
    let styleGuidance = `- Tom: direto, conciso, WhatsApp natural, sem formalismo artificial.`;

    if (this.styleRAG && contactId) {
      const ragContext = this.styleRAG.retrieveStyleContext(messageText, contactId, 4);
      if (ragContext.fewShotExamples.length > 0) {
        const examplesText = ragContext.fewShotExamples
          .map((ex) => `Contato: "${ex.inboundText}" -> ${ownerName} respondeu: "${ex.ownerReplyText}"`)
          .join('\n');

        ragFewShotSection = `\n\nEXEMPLOS REAIS DE COMO ${ownerName.toUpperCase()} RESPONDE NO WHATSAPP (RAG):\n${examplesText}\nImite exatamente a cadência, tom informal, abreviações e concisão desses exemplos acima.`;
      }

      const { averageWordCount, frequentSlang, lowercaseRatio } = ragContext.metrics;
      styleGuidance += `\n- Média de palavras de ${ownerName}: cerca de ${averageWordCount} palavras por resposta.`;
      if (frequentSlang.length > 0) {
        styleGuidance += `\n- Gírias/abreviações típicas de ${ownerName}: ${frequentSlang.join(', ')}.`;
      }
      if (lowercaseRatio > 0.5) {
        styleGuidance += `\n- Preferir respostas sem formalidade, com estilo casual de chat.`;
      }
    }

    let vocativeGuidance = '';
    if (relationship === 'romantic') {
      vocativeGuidance = `\n- RELAÇÃO ROMÂNTICA / PARCEIRA: Trate com afeto e carinho de relacionamento. Proibido chamar de "mano", "vei", "cara", "brother".`;
    } else {
      vocativeGuidance = `\n- RELAÇÃO NÃO-ROMÂNTICA: É TOTALMENTE PROIBIDO usar "amor", "vida", "meu bem", "linda", "bebê", "mozão" ou qualquer termo carinhoso romântico.`;
      if (gender === 'feminine') {
        vocativeGuidance += `\n- INTERLOCUTORA FEMININA (${contactName || 'Mulher'}): Proibido chamar de "mano", "vei", "cara", "brother", "parça". Trate de forma neutra, simpática e educada pelo nome ou sem vocativo.`;
      } else if (gender === 'neutral') {
        vocativeGuidance += `\n- INTERLOCUTOR NEUTRO / NÃO IDENTIFICADO: Evite vocativos de gênero. Responda diretamente sem colocar "mano", "vei", "cara" nem apelidos íntimos.`;
      } else if (gender === 'masculine') {
        vocativeGuidance += `\n- INTERLOCUTOR MASCULINO (${contactName || 'Homem'}): Pode usar "mano", "vei" se o contexto for casual entre amigos.`;
      }
    }

    // Se houver referência explícita de mensagem citada (contextInfo.stanzaId), enriquece o prompt do LLM
    let explicitReferencePrompt = '';
    if (explicitReferencedMessage) {
      explicitReferencePrompt = `\n- REFERÊNCIA EXPLÍCITA DE CONVERSA CITADA (contextInfo): O contato marcou/citou uma mensagem anterior específica no WhatsApp:\n  Mensagem citada: "${explicitReferencedMessage.original.content}"\n  Vizinhança da conversa na época: ${explicitReferencedMessage.surroundingContext}\n  O contato enviou agora: "${messageText}".\n  Avalie se o contato está cobrando uma resposta, retomando um assunto pendente ou confirmando algo daquela época, e responda com total precisão contextual.`;
    }

    // Fatos Pessoais e Curiosidades Absolutas (Injetadas da aba de Curiosidades do Cockpit)
    let ownerFactsPrompt = '';
    if (this.storage) {
      const facts = await this.storage.getOwnerFacts();
      if (facts.length > 0) {
        const factList = facts.map((f) => `- [${f.topic}]: ${f.fact}`).join('\n');
        ownerFactsPrompt = `\n\nFATOS PESSOAIS ABSOLUTOS E VERDADES SOBRE ${ownerName.toUpperCase()} (NUNCA CONTRADIGA ESSES FATOS):\n${factList}\nSE PERGUNTAREM OU TOCAREM EM ASSUNTOS COMO RELACIONAMENTO, TRABALHO OU VIDA PESSOAL, SIGA RIGOROSAMENTE ESSES FATOS ACIMA. NUNCA INVENTE QUE ESTÁ SOLTEIRO OU QUE NÃO NAMORA SE ESTIVER CADASTRADO QUE NAMORA.`;
      }
    }

    const systemPrompt = `Você é ${ownerName} conversando no seu WhatsApp pessoal.
Você NUNCA deve responder como robô assistente nem usar padrões engessados ou forçados.

DIRETRIZES DE NATURALIDADE E PERSONALIDADE POR CONVERSA:
- ADAPTAÇÃO AO INTERLOCUTOR: Interlocutor: ${contactName || 'Contato'} (Gênero: ${gender || 'neutro'}, Relação: ${relationship}).
- VOCATIVOS CONTROLADOS:${vocativeGuidance}
- PROIBIÇÃO DE RISADA FORÇADA: NUNCA coloque "kkk", "kkkk", "llkkk" ou risadas automáticas no fim de mensagens afirmativas (como "Beleza", "Show", "Valeu", "Tranquilo"). SÓ use risada se o interlocutor tiver feito uma piada genuína, enviado meme ou rido antes. Não force simpatia artificial.
- COERÊNCIA CONTEXTUAL: Preste muita atenção em quem está falando e ao sujeito da ação. Se a pessoa diz "Demora pra achar figurinha", ela está justificando a si mesma, não você. Não peça desculpas nem assuma ações alheias.${explicitReferencePrompt}${ownerFactsPrompt}
- CONCISÃO NATURAL: Responda exatamente como uma pessoa real responde no WhatsApp: 1 frase curta, objetiva, sem enrolação.
${styleGuidance}
- Contexto recente da conversa: ${contextSummary || 'Início de conversa'}${ragFewShotSection}

Gere APENAS a resposta final como ${ownerName} enviaria no WhatsApp.`;

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
    // Se for figurinha COM imagem base64, NÃO silencia cegamente: envia para interpretação visual antes
    const isStickerWithImage = message.type === 'sticker' && Boolean(message.mediaBase64);

    if (!intent.requiresResponse && !isStickerWithImage) {
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
        suggested = '';
      } else if (matchedFact) {
        suggested = `${matchedFact}`;
      } else {
        // Tenta gerar com LLM baseado no histórico real da conversa
        const generated = await this.generateWithLLM(
          message.content,
          context.recentSummary,
          context.contactMemory.relationship,
          message.contactId,
          context.contactName || context.contactMemory.name,
          context.contactMemory.gender,
          context.explicitReferencedMessage
        );
        if (!generated || generated.trim().length === 0) {
          decision = 'REVIEW_REQUIRED';
          reason = 'H05: Sem resposta factual segura; enviado para revisão.';
          suggested = '';
        } else {
          suggested = generated;
        }
      }
    } else if (message.type === 'sticker' && message.mediaBase64) {
      // Vision Mode: Interpreta a figurinha e responde com inteligência contextual
      const stickerInfo = await this.visionInterpreter.interpretSticker(
        message.mediaBase64,
        message.mimetype || 'image/webp',
        context.recentSummary
      );

      if (stickerInfo) {
        if (stickerInfo.isReactionOnly) {
          // Se for só uma reação sem conteúdo a ser estendido, aplica silêncio inteligente
          return DecisionContractSchema.parse({
            message_id: message.id,
            contact_id: message.contactId,
            intent: 'STICKER_SILENT_REACTION',
            risk_level: 0,
            decision: 'IGNORE',
            confidence: { intent: 98, context: 95, factual: 99, response: 95 },
            context_summary: `Figurinha/GIF recebido: ${stickerInfo.description}`,
            reason: `Figurinha/GIF de reação visual rápida (${stickerInfo.description}) sem necessidade de réplica.`,
            suggested_response: '',
            safety_flags: [],
            requires_human: false,
            memory_candidates: [],
            operational_action: 'IGNORAR',
          });
        }

        // Gera uma resposta natural baseada no que está desenhado/escrito na figurinha
        const promptSticker = `O contato enviou esta figurinha ou GIF no chat: "${stickerInfo.description}" (emoção/tom: ${stickerInfo.emotion}).`;
        const generated = await this.generateWithLLM(
          promptSticker,
          context.recentSummary,
          context.contactMemory.relationship,
          message.contactId,
          context.contactName || context.contactMemory.name,
          context.contactMemory.gender
        );
        suggested = generated || stickerInfo.suggestedReaction || 'Kkkkk boa';
      } else {
        // Se a interpretação falhar, silêncio inteligente padrão
        return DecisionContractSchema.parse({
          message_id: message.id,
          contact_id: message.contactId,
          intent: 'MEDIA_SHARE_NO_TEXT',
          risk_level: 0,
          decision: 'IGNORE',
          confidence: { intent: 95, context: 90, factual: 90, response: 90 },
          context_summary: context.recentSummary,
          reason: 'H03: Figurinha ou GIF recebido sem texto associado.',
          suggested_response: '',
          safety_flags: [],
          requires_human: false,
          memory_candidates: [],
          operational_action: 'IGNORAR',
        });
      }
    } else if (intent.intent === 'GREETING') {
      suggested = this.personalityEngine.getGreeting(context.contactMemory.relationship);
    } else {
      // Try agnostic LLM response (OmniRoute / OpenAI / Gemini proxy) com RAG de Estilo
      const generated = await this.generateWithLLM(
        message.content,
        context.recentSummary,
        context.contactMemory.relationship,
        message.contactId,
        context.contactName || context.contactMemory.name,
        context.contactMemory.gender,
        context.explicitReferencedMessage
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
