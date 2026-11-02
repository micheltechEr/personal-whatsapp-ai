import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { ImportantSubjectClassifier } from '../src/intelligence/ImportantSubjectClassifier.js';
import { NormalizedMessage, ImportantConversationSummary } from '../src/types/index.js';
import { ConversationContext } from '../src/intelligence/ContextEngine.js';

describe('Important Conversations & Executive Highlights', () => {
  let testDir: string;
  let storage: MemoryFileStorageAdapter;
  let classifier: ImportantSubjectClassifier;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), `.test_important_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
    classifier = new ImportantSubjectClassifier(storage);
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('detects high-priority keywords (orçamento, proposta, prazo, contrato)', () => {
    expect(classifier.isSubjectImportant('Qual o orçamento para criar a landing page?')).toBe(true);
    expect(classifier.isSubjectImportant('Podemos marcar uma reunião amanhã?')).toBe(true);
    expect(classifier.isSubjectImportant('Tudo bem por aí?')).toBe(false);
  });

  it('analyzes important conversation, stores executive summary and pending state', async () => {
    const contactId = '5575999998888';
    const msg: NormalizedMessage = {
      id: 'msg-prop-1',
      contactId,
      content: 'Preciso fechar o contrato do site e saber o prazo de entrega.',
      timestamp: Date.now(),
      fromMe: false,
      isGroup: false,
      type: 'text',
    };

    const context: ConversationContext = {
      contactId,
      contactName: 'Carlos Cliente',
      contactMemory: {
        contactId,
        relationship: 'professional',
        formalityLevel: 'medium',
        notes: [],
        autoReplyAllowed: true,
        blocked: false,
        maxDailyAutoReplies: 30,
        autoRepliesToday: 0,
        lastAutoReplyTimestamp: 0,
      },
      recentMessages: [msg],
      pendingTasks: [],
      recentSummary: 'Cliente quer fechar contrato de desenvolvimento web',
      isOwnerLastSender: false,
      ownerSentManualReplyRecently: false,
      contextConfidence: 95,
    };

    const result = await classifier.analyzeAndSave(msg, context, 'Enviei a proposta para análise');
    expect(result).toBeDefined();
    expect(result?.topic).toContain('Orçamento');
    expect(result?.waitingFor).toBeDefined();
    expect(result?.status).toBe('waiting_interlocutor');

    // Recupera do banco
    const stored = await storage.getImportantConversations();
    expect(stored.length).toBe(1);
    expect(stored[0].contactId).toBe(contactId);
    expect(stored[0].topic).toContain('Orçamento');
  });

  it('allows dismissing / resolving an important conversation', async () => {
    const summary: ImportantConversationSummary = {
      id: 'priority-test-1',
      contactId: '123',
      contactName: 'Cliente Teste',
      topic: 'Contrato Assinado',
      importanceLevel: 'high',
      summary: 'Contrato finalizado com sucesso.',
      lastDecisionTaken: 'Aprovado',
      waitingFor: 'Nenhuma pendência',
      status: 'resolved',
      lastActivityTimestamp: Date.now(),
    };

    await storage.saveImportantConversation(summary);
    let list = await storage.getImportantConversations();
    expect(list.length).toBe(1);

    await storage.deleteImportantConversation('priority-test-1');
    list = await storage.getImportantConversations();
    expect(list.length).toBe(0);
  });
});
