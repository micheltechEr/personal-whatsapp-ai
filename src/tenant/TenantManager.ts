import crypto from 'node:crypto';
import path from 'node:path';
import { StorageAdapter } from '../storage/StorageAdapter.js';
import { TenantUser } from '../types/index.js';
import { WhatsAppGateway } from '../gateway/WhatsAppGateway.js';
import { PersonalityEngine } from '../intelligence/PersonalityEngine.js';
import { OwnerStyleRAG } from '../intelligence/OwnerStyleRAG.js';
import { HybridHeuristicInterpreter } from '../intelligence/HybridHeuristicInterpreter.js';
import { ResponseGenerator } from '../intelligence/ResponseGenerator.js';
import { IntentClassifier } from '../intelligence/IntentClassifier.js';
import { RiskEngine } from '../intelligence/RiskEngine.js';
import { AutonomyController } from '../autonomy/AutonomyController.js';
import { MessageDispatcher } from '../autonomy/MessageDispatcher.js';
import { ApprovalManager } from '../autonomy/ApprovalManager.js';
import { MessageProcessor } from '../processor/MessageProcessor.js';
import { JevClassifierClient } from '../intelligence/JevClassifierClient.js';

export interface TenantRuntimeContainer {
  tenant: TenantUser;
  gateway: WhatsAppGateway;
  personalityEngine: PersonalityEngine;
  styleRAG: OwnerStyleRAG;
  hybridInterpreter: HybridHeuristicInterpreter;
  responseGenerator: ResponseGenerator;
  autonomyController: AutonomyController;
  dispatcher: MessageDispatcher;
  approvalManager: ApprovalManager;
  processor: MessageProcessor;
}

export class TenantManager {
  private runtimes: Map<string, TenantRuntimeContainer> = new Map();
  private sessionTokens: Map<string, string> = new Map(); // token -> tenantId
  private jevClient: JevClassifierClient;

  constructor(
    private storage: StorageAdapter,
    private baseAuthDir?: string
  ) {
    this.baseAuthDir = baseAuthDir || path.resolve(process.cwd(), '.baileys_auth');
    this.jevClient = new JevClassifierClient();
  }

  // Hash password using SHA-256
  private hashPassword(password: string): string {
    return crypto.createHash('sha256').update(password.trim()).digest('hex');
  }

  public async register(name: string, username: string, password: string): Promise<{ success: boolean; token?: string; tenant?: TenantUser; error?: string }> {
    const cleanUser = username.trim().toLowerCase();
    if (!cleanUser || !password || password.length < 4) {
      return { success: false, error: 'Usuário e senha (mínimo 4 caracteres) são obrigatórios.' };
    }

    const existing = await this.storage.getTenantByUsername(cleanUser);
    if (existing) {
      return { success: false, error: 'Nome de usuário já cadastrado. Escolha outro.' };
    }

    const tenant: TenantUser = {
      id: `tenant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: name.trim() || cleanUser,
      username: cleanUser,
      passwordHash: this.hashPassword(password),
      createdAt: Date.now(),
    };

    await this.storage.createTenant(tenant);
    const token = this.createSession(tenant.id);

    // Inicializa o container com IA e Gateway isolados
    await this.getOrCreateRuntime(tenant);

    return { success: true, token, tenant };
  }

  public async login(username: string, password: string): Promise<{ success: boolean; token?: string; tenant?: TenantUser; error?: string }> {
    const cleanUser = username.trim().toLowerCase();
    const tenant = await this.storage.getTenantByUsername(cleanUser);
    if (!tenant) {
      return { success: false, error: 'Usuário ou senha incorretos.' };
    }

    const hash = this.hashPassword(password);
    if (tenant.passwordHash !== hash) {
      return { success: false, error: 'Usuário ou senha incorretos.' };
    }

    const token = this.createSession(tenant.id);
    await this.getOrCreateRuntime(tenant);

    return { success: true, token, tenant };
  }

  public getTenantByToken(token: string): Promise<TenantUser | null> {
    const tenantId = this.sessionTokens.get(token);
    if (!tenantId) return Promise.resolve(null);
    return this.storage.getTenantById(tenantId);
  }

  private createSession(tenantId: string): string {
    const token = `sess-${crypto.randomBytes(24).toString('hex')}`;
    this.sessionTokens.set(token, tenantId);
    return token;
  }

  public async getOrCreateRuntime(tenant: TenantUser): Promise<TenantRuntimeContainer> {
    const existing = this.runtimes.get(tenant.id);
    if (existing) return existing;

    // 1. WhatsApp Gateway isolado em subpasta exclusiva (.baileys_auth/tenant_<id>)
    // Para o admin (conta principal conectada), utiliza a pasta base onde a sessão já está autenticada
    const tenantAuthDir = tenant.username === 'admin'
      ? this.baseAuthDir!
      : path.join(this.baseAuthDir!, `tenant_${tenant.id}`);
    const gateway = new WhatsAppGateway(tenantAuthDir);

    // 2. Motores de Inteligência e RAG isolados por tenant
    const personalityEngine = new PersonalityEngine();
    const styleRAG = new OwnerStyleRAG(this.storage);
    await styleRAG.init();

    const hybridInterpreter = new HybridHeuristicInterpreter(this.storage);
    const responseGenerator = new ResponseGenerator(
      personalityEngine,
      undefined,
      hybridInterpreter,
      styleRAG
    );

    const intentClassifier = new IntentClassifier(this.jevClient);
    const riskEngine = new RiskEngine(this.jevClient);

    const autonomyController = new AutonomyController({
      globalMode: 'AUTONOMOUS_CONTROLLED',
      maxDailyAutoRepliesDefault: 30,
    });

    const dispatcher = new MessageDispatcher(this.storage, gateway);
    const approvalManager = new ApprovalManager(this.storage, dispatcher, personalityEngine);

    // 3. Processador de mensagens do Tenant
    // Adaptador de contexto scoped para o tenant
    const { ContextEngine } = await import('../intelligence/ContextEngine.js');
    const contextEngine = new ContextEngine(this.storage);

    const processor = new MessageProcessor(
      this.storage,
      contextEngine,
      intentClassifier,
      riskEngine,
      personalityEngine,
      responseGenerator,
      autonomyController,
      dispatcher,
      approvalManager
    );

    // 4. Conecta o socket do gateway deste tenant ao processador deste tenant
    gateway.on('message', async (msg) => {
      msg.tenantId = tenant.id;
      if (msg.fromMe) {
        const recent = await this.storage.getRecentMessages(msg.contactId, 3, tenant.id);
        const prevContactMsg = [...recent].reverse().find((m) => !m.fromMe);
        styleRAG.indexOwnerMessage(msg, prevContactMsg);
      }
      processor.onIncomingMessage(msg).catch((err) => {
        console.error(`[Tenant ${tenant.name}] Erro ao processar mensagem:`, err);
      });
    });

    const container: TenantRuntimeContainer = {
      tenant,
      gateway,
      personalityEngine,
      styleRAG,
      hybridInterpreter,
      responseGenerator,
      autonomyController,
      dispatcher,
      approvalManager,
      processor,
    };

    this.runtimes.set(tenant.id, container);
    return container;
  }

  public getRuntime(tenantId: string): TenantRuntimeContainer | null {
    return this.runtimes.get(tenantId) || null;
  }
}
