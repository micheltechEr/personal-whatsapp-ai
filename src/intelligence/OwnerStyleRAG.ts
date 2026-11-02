import { NormalizedMessage } from '../types/index.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';

export interface DialoguePair {
  id: string;
  contactId: string;
  inboundText: string;
  ownerReplyText: string;
  timestamp: number;
}

export interface ExtractedStyleMetrics {
  totalAnalyzedMessages: number;
  averageWordCount: number;
  lowercaseRatio: number; // 0 to 1
  frequentSlang: string[];
  frequentEmojis: string[];
  punctuateWithPeriodRatio: number;
}

export class OwnerStyleRAG {
  private dialoguePairs: DialoguePair[] = [];
  private commonSlangDictionary = [
    'vc',
    'tbm',
    'pow',
    'kkk',
    'kkkk',
    'kkkkk',
    'blz',
    'show',
    'opa',
    'valeu',
    'tranquilo',
    'mano',
    'vei',
    'dm',
    'eh',
    'nn',
    'pq',
    'pra',
    'pro',
    'tô',
    'to',
    'tá',
    'ta',
    'bora',
  ];

  constructor(private storage: StorageAdapter) {}

  public async init(): Promise<void> {
    // Carrega todo o histórico do armazenamento e constrói a base de conhecimento de pares (Mensagem do Contato -> Resposta Real do Dono)
    const allMessages = await this.storage.getRecentMessages('', 1000);
    this.rebuildIndex(allMessages);
  }

  public rebuildIndex(messages: NormalizedMessage[]): void {
    this.dialoguePairs = [];
    // Agrupa mensagens por contato
    const byContact = new Map<string, NormalizedMessage[]>();
    for (const m of messages) {
      if (!m.contactId) continue;
      const list = byContact.get(m.contactId) || [];
      list.push(m);
      byContact.set(m.contactId, list);
    }

    // Filtrar mensagens geradas automaticamente ou sintéticas para não poluir o aprendizado
    const isSyntheticOrBot = (text: string) => {
      const lower = text.toLowerCase().trim();
      return (
        lower === 'kkk de boa, e aí?' ||
        lower.startsWith('opa, tudo bem? tudo certo por aqui') ||
        lower.startsWith('oi! recebi aqui. vou verificar') ||
        lower === '[mensagem do sistema]'
      );
    };

    for (const [contactId, list] of byContact.entries()) {
      list.sort((a, b) => a.timestamp - b.timestamp);
      for (let i = 1; i < list.length; i++) {
        const previous = list[i - 1];
        const current = list[i];

        if (
          current.fromMe &&
          !previous.fromMe &&
          current.content &&
          previous.content &&
          !isSyntheticOrBot(current.content)
        ) {
          this.dialoguePairs.push({
            id: `pair-${current.id}`,
            contactId,
            inboundText: previous.content,
            ownerReplyText: current.content,
            timestamp: current.timestamp,
          });
        }
      }
    }
  }

  public indexOwnerMessage(ownerMsg: NormalizedMessage, previousContactMsg?: NormalizedMessage): void {
    if (!ownerMsg.fromMe || !ownerMsg.content) return;

    const lower = ownerMsg.content.toLowerCase().trim();
    if (
      lower === 'kkk de boa, e aí?' ||
      lower.startsWith('opa, tudo bem? tudo certo por aqui') ||
      lower.startsWith('oi! recebi aqui. vou verificar') ||
      lower === '[mensagem do sistema]'
    ) {
      return;
    }

    if (previousContactMsg && !previousContactMsg.fromMe && previousContactMsg.content) {
      this.dialoguePairs.push({
        id: `pair-${ownerMsg.id}`,
        contactId: ownerMsg.contactId,
        inboundText: previousContactMsg.content,
        ownerReplyText: ownerMsg.content,
        timestamp: ownerMsg.timestamp,
      });
    }
  }

