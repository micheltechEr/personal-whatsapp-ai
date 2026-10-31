import { HeuristicKeywordRule } from '../types/index.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';

export interface HybridInterpretationResult {
  matchedRules: Array<{
    rule: HeuristicKeywordRule;
    matchType: 'exact' | 'fuzzy';
    score: number;
    token: string;
  }>;
  suggestedAction: 'AUTO_REPLY' | 'REVIEW_REQUIRED' | 'HUMAN_ONLY' | 'NEUTRAL';
  confidenceBoost: number; // e.g. +20, -30
  flags: string[];
  reasons: string[];
}

export class HybridHeuristicInterpreter {
  // Built-in starter dictionary
  private defaultRules: HeuristicKeywordRule[] = [
    { id: 'def-1', word: 'preço', category: 'high_confidence', weight: 95, description: 'Consulta comercial direta' },
    { id: 'def-2', word: 'orçamento', category: 'high_confidence', weight: 95, description: 'Consulta de orçamento' },
    { id: 'def-3', word: 'portfólio', category: 'high_confidence', weight: 95, description: 'Interesse em trabalhos' },
    { id: 'def-4', word: 'site', category: 'high_confidence', weight: 90, description: 'Serviço web' },
    { id: 'def-5', word: 'landing page', category: 'high_confidence', weight: 95, description: 'Produto principal' },
    { id: 'def-6', word: 'disponibilidade', category: 'high_confidence', weight: 90, description: 'Consulta de agenda' },
    { id: 'def-7', word: 'reembolso', category: 'review', weight: 70, description: 'Assunto financeiro sensível' },
    { id: 'def-8', word: 'reclamação', category: 'review', weight: 75, description: 'Feedback negativo' },
    { id: 'def-9', word: 'contrato assinado', category: 'review', weight: 80, description: 'Compromisso formal' },
    { id: 'def-10', word: 'senha', category: 'blocked', weight: 100, description: 'Dados de credenciais privadas' },
  ];

  constructor(private storage: StorageAdapter) {}

  public async getActiveRules(): Promise<HeuristicKeywordRule[]> {
    const userRules = await this.storage.getKeywordRules();
    // Merge user rules with defaults (user rules override defaults by word)
    const ruleMap = new Map<string, HeuristicKeywordRule>();
    for (const d of this.defaultRules) {
      ruleMap.set(d.word.toLowerCase(), d);
    }
    for (const u of userRules) {
      ruleMap.set(u.word.toLowerCase(), u);
    }
    return Array.from(ruleMap.values());
  }

  // Strip accents and normalize text for robust Portuguese matching
  private normalize(str: string): string {
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  // Levenshtein distance calculation for fuzzy matching
  private levenshtein(a: string, b: string): number {
    const an = a.length;
    const bn = b.length;
    if (an === 0) return bn;
    if (bn === 0) return an;
    const matrix: number[][] = [];

    for (let i = 0; i <= bn; i++) matrix[i] = [i];
    for (let j = 0; j <= an; j++) matrix[0][j] = j;

    for (let i = 1; i <= bn; i++) {
      for (let j = 1; j <= an; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
          );
        }
      }
    }
    return matrix[bn][an];
  }

  // Similarity score between 0 and 1
  private similarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    const editDistance = this.levenshtein(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  public async interpret(text: string): Promise<HybridInterpretationResult> {
    const rules = await this.getActiveRules();
    const normalizedInput = this.normalize(text);
    const words = normalizedInput.split(/[\s,.;!?]+/).filter((w) => w.length > 2);

    const matches: HybridInterpretationResult['matchedRules'] = [];
    let highConfHits = 0;
    let reviewHits = 0;
    let blockedHits = 0;

    for (const rule of rules) {
      const normalizedRuleWord = this.normalize(rule.word);

      // 1. Direct Substring / Phrase match
      if (normalizedInput.includes(normalizedRuleWord)) {
        matches.push({
          rule,
          matchType: 'exact',
          score: 1.0,
          token: normalizedRuleWord,
        });

        if (rule.category === 'high_confidence') highConfHits++;
        if (rule.category === 'review') reviewHits++;
        if (rule.category === 'blocked') blockedHits++;
        continue;
      }

      // 2. Fuzzy Token Match (Levenshtein similarity >= 0.82 for single words)
      if (!normalizedRuleWord.includes(' ')) {
        for (const token of words) {
          const sim = this.similarity(token, normalizedRuleWord);
          if (sim >= 0.82) {
            matches.push({
              rule,
              matchType: 'fuzzy',
              score: sim,
              token,
            });

            if (rule.category === 'high_confidence') highConfHits++;
            if (rule.category === 'review') reviewHits++;
            if (rule.category === 'blocked') blockedHits++;
            break;
          }
        }
      }
    }

    const flags: string[] = [];
    const reasons: string[] = [];

    if (blockedHits > 0) {
      flags.push('KEYWORD_BLOCKED');
      reasons.push('Contém termos cadastrados na lista de bloqueio estrito.');
      return {
        matchedRules: matches,
        suggestedAction: 'HUMAN_ONLY',
        confidenceBoost: -50,
        flags,
        reasons,
      };
    }

    if (reviewHits > 0) {
      flags.push('KEYWORD_REVIEW_TRIGGER');
      reasons.push('Contém termos cadastrados que exigem revisão humana.');
      return {
        matchedRules: matches,
        suggestedAction: 'REVIEW_REQUIRED',
        confidenceBoost: -20,
        flags,
        reasons,
      };
    }

    if (highConfHits > 0) {
      flags.push('KEYWORD_HIGH_CONFIDENCE_MATCH');
      reasons.push(`Correspondência híbrida com termos comerciais/frequentes cadastrados (${matches.map((m) => m.rule.word).join(', ')}).`);
      return {
        matchedRules: matches,
        suggestedAction: 'AUTO_REPLY',
        confidenceBoost: 25,
        flags,
        reasons,
      };
    }

    return {
      matchedRules: [],
      suggestedAction: 'NEUTRAL',
      confidenceBoost: 0,
      flags: [],
      reasons: [],
    };
  }
}
