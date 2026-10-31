import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { HybridHeuristicInterpreter } from '../src/intelligence/HybridHeuristicInterpreter.js';

describe('Hybrid Heuristic Interpreter & User Registered Words', () => {
  const testDir = path.resolve(process.cwd(), '.test_hybrid_' + Date.now());
  let storage: MemoryFileStorageAdapter;
  let interpreter: HybridHeuristicInterpreter;

  beforeEach(async () => {
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
    interpreter = new HybridHeuristicInterpreter(storage);
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('matches exact keywords ignoring accents (e.g. orcamento matches orçamento)', async () => {
    const res = await interpreter.interpret('Gostaria de solicitar um orcamento para uma landing page');
    expect(res.suggestedAction).toBe('AUTO_REPLY');
    expect(res.confidenceBoost).toBeGreaterThan(0);
    expect(res.matchedRules.some((m) => m.rule.word === 'orçamento')).toBe(true);
  });

  it('matches fuzzy typos using distance calculation (e.g. orcameto)', async () => {
    const res = await interpreter.interpret('Quero saber o orcameto do projeto');
    expect(res.suggestedAction).toBe('AUTO_REPLY');
    expect(res.matchedRules.some((m) => m.matchType === 'fuzzy' && m.rule.word === 'orçamento')).toBe(true);
  });

  it('allows user to save custom keywords that trigger review', async () => {
    await storage.saveKeywordRule({
      id: 'custom-1',
      word: 'parceria comercial',
      category: 'review',
      weight: 80,
      description: 'Proposta de parceria',
    });

    const res = await interpreter.interpret('Tenho uma proposta de parceria comercial');
    expect(res.suggestedAction).toBe('REVIEW_REQUIRED');
    expect(res.flags).toContain('KEYWORD_REVIEW_TRIGGER');
  });

  it('allows user to save custom blocked keywords that force human only', async () => {
    await storage.saveKeywordRule({
      id: 'custom-2',
      word: 'estorno',
      category: 'blocked',
      weight: 100,
      description: 'Estorno financeiro',
    });

    const res = await interpreter.interpret('Preciso do estorno do pagamento');
    expect(res.suggestedAction).toBe('HUMAN_ONLY');
    expect(res.flags).toContain('KEYWORD_BLOCKED');
  });
});
