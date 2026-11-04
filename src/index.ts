import path from 'node:path';
import dotenv from 'dotenv';
import { MemoryFileStorageAdapter } from './storage/MemoryFileStorageAdapter.js';
import { PostgresStorageAdapter } from './storage/PostgresStorageAdapter.js';
import { WhatsAppGateway } from './gateway/WhatsAppGateway.js';
import { ContextEngine } from './intelligence/ContextEngine.js';
import { IntentClassifier } from './intelligence/IntentClassifier.js';
import { RiskEngine } from './intelligence/RiskEngine.js';
import { PersonalityEngine } from './intelligence/PersonalityEngine.js';
import { HybridHeuristicInterpreter } from './intelligence/HybridHeuristicInterpreter.js';
import { JevClassifierClient } from './intelligence/JevClassifierClient.js';
import { OwnerStyleRAG } from './intelligence/OwnerStyleRAG.js';
import { ResponseGenerator } from './intelligence/ResponseGenerator.js';
import { AutonomyController } from './autonomy/AutonomyController.js';
import { MessageDispatcher } from './autonomy/MessageDispatcher.js';
import { ApprovalManager } from './autonomy/ApprovalManager.js';
import { MessageProcessor } from './processor/MessageProcessor.js';
import { TenantManager } from './tenant/TenantManager.js';
import { createServer } from './api/server.js';

dotenv.config();

async function main() {
  const usePostgres = Boolean(process.env.DATABASE_URL);
  const storage = usePostgres
    ? new PostgresStorageAdapter(process.env.DATABASE_URL!)
    : new MemoryFileStorageAdapter(path.resolve(process.cwd(), '.data'));

  await storage.init();

  // Tenant Manager (Multi-Tenant & Session Engine)
  const tenantManager = new TenantManager(storage);

  // Garante o tenant padrão 'admin' (para retrocompatibilidade com a sessão ativa atual)
  let defaultAdmin = await storage.getTenantByUsername('admin');
  if (!defaultAdmin) {
    const reg = await tenantManager.register('Ângelo Miguel', 'admin', 'admin123');
    defaultAdmin = reg.tenant || null;
  }

  // Carrega o limite diário padrão persistido
  const savedGlobalLimit = await storage.getSetting('max_daily_auto_replies');
  const globalMaxDaily = savedGlobalLimit ? Number(savedGlobalLimit) : 30;

  // Inicializa o container do admin
  let adminRuntime = defaultAdmin ? await tenantManager.getOrCreateRuntime(defaultAdmin) : null;
  const gateway = adminRuntime ? adminRuntime.gateway : new WhatsAppGateway(undefined, undefined, storage, defaultAdmin?.id);
  gateway.setStorage(storage);
  if (defaultAdmin) gateway.setTenantId(defaultAdmin.id);
  const autonomyController = adminRuntime
    ? adminRuntime.autonomyController
    : new AutonomyController({ globalMode: 'AUTONOMOUS_CONTROLLED', maxDailyAutoRepliesDefault: globalMaxDaily });
  const personalityEngine = adminRuntime ? adminRuntime.personalityEngine : new PersonalityEngine('Ângelo Miguel');
  const approvalManager = adminRuntime ? adminRuntime.approvalManager : new ApprovalManager(storage, new MessageDispatcher(storage), personalityEngine);
  const hybridInterpreter = adminRuntime ? adminRuntime.hybridInterpreter : new HybridHeuristicInterpreter(storage);
  const styleRAG = adminRuntime ? adminRuntime.styleRAG : new OwnerStyleRAG(storage, defaultAdmin?.id);

  // Garante o fato pessoal sobre relacionamento pré-cadastrado para nunca errar sobre namoro
  const existingFacts = await storage.getOwnerFacts(defaultAdmin?.id);
  if (existingFacts.length === 0) {
    await storage.saveOwnerFact({
      id: 'fact-relacionamento-1',
      tenantId: defaultAdmin?.id,
      topic: 'Relacionamento',
      fact: 'Namoro com a Anny, sou comprometido, apaixonado e fiel.',
      createdAt: Date.now(),
    }, defaultAdmin?.id);
  }

  const port = Number(process.env.PORT) || 3000;
  const server = createServer({
    storage,
    tenantManager,
    gateway,
    autonomyController,
    approvalManager,
    personalityEngine,
    hybridInterpreter,
    styleRAG,
  });

  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[Personal WhatsApp AI] Running on http://localhost:${port}`);
  console.log(`[Personal WhatsApp AI] Mode: ${autonomyController.getGlobalMode()}`);

  if (process.env.START_WHATSAPP === 'true') {
    console.log('[App] START_WHATSAPP=true detectado, iniciando gateway...');
    gateway.start().catch((err) => {
      console.error('[WhatsAppGateway] Erro ao iniciar socket principal:', err);
    });
  } else {
    console.log(`[Personal WhatsApp AI] WhatsApp socket idle. Set START_WHATSAPP=true to scan QR code.`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error('Fatal initialization error:', err);
    process.exit(1);
  });
}
