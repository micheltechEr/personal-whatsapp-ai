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
import { ResponseGenerator } from './intelligence/ResponseGenerator.js';
import { AutonomyController } from './autonomy/AutonomyController.js';
import { MessageDispatcher } from './autonomy/MessageDispatcher.js';
import { ApprovalManager } from './autonomy/ApprovalManager.js';
import { MessageProcessor } from './processor/MessageProcessor.js';
import { createServer } from './api/server.js';

dotenv.config();

async function main() {
  const usePostgres = Boolean(process.env.DATABASE_URL);
  const storage = usePostgres
    ? new PostgresStorageAdapter(process.env.DATABASE_URL!)
    : new MemoryFileStorageAdapter(path.resolve(process.cwd(), '.data'));

  await storage.init();

  const personalityEngine = new PersonalityEngine();
  const contextEngine = new ContextEngine(storage);
  const intentClassifier = new IntentClassifier();
  const riskEngine = new RiskEngine();
  const hybridInterpreter = new HybridHeuristicInterpreter(storage);
  const responseGenerator = new ResponseGenerator(personalityEngine, undefined, hybridInterpreter);

  const autonomyController = new AutonomyController({
    globalMode: 'AUTONOMOUS_CONTROLLED',
  });

  const gateway = new WhatsAppGateway();
  const dispatcher = new MessageDispatcher(storage, gateway);
  const approvalManager = new ApprovalManager(storage, dispatcher, personalityEngine);

  const processor = new MessageProcessor(
    storage,
    contextEngine,
    intentClassifier,
    riskEngine,
    personalityEngine,
    responseGenerator,
    autonomyController,
    dispatcher,
    approvalManager
  );

  // Bind Gateway message stream into Processor
  gateway.on('message', (msg) => {
    console.log(`[App] Nova mensagem recebida de ${msg.contactId} (fromMe: ${msg.fromMe}): "${msg.content}"`);
    processor.onIncomingMessage(msg).catch((err) => {
      console.error('[App] Erro ao processar mensagem recebida:', err);
    });
  });

  const port = Number(process.env.PORT) || 3000;
  const server = createServer({
    storage,
    gateway,
    autonomyController,
    approvalManager,
    personalityEngine,
    hybridInterpreter,
  });

  await server.listen({ port, host: '0.0.0.0' });
  console.log(`[Personal WhatsApp AI] Running on http://localhost:${port}`);
  console.log(`[Personal WhatsApp AI] Mode: ${autonomyController.getGlobalMode()}`);

  if (process.env.START_WHATSAPP === 'true') {
    await gateway.start();
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
