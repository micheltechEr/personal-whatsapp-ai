import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { MessageProcessor } from '../src/processor/MessageProcessor.js';
import { ContextEngine } from '../src/intelligence/ContextEngine.js';
import { IntentClassifier } from '../src/intelligence/IntentClassifier.js';
import { RiskEngine } from '../src/intelligence/RiskEngine.js';
import { PersonalityEngine } from '../src/intelligence/PersonalityEngine.js';
import { ResponseGenerator } from '../src/intelligence/ResponseGenerator.js';
import { AutonomyController } from '../src/autonomy/AutonomyController.js';
import { MessageDispatcher } from '../src/autonomy/MessageDispatcher.js';
import { ApprovalManager } from '../src/autonomy/ApprovalManager.js';
import { NormalizedMessage, WhatsAppGroupInfo } from '../src/types/index.js';

describe('Progressive Group Management (Testing Groups Safely)', () => {
  let testDir: string;
  let storage: MemoryFileStorageAdapter;
  let processor: MessageProcessor;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), `.test_groups_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();

    const personality = new PersonalityEngine('Ângelo');
    const contextEngine = new ContextEngine(storage);
    const intentClassifier = new IntentClassifier();
    const riskEngine = new RiskEngine();
    const responseGenerator = new ResponseGenerator(personality);
    const autonomyController = new AutonomyController({ globalMode: 'AUTONOMOUS_CONTROLLED' });
    const dispatcher = new MessageDispatcher(storage);
    const approvalManager = new ApprovalManager(storage, dispatcher, personality);

    processor = new MessageProcessor(
      storage,
      contextEngine,
      intentClassifier,
      riskEngine,
      personality,
      responseGenerator,
      autonomyController,
      dispatcher,
      approvalManager,
      { bufferWindowMs: 25 }
    );
  });

  afterEach(async () => {
    processor.clearAllBuffers();
    await storage.close();
    await new Promise((r) => setTimeout(r, 60));
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('drops group messages when bot is disabled for that group (default)', async () => {
    const groupJid = '120363000111222@g.us';

    // Registra o grupo no armazenamento com botEnabled: false
    const group: WhatsAppGroupInfo = {
      id: groupJid,
      name: 'Grupo dos Amigos Devs',
      participantCount: 15,
      lastMessage: 'Alguém viu o jogo?',
      lastActivityTimestamp: Date.now(),
      botEnabled: false,
    };
    await storage.saveGroup(group);

    const msg: NormalizedMessage = {
      id: 'grp-msg-1',
      contactId: groupJid,
      remoteJid: groupJid,
      content: 'Alguém me ajuda com esse bug?',
      timestamp: Date.now(),
      fromMe: false,
      isGroup: true,
      type: 'text',
    };

    await processor.onIncomingMessage(msg);
    await new Promise((r) => setTimeout(r, 60));

    // Nenhum log de resposta deve ser gerado pois o bot está desativado para o grupo
    const audits = await storage.getAuditLogs();
    const grpAudits = audits.filter((a) => a.contactId === groupJid);
    expect(grpAudits.length).toBe(0);
  });

  it('ignores conversations between other members even if group is enabled', async () => {
    const groupJid = '120363000555666@g.us';

    await storage.saveGroup({
      id: groupJid,
      name: 'Grupo com Bot Habilitado',
      lastMessage: 'Oi galera',
      lastActivityTimestamp: Date.now(),
      botEnabled: true,
    });

    // Mensagem de um membro falando com outro membro (sem marcar Ângelo, sem citar Ângelo)
    const msg: NormalizedMessage = {
      id: 'grp-msg-unrelated',
      contactId: groupJid,
      remoteJid: groupJid,
      content: 'Carlos, você viu o que o professor falou ontem na aula?',
      timestamp: Date.now(),
      fromMe: false,
      isGroup: true,
      type: 'text',
      mentionedJids: [],
    };

    await processor.onIncomingMessage(msg);
    await new Promise((r) => setTimeout(r, 60));

    // NENHUMA resposta deve ser gerada
    const audits = await storage.getAuditLogs();
    const grpAudits = audits.filter((a) => a.contactId === groupJid);
    expect(grpAudits.length).toBe(0);
  });

  it('processes group messages when user explicitly enables the bot for that group', async () => {
    const groupJid = '120363000333444@g.us';

    // Registra e ativa o grupo
    await storage.saveGroup({
      id: groupJid,
      name: 'Grupo de Testes do Bot',
      lastMessage: 'Iniciando testes',
      lastActivityTimestamp: Date.now(),
      botEnabled: true,
    });

    const msg: NormalizedMessage = {
      id: 'grp-msg-allowed',
      contactId: groupJid,
      remoteJid: groupJid,
      content: 'Oi Ângelo, tudo bem?',
      timestamp: Date.now(),
      fromMe: false,
      isGroup: true,
      type: 'text',
      mentionedJids: ['557588428289@s.whatsapp.net'],
    };

    await processor.onIncomingMessage(msg);
    await new Promise((r) => setTimeout(r, 350));

    const audits = await storage.getAuditLogs();
    const grpAudit = audits.find((a) => a.contactId === groupJid);
    expect(grpAudit).toBeDefined();
  });
});
