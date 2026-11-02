import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { OwnerStyleRAG } from '../src/intelligence/OwnerStyleRAG.js';
import { NormalizedMessage } from '../src/types/index.js';

describe('Owner Style RAG & Continuous Learning', () => {
  const testDir = path.resolve(process.cwd(), '.test_style_rag_' + Date.now());
  let storage: MemoryFileStorageAdapter;
  let styleRAG: OwnerStyleRAG;

  beforeEach(async () => {
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
    styleRAG = new OwnerStyleRAG(storage);
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('indexes dialogue pairs from owner messages and previous inbound messages', () => {
    const contactMsg: NormalizedMessage = {
      id: 'c-1',
      contactId: 'contact-x',
      content: 'Vai rolar o projeto amanhã?',
      timestamp: Date.now() - 5000,
      fromMe: false,
      isGroup: false,
      type: 'text',
    };

    const ownerMsg: NormalizedMessage = {
      id: 'o-1',
      contactId: 'contact-x',
      content: 'vai sim pow, tudo certo',
      timestamp: Date.now(),
      fromMe: true,
      isGroup: false,
      type: 'text',
    };

    styleRAG.indexOwnerMessage(ownerMsg, contactMsg);
    const retrieved = styleRAG.retrieveStyleContext('Amanhã tem projeto?', 'contact-x');

    expect(retrieved.fewShotExamples.length).toBeGreaterThan(0);
    expect(retrieved.fewShotExamples[0].ownerReplyText).toBe('vai sim pow, tudo certo');
  });

  it('extracts real style metrics: frequent slang, lowercase ratio, average word count', () => {
    const texts = [
      'blz pow',
      'vai sim mano',
      'kkk de boa',
      'valeu tbm',
    ];

    const metrics = styleRAG.extractMetrics(texts);
    expect(metrics.totalAnalyzedMessages).toBe(4);
    expect(metrics.frequentSlang).toContain('pow');
    expect(metrics.frequentSlang).toContain('blz');
    expect(metrics.frequentSlang).toContain('kkk');
    expect(metrics.averageWordCount).toBeLessThanOrEqual(5);
  });
});