  // Tokenização e normalização sem acentos
  private tokenize(str: string): string[] {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[\s,.;!?]+/)
      .filter((w) => w.length > 1);
  }

  // Similaridade de Jaccard e sobreposição de termos (RAG Léxico Híbrido)
  private computeSimilarity(query: string, target: string): number {
    const qTokens = new Set(this.tokenize(query));
    const tTokens = new Set(this.tokenize(target));
    if (qTokens.size === 0 || tTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of qTokens) {
      if (tTokens.has(token)) intersection++;
    }

    const union = new Set([...qTokens, ...tTokens]).size;
    return intersection / union;
  }

  /**
   * RAG: Recupera os melhores exemplos reais de como o proprietário respondeu a mensagens semelhantes.
   * Prioridade: 1) Histórico do mesmo contato; 2) Histórico global com maior similaridade semântica/léxica.
   */
  public retrieveStyleContext(
    currentInboundText: string,
    contactId: string,
    limit = 4
  ): {
    fewShotExamples: DialoguePair[];
    contactSpecificCount: number;
    metrics: ExtractedStyleMetrics;
  } {
    const scoredPairs = this.dialoguePairs.map((pair) => {
      let score = this.computeSimilarity(currentInboundText, pair.inboundText);
      // Boost de afinidade se o exemplo for do mesmo contato (preserva a intimidade/relação específica)
      const isSameContact = pair.contactId === contactId;
      if (isSameContact) {
        score += 0.35;
      }
      return { pair, score, isSameContact };
    });

    scoredPairs.sort((a, b) => b.score - a.score);

    const topMatches = scoredPairs.slice(0, limit);
    const fewShotExamples = topMatches.map((m) => m.pair);
    const contactSpecificCount = topMatches.filter((m) => m.isSameContact).length;

    const metrics = this.extractMetrics(this.dialoguePairs.map((d) => d.ownerReplyText));

    return {
      fewShotExamples,
      contactSpecificCount,
      metrics,
    };
  }

  /**
   * Analisa as mensagens do proprietário e extrai métricas linguísticas do seu estilo real.
   */
  public extractMetrics(ownerTexts: string[]): ExtractedStyleMetrics {
    // Exclui mensagens automáticas para cálculo limpo das métricas
    const cleanTexts = ownerTexts.filter((t) => {
      const lower = t.toLowerCase().trim();
      return (
        lower !== 'kkk de boa, e aí?' &&
        !lower.startsWith('opa, tudo bem? tudo certo por aqui') &&
        lower !== '[mensagem do sistema]'
      );
    });

    if (cleanTexts.length === 0) {
      return {
        totalAnalyzedMessages: 0,
        averageWordCount: 8,
        lowercaseRatio: 0.9,
        frequentSlang: ['blz', 'valeu', 'pow'],
        frequentEmojis: [],
        punctuateWithPeriodRatio: 0.1,
      };
    }

    let totalWords = 0;
    let lowercaseStarts = 0;
    let periodEnds = 0;
    const slangCounts = new Map<string, number>();
    const emojiRegex = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
    const emojiCounts = new Map<string, number>();

    for (const text of cleanTexts) {
      const words = text.trim().split(/\s+/);
      totalWords += words.length;

      // Verifica se começa com minúscula
      if (text.length > 0 && text[0] === text[0].toLowerCase() && text[0] !== text[0].toUpperCase()) {
        lowercaseStarts++;
      }

      // Verifica se finaliza com ponto final
      if (text.trim().endsWith('.')) {
        periodEnds++;
      }

      // Conta gírias
      const cleanTokens = this.tokenize(text);
      for (const token of cleanTokens) {
        if (this.commonSlangDictionary.includes(token)) {
          slangCounts.set(token, (slangCounts.get(token) || 0) + 1);
        }
      }

      // Conta emojis
      const emojis = text.match(emojiRegex);
      if (emojis) {
        for (const em of emojis) {
          emojiCounts.set(em, (emojiCounts.get(em) || 0) + 1);
        }
      }
    }

    const sortedSlang = Array.from(slangCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .slice(0, 8);

    const sortedEmojis = Array.from(emojiCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
      .slice(0, 5);

    return {
      totalAnalyzedMessages: ownerTexts.length,
      averageWordCount: Math.max(3, Math.round(totalWords / ownerTexts.length)),
      lowercaseRatio: Number((lowercaseStarts / ownerTexts.length).toFixed(2)),
      frequentSlang: sortedSlang,
      frequentEmojis: sortedEmojis,
      punctuateWithPeriodRatio: Number((periodEnds / ownerTexts.length).toFixed(2)),
    };
  }
}
