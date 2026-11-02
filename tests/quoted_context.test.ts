import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { ContextEngine } from '../src/intelligence/ContextEngine.js';
import { IntentClassifier } from '../src/intelligence/IntentClassifier.js';
import { NormalizedMessage } from '../src/types/index.js';

describe('Quoted Context Reference (. or marker for older messages)', () => {
  let testDir: string;
  let storage: MemoryFileStorageAdapter;
  let contextEngine: ContextEngine;
  let intentClassifier: IntentClassifier;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), `.test_quoted_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
    contextEngine = new ContextEngine(storage);
    intentClassifier = new IntentClassifier();
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('promotes single dot marker (.) with quoted reference to EXPLICIT_CONTEXT_REFERENCE', () => {
    const classification = intentClassifier.classify('.', 'text', 'Contexto recente', true);
    expect(classification.intent).toBe('EXPLICIT_CONTEXT_REFERENCE');
    expect(classification.requiresResponse).toBe(true);
    expect(classification.operationalAction).toBe('RESPONDER');
  });

  it('retrieves the original message and surrounding context by stanzaId', async () => {
    const contactId = '5575988887777';

    // Salva histórico antigo
    const oldMsg1: NormalizedMessage = {
      id: 'old-stanza-001',
      contactId,
      content: 'Você consegue me mandar o orçamento do projeto do site?',
      timestamp: Date.now() - 3 * 24 * 3600 * 1000, // 3 dias atrás
      fromMe: false,
      isGroup: false,
      type: 'text',
    };
    await storage.saveMessage(oldMsg1);

    const oldReply: NormalizedMessage = {
      id: 'old-stanza-002',
      contactId,
      content: 'Vou fechar a planilha e te envio.',
      timestamp: Date.now() - 3 * 24 * 3600 * 1000 + 60000,
      fromMe: true,
      isGroup: false,
      type: 'text',
    };
    await storage.saveMessage(oldReply);

    // Agora o contato responde com "." citando a mensagem de 3 dias atrás
    const markerMsg: NormalizedMessage = {
      id: 'msg-marker-today',
      contactId,
      content: '.',
      timestamp: Date.now(),
      fromMe: false,
      isGroup: false,
      type: 'text',
      quoted: {
        stanzaId: 'old-stanza-001',
        quotedMessage: 'Você consegue me mandar o orçamento do projeto do site?',
      },
    };

    const context = await contextEngine.getContext(contactId, markerMsg);

    expect(context.explicitReferencedMessage).toBeDefined();
    expect(context.explicitReferencedMessage?.original.id).toBe('old-stanza-001');
    expect(context.explicitReferencedMessage?.original.content).toContain('orçamento');
    expect(context.explicitReferencedMessage?.surroundingContext).toContain('Vou fechar a planilha');
  });
});
