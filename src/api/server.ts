import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { StorageAdapter } from '../storage/StorageAdapter.js';
import { WhatsAppGateway } from '../gateway/WhatsAppGateway.js';
import { AutonomyController } from '../autonomy/AutonomyController.js';
import { ApprovalManager } from '../autonomy/ApprovalManager.js';
import { PersonalityEngine } from '../intelligence/PersonalityEngine.js';
import { HybridHeuristicInterpreter } from '../intelligence/HybridHeuristicInterpreter.js';
import { OwnerStyleRAG } from '../intelligence/OwnerStyleRAG.js';
import { TenantManager, TenantRuntimeContainer } from '../tenant/TenantManager.js';
import { HeuristicKeywordRule } from '../types/index.js';

export function createServer(dependencies: {
  storage: StorageAdapter;
  tenantManager: TenantManager;
  gateway?: WhatsAppGateway;
  autonomyController?: AutonomyController;
  approvalManager?: ApprovalManager;
  personalityEngine?: PersonalityEngine;
  hybridInterpreter?: HybridHeuristicInterpreter;
  styleRAG?: OwnerStyleRAG;
}): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: '*' });

  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    if (!body || body.trim() === '') {
      return done(null, {});
    }
    try {
      done(null, JSON.parse(body));
    } catch (err: any) {
      done(err, undefined);
    }
  });

  async function getTenantContainer(request: any): Promise<TenantRuntimeContainer | null> {
    const authHeader = (request.headers.authorization as string) || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const tenant = await dependencies.tenantManager.getTenantByToken(token);
      if (tenant) {
        return dependencies.tenantManager.getOrCreateRuntime(tenant);
      }
    }
    const admin = await dependencies.storage.getTenantByUsername('admin');
    if (admin) {
      return dependencies.tenantManager.getOrCreateRuntime(admin);
    }
    return null;
  }

  // Auth Endpoints
  app.post('/api/auth/register', async (request, reply) => {
    const { name, username, password } = request.body as any;
    const res = await dependencies.tenantManager.register(name, username, password);
    if (!res.success) return reply.status(400).send(res);
    return res;
  });

  app.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body as any;
    const res = await dependencies.tenantManager.login(username, password);
    if (!res.success) return reply.status(400).send(res);
    return res;
  });

  app.get('/api/auth/me', async (request, reply) => {
    const container = await getTenantContainer(request);
    if (!container) return reply.status(401).send({ error: 'Não autenticado' });
    return {
      authenticated: true,
      tenant: {
        id: container.tenant.id,
        name: container.tenant.name,
        username: container.tenant.username,
      },
    };
  });

  // 1. Overview & Metrics
  app.get('/api/overview', async (request) => {
    const container = await getTenantContainer(request);
    const tenantId = container?.tenant.id;

    const auditLogs = await dependencies.storage.getAuditLogs(100, tenantId);
    const pendingTasks = await dependencies.storage.getPendingTasks('pending', tenantId);
    const pendingApprovals = container
      ? await container.approvalManager.getPending()
      : dependencies.approvalManager
      ? await dependencies.approvalManager.getPending()
      : [];

    const gateway = container ? container.gateway : dependencies.gateway;
    const gatewayStatus = gateway ? gateway.getStatus() : { status: 'mocked', qr: null };

    const autonomy = container ? container.autonomyController : dependencies.autonomyController;
    const globalMode = autonomy ? autonomy.getGlobalMode() : 'AUTONOMOUS_CONTROLLED';
    const maxDailyAutoReplies = autonomy ? autonomy.getMaxDailyAutoReplies() : 30;

    const autoRepliesCount = auditLogs.filter((a) => a.finalDecision === 'AUTO_REPLY').length;

    return {
      tenantName: container?.tenant.name || 'Padrão',
      tenantUsername: container?.tenant.username || 'admin',
      globalMode,
      maxDailyAutoReplies,
      gatewayStatus,
      totalMessagesAnalyzed: auditLogs.length,
      autoRepliesSent: autoRepliesCount,
      pendingApprovalsCount: pendingApprovals.length,
      pendingTasksCount: pendingTasks.length,
    };
  });

  // 2. Gateway Status & QR
  app.get('/api/gateway/status', async (request) => {
    const container = await getTenantContainer(request);
    const gw = container ? container.gateway : dependencies.gateway;
    if (!gw) {
      return { status: 'mocked', qr: null, qrDataUrl: null, reconnectAttempts: 0 };
    }
    const status = gw.getStatus();
    const qrDataUrl = await gw.getQrDataUrl();
    return { ...status, qrDataUrl };
  });

  app.post('/api/gateway/connect', async (request) => {
    const container = await getTenantContainer(request);
    const gw = container ? container.gateway : dependencies.gateway;
    if (gw) {
      gw.start().catch((err) => {
        console.error('[WhatsAppGateway] Erro ao iniciar:', err);
      });
      return { success: true, message: 'Iniciando conexão com WhatsApp...' };
    }
    return { success: false, error: 'Gateway não configurado' };
  });

  // 3. Autonomy Configuration & Limits
  app.get('/api/autonomy', async (request) => {
    const container = await getTenantContainer(request);
    const autonomy = container ? container.autonomyController : dependencies.autonomyController;
    return {
      mode: autonomy ? autonomy.getGlobalMode() : 'AUTONOMOUS_CONTROLLED',
      maxDailyAutoReplies: autonomy ? autonomy.getMaxDailyAutoReplies() : 30,
    };
  });

  app.post('/api/autonomy/limit', async (request, reply) => {
    const container = await getTenantContainer(request);
    const autonomy = container ? container.autonomyController : dependencies.autonomyController;
    if (!autonomy) return reply.status(400).send({ error: 'Controller indisponível' });
    const { limit } = request.body as { limit: number };
    const num = Number(limit);
    if (!num || num < 1 || num > 500) {
      return reply.status(400).send({ error: 'Limite diário deve ser um número entre 1 e 500.' });
    }
    autonomy.setMaxDailyAutoReplies(num);

    // Persiste o limite diário no banco de dados para sobreviver a reinicializações
    const tenantId = container?.tenant.id;
    await dependencies.storage.setSetting('max_daily_auto_replies', String(num), tenantId);

    return { success: true, maxDailyAutoReplies: num };
  });

  app.post('/api/contacts/reset-quotas', async (request) => {
    const container = await getTenantContainer(request);
    const tenantId = container?.tenant.id;
    const overview = await dependencies.storage.getAuditLogs(500, tenantId);
    const contactIds = Array.from(new Set(overview.map((o) => o.contactId)));
    for (const cid of contactIds) {
      const mem = await dependencies.storage.getContactMemory(cid, tenantId);
      if (mem) {
        mem.autoRepliesToday = 0;
        await dependencies.storage.saveContactMemory(mem, tenantId);
      }
    }
    return { success: true, message: 'Cotas diárias zeradas com sucesso.' };
  });

  app.post('/api/autonomy/mode', async (request, reply) => {
    const container = await getTenantContainer(request);
    const autonomy = container ? container.autonomyController : dependencies.autonomyController;
    if (!autonomy) return reply.status(400).send({ error: 'Controller indisponível' });
    const { mode } = request.body as { mode: any };
    if (!['AUTONOMOUS_CONTROLLED', 'MANUAL_ONLY', 'EMERGENCY_STOP'].includes(mode)) {
      return reply.status(400).send({ error: 'Modo inválido' });
    }
    autonomy.setGlobalMode(mode);
    return { success: true, mode };
  });

  // 4. Approvals
  app.get('/api/approvals', async (request) => {
    const container = await getTenantContainer(request);
    if (container) return container.approvalManager.getPending();
    return dependencies.approvalManager ? dependencies.approvalManager.getPending() : [];
  });

  // 4.1 Important Conversations Highlights
  app.get('/api/conversations/important', async (request) => {
    const container = await getTenantContainer(request);
    const tenantId = container?.tenant.id;
    return dependencies.storage.getImportantConversations(tenantId);
  });

  app.delete('/api/conversations/important/:id', async (request, reply) => {
    const container = await getTenantContainer(request);
    const tenantId = container?.tenant.id;
    const { id } = request.params as { id: string };
    const success = await dependencies.storage.deleteImportantConversation(id, tenantId);
    return { success };
  });

  app.post('/api/approvals/:id/approve', async (request, reply) => {
    const container = await getTenantContainer(request);
    const mgr = container ? container.approvalManager : dependencies.approvalManager;
    if (!mgr) return reply.status(400).send({ error: 'Manager indisponível' });
    const { id } = request.params as { id: string };
    const result = await mgr.approve(id);
    if (!result.success) return reply.status(400).send(result);
    return result;
  });

  app.post('/api/approvals/:id/edit', async (request, reply) => {
    const container = await getTenantContainer(request);
    const mgr = container ? container.approvalManager : dependencies.approvalManager;
    if (!mgr) return reply.status(400).send({ error: 'Manager indisponível' });
    const { id } = request.params as { id: string };
    const { editedResponse } = request.body as { editedResponse: string };
    const result = await mgr.editAndApprove(id, editedResponse);
    if (!result.success) return reply.status(400).send(result);
    return result;
  });

  app.post('/api/approvals/:id/reject', async (request, reply) => {
    const container = await getTenantContainer(request);
    const mgr = container ? container.approvalManager : dependencies.approvalManager;
    if (!mgr) return reply.status(400).send({ error: 'Manager indisponível' });
    const { id } = request.params as { id: string };
    const result = await mgr.reject(id);
    if (!result.success) return reply.status(400).send(result);
    return result;
  });

  // 5. Smart Inbox / Pending Tasks
  app.get('/api/inbox/tasks', async (request) => {
    const container = await getTenantContainer(request);
    return dependencies.storage.getPendingTasks(undefined, container?.tenant.id);
  });

  app.patch('/api/inbox/tasks/:id', async (request) => {
    const container = await getTenantContainer(request);
    const { id } = request.params as { id: string };
    const { state } = request.body as { state: 'pending' | 'resolved' | 'dismissed' };
    await dependencies.storage.updatePendingTaskState(id, state, container?.tenant.id);
    return { success: true };
  });

  // 6. Memory & Contacts
  app.get('/api/contacts/:id/memory', async (request, reply) => {
    const container = await getTenantContainer(request);
    const { id } = request.params as { id: string };
    const memory = await dependencies.storage.getContactMemory(id, container?.tenant.id);
    if (!memory) return reply.status(404).send({ error: 'Contato não encontrado' });
    return memory;
  });

  app.post('/api/contacts/:id/memory', async (request) => {
    const container = await getTenantContainer(request);
    const { id } = request.params as { id: string };
    const body = request.body as any;
    await dependencies.storage.saveContactMemory({ ...body, contactId: id }, container?.tenant.id);
    return { success: true };
  });

  // 7. Audit Trail
  app.get('/api/audit', async (request) => {
    const container = await getTenantContainer(request);
    return dependencies.storage.getAuditLogs(100, container?.tenant.id);
  });

  // 8. Custom Heuristic Keywords & Hybrid Interpreter
  app.get('/api/heuristics/keywords', async (request) => {
    const container = await getTenantContainer(request);
    const interpreter = container ? container.hybridInterpreter : dependencies.hybridInterpreter;
    if (interpreter) {
      return interpreter.getActiveRules();
    }
    return dependencies.storage.getKeywordRules(container?.tenant.id);
  });

  app.post('/api/heuristics/keywords', async (request, reply) => {
    const container = await getTenantContainer(request);
    const { word, category, weight, description } = request.body as any;
    if (!word || !category) {
      return reply.status(400).send({ error: 'Palavra e categoria são obrigatórias' });
    }
    const rule: HeuristicKeywordRule = {
      id: `kw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      tenantId: container?.tenant.id,
      word: word.trim().toLowerCase(),
      category: category as any,
      weight: Number(weight) || (category === 'high_confidence' ? 95 : 75),
      description: description || 'Regra cadastrada pelo usuário',
    };
    await dependencies.storage.saveKeywordRule(rule, container?.tenant.id);
    return { success: true, rule };
  });

  app.delete('/api/heuristics/keywords/:id', async (request) => {
    const container = await getTenantContainer(request);
    const { id } = request.params as { id: string };
    const deleted = await dependencies.storage.deleteKeywordRule(id, container?.tenant.id);
    return { success: deleted };
  });

  // 9. Owner Style Metrics & RAG Info
  app.get('/api/style/metrics', async (request) => {
    const container = await getTenantContainer(request);
    const rag = container ? container.styleRAG : dependencies.styleRAG;
    if (!rag) {
      return { totalAnalyzedMessages: 0, averageWordCount: 8, lowercaseRatio: 0.9, frequentSlang: [] };
    }
    const sample = rag.retrieveStyleContext('', '');
    return sample.metrics;
  });

  // 9. Serve Embedded Dashboard HTML
  app.get('/', async (request, reply) => {
    reply.type('text/html');
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Personal WhatsApp AI - Autonomous Controlled Cockpit</title>
  <style>
    :root {
      --bg: #07080B;
      --card: #11141C;
      --border: #222938;
      --text: #F1F5F9;
      --muted: #94A3B8;
      --accent: #22C55E;
      --warn: #F59E0B;
      --danger: #EF4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: var(--font); }
    body { background: var(--bg); color: var(--text); padding: 24px; }
    header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 24px; border-bottom: 1px solid var(--border); margin-bottom: 24px; }
    h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
    .badge { padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .badge-auto { background: rgba(34, 197, 94, 0.15); color: var(--accent); border: 1px solid var(--accent); }
    .badge-stop { background: rgba(239, 68, 68, 0.15); color: var(--danger); border: 1px solid var(--danger); }
    .controls { display: flex; gap: 12px; }
    button { padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 13px; font-weight: 500; }
    button:hover { border-color: var(--accent); }
    button.btn-danger { background: rgba(239, 68, 68, 0.2); border-color: var(--danger); color: #FFAAAA; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card); border: 1px solid var(--border); padding: 18px; border-radius: 8px; }
    .stat-val { font-size: 28px; font-weight: 700; margin-top: 8px; }
    .section-title { font-size: 16px; font-weight: 600; margin: 24px 0 12px 0; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .table-container { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { padding: 12px 16px; background: rgba(255,255,255,0.02); color: var(--muted); border-bottom: 1px solid var(--border); }
    td { padding: 12px 16px; border-bottom: 1px solid var(--border); }
    .empty { padding: 24px; text-align: center; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Personal WhatsApp AI <span id="tenant-tag" style="font-size: 13px; font-weight: normal; color: var(--muted); margin-left: 8px;"></span></h1>
      <p style="color: var(--muted); font-size: 13px; margin-top: 4px;">Autonomous Controlled Personal Communication Agent</p>
    </div>
    <div class="controls">
      <span id="mode-badge" class="badge badge-auto">AUTONOMOUS_CONTROLLED</span>
      <span id="connection-badge" class="badge" style="background: rgba(34, 197, 94, 0.15); color: #22C55E; border: 1px solid #22C55E;">● CONECTADO</span>
      <button id="btn-connect" style="display: none; border-color: #22C55E; color: #22C55E;" onclick="connectWhatsApp()">Conectar WhatsApp</button>
      <button onclick="setMode('AUTONOMOUS_CONTROLLED')">Modo Autônomo</button>
      <button onclick="setMode('MANUAL_ONLY')">Apenas Manual</button>
      <button class="btn-danger" onclick="setMode('EMERGENCY_STOP')">Pânico / Parar Tudo</button>
      <button onclick="logout()" style="border-color: #EF4444; color: #EF4444;">Sair</button>
    </div>
  </header>

  <div id="auth-overlay" style="display: none; position: fixed; inset: 0; background: rgba(7, 8, 11, 0.95); z-index: 9999; display: flex; align-items: center; justify-content: center;">
    <div style="background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 32px; width: 100%; max-width: 420px; box-shadow: 0 20px 40px rgba(0,0,0,0.8);">
      <h2 style="font-size: 20px; margin-bottom: 6px; text-align: center;">Personal WhatsApp AI</h2>
      <p style="color: var(--muted); font-size: 13px; text-align: center; margin-bottom: 20px;">Acesso ao Cockpit</p>
      
      <div style="display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px;">
        <button id="tab-login" style="flex: 1; border: none; background: transparent; color: var(--accent); font-weight: bold; border-bottom: 2px solid var(--accent); border-radius: 0; padding-bottom: 6px;" onclick="switchAuthTab('login')">Já tenho conta (Entrar)</button>
        <button id="tab-register" style="flex: 1; border: none; background: transparent; color: var(--muted); border-radius: 0; padding-bottom: 6px;" onclick="switchAuthTab('register')">Criar nova conta</button>
      </div>

      <div id="auth-error" style="display: none; color: #EF4444; font-size: 12px; margin-bottom: 12px; text-align: center;"></div>
      
      <div style="display: flex; flex-direction: column; gap: 12px;">
        <input id="auth-name" type="text" placeholder="Seu Nome Completo (ex: Ângelo Miguel)" style="display: none; padding: 10px 14px; background: #07080B; border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px;" />
        <input id="auth-user" type="text" placeholder="Nome de usuário (ex: admin ou omigueldev)" style="padding: 10px 14px; background: #07080B; border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px;" />
        <input id="auth-pass" type="password" placeholder="Sua Senha de Acesso" style="padding: 10px 14px; background: #07080B; border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px;" />
        
        <button id="btn-auth-submit" style="margin-top: 8px; padding: 12px; background: #22C55E; color: #07080B; font-weight: bold; border: none; border-radius: 6px; cursor: pointer;" onclick="handleAuthSubmit()">Entrar</button>
      </div>
      <p style="color: var(--muted); font-size: 11px; text-align: center; margin-top: 16px;">Sua sessão fica salva nesta aba e sincroniza os dados do seu WhatsApp.</p>
    </div>
  </div>

  <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
    <div>
      <div style="font-size: 14px; font-weight: 600;">Limite Diário de Respostas Automáticas</div>
      <div style="color: var(--muted); font-size: 12px; margin-top: 2px;">Número máximo de respostas autônomas que o assistente pode enviar por contato a cada dia.</div>
    </div>
    <div style="display: flex; gap: 8px; align-items: center;">
      <input id="input-daily-limit" type="number" min="1" max="200" value="5" style="width: 70px; padding: 6px 10px; background: #07080B; border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px; text-align: center;" />
      <button onclick="saveDailyLimit()" style="border-color: #22C55E; color: #22C55E;">Salvar Limite</button>
      <button onclick="resetQuotas()" style="border-color: var(--warn); color: var(--warn);">Zerar Contadores</button>
    </div>
  </div>

  <div id="qr-container" style="display: none; background: #11141C; border: 1px solid #22C55E; border-radius: 8px; padding: 20px; margin-bottom: 24px; text-align: center;">
    <h3 style="color: #22C55E; margin-bottom: 8px;">Conectar WhatsApp</h3>
    <p style="color: var(--muted); font-size: 13px; margin-bottom: 16px;">Abra o WhatsApp no seu celular > Aparelhos Conectados > Conectar Aparelho e aponte para o QR Code abaixo:</p>
    <div style="background: white; padding: 12px; display: inline-block; border-radius: 8px;">
      <img id="qr-image" src="" alt="WhatsApp QR Code" style="width: 250px; height: 250px; display: block;" />
    </div>
  </div>

  <div class="grid">
    <div class="stat-card">
      <div style="color: var(--muted); font-size: 12px;">MENSAGENS ANALISADAS</div>
      <div class="stat-val" id="metric-analyzed">0</div>
    </div>
    <div class="stat-card">
      <div style="color: var(--muted); font-size: 12px;">RESPOSTAS AUTÔNOMAS</div>
      <div class="stat-val" style="color: var(--accent);" id="metric-autoreplies">0</div>
    </div>
    <div class="stat-card">
      <div style="color: var(--muted); font-size: 12px;">PENDÊNCIAS OPERACIONAIS</div>
      <div class="stat-val" style="color: var(--warn);" id="metric-tasks">0</div>
    </div>
    <div class="stat-card">
      <div style="color: var(--muted); font-size: 12px;">FILA DE APROVAÇÃO</div>
      <div class="stat-val" style="color: var(--danger);" id="metric-approvals">0</div>
    </div>
  </div>

  <div class="section-title">Fila de Aprovação (Risco Nível 2 / Baixa Confiança)</div>
  <div class="table-container">
    <table id="approvals-table">
      <thead>
        <tr>
          <th>Contato</th>
          <th>Mensagem Recebida</th>
          <th>Resposta Proposta</th>
          <th>Motivo</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody id="approvals-body">
        <tr><td colspan="5" class="empty">Carregando fila...</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section-title">Heurísticas de Confiança (Busca Híbrida & Palavras-Chave)</div>
  <div style="background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 24px;">
    <div style="display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;">
      <input id="kw-input" type="text" placeholder="Cadastrar palavra ou expressão (ex: orçamento, portfólio, taxa)" style="flex: 1; min-width: 220px; padding: 8px 12px; background: #07080B; border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px;" />
      <select id="kw-cat" style="padding: 8px 12px; background: #07080B; border: 1px solid var(--border); color: var(--text); border-radius: 6px; font-size: 13px;">
        <option value="high_confidence">Alta Confiança (Auto-Reply)</option>
        <option value="review">Revisão Humana (Exige Aprovação)</option>
        <option value="blocked">Bloqueio Total (Nível 3)</option>
      </select>
      <button style="border-color: #22C55E; color: #22C55E;" onclick="addKeyword()">+ Cadastrar Palavra</button>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Termo Cadastrado</th>
            <th>Impacto na Decisão</th>
            <th>Peso</th>
            <th>Descrição</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody id="keywords-body">
          <tr><td colspan="5" class="empty">Carregando regras...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Conversas Importantes / Destaques Executivos -->
  <div style="background: var(--card); border: 1px solid rgba(234, 179, 8, 0.3); border-radius: 8px; padding: 20px; margin-bottom: 24px; box-shadow: 0 4px 20px rgba(234, 179, 8, 0.05);">
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
      <div>
        <h3 style="font-size: 15px; font-weight: 600; color: #EAB308; display: flex; align-items: center; gap: 8px;">
          <span>⭐</span> Conversas Importantes (Resumo, Decisão Tomada & O que Aguarda)
        </h3>
        <p style="color: var(--muted); font-size: 12px; margin-top: 4px;">Assuntos estratégicos identificados automaticamente (orçamentos, propostas, contratos, prazos e compromissos).</p>
      </div>
      <button style="font-size: 11px; padding: 6px 10px;" onclick="loadData()">Atualizar</button>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Contato</th>
            <th>Assunto / Tópico</th>
            <th>Resumo do Contexto</th>
            <th>Decisão Tomada</th>
            <th>O que Aguarda</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody id="important-body">
          <tr><td colspan="7" class="empty">Nenhuma conversa prioritária ativa no momento.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="section-title">Auditoria em Tempo Real (Decisões Determinísticas)</div>
  <div class="table-container">
    <table id="audit-table">
      <thead>
        <tr>
          <th>Horário</th>
          <th>Contato</th>
          <th>Mensagem</th>
          <th>Risco</th>
          <th>Decisão Final</th>
          <th>Motivo / Regra</th>
        </tr>
      </thead>
      <tbody id="audit-body">
        <tr><td colspan="6" class="empty">Nenhum log registrado.</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    function getAuthHeaders(includeContentType = false) {
      const token = localStorage.getItem('tenant_token') || sessionStorage.getItem('tenant_token');
      const headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;
      if (includeContentType) headers['Content-Type'] = 'application/json';
      return headers;
    }

    async function checkAuth() {
      const token = localStorage.getItem('tenant_token') || sessionStorage.getItem('tenant_token');
      const overlay = document.getElementById('auth-overlay');
      if (!token) {
        overlay.style.display = 'flex';
        return false;
      }
      try {
        const res = await fetch('/api/auth/me', { headers: getAuthHeaders() });
        if (!res.ok) {
          localStorage.removeItem('tenant_token');
          sessionStorage.removeItem('tenant_token');
          overlay.style.display = 'flex';
          return false;
        }
        const data = await res.json();
        overlay.style.display = 'none';
        document.getElementById('tenant-tag').textContent = '[' + data.tenant.name + ' - @' + data.tenant.username + ']';
        return true;
      } catch {
        overlay.style.display = 'flex';
        return false;
      }
    }

    let currentAuthMode = 'login';

    function switchAuthTab(mode) {
      currentAuthMode = mode;
      const tabLogin = document.getElementById('tab-login');
      const tabRegister = document.getElementById('tab-register');
      const nameInput = document.getElementById('auth-name');
      const btnSubmit = document.getElementById('btn-auth-submit');
      const errBox = document.getElementById('auth-error');
      errBox.style.display = 'none';

      if (mode === 'login') {
        tabLogin.style.color = 'var(--accent)';
        tabLogin.style.fontWeight = 'bold';
        tabLogin.style.borderBottom = '2px solid var(--accent)';
        tabRegister.style.color = 'var(--muted)';
        tabRegister.style.fontWeight = 'normal';
        tabRegister.style.borderBottom = 'none';
        nameInput.style.display = 'none';
        btnSubmit.textContent = 'Entrar na Conta';
      } else {
        tabRegister.style.color = 'var(--accent)';
        tabRegister.style.fontWeight = 'bold';
        tabRegister.style.borderBottom = '2px solid var(--accent)';
        tabLogin.style.color = 'var(--muted)';
        tabLogin.style.fontWeight = 'normal';
        tabLogin.style.borderBottom = 'none';
        nameInput.style.display = 'block';
        btnSubmit.textContent = 'Criar Conta e Acessar';
      }
    }

    async function handleAuthSubmit() {
      const name = document.getElementById('auth-name').value.trim();
      const username = document.getElementById('auth-user').value.trim();
      const password = document.getElementById('auth-pass').value.trim();
      const errBox = document.getElementById('auth-error');

      errBox.style.display = 'none';
      if (!username || !password) {
        errBox.textContent = 'Preencha usuário e senha';
        errBox.style.display = 'block';
        return;
      }

      const endpoint = currentAuthMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const payload = currentAuthMode === 'login'
        ? { username, password }
        : { name: name || username, username, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.success && data.token) {
        localStorage.setItem('tenant_token', data.token);
        sessionStorage.setItem('tenant_token', data.token);
        document.getElementById('auth-overlay').style.display = 'none';
        checkAuth();
        loadData();
      } else {
        errBox.textContent = data.error || 'Erro na autenticação. Verifique usuário e senha.';
        errBox.style.display = 'block';
      }
    }

    function logout() {
      localStorage.removeItem('tenant_token');
      sessionStorage.removeItem('tenant_token');
      location.reload();
    }

    function formatContactDisplay(contactId, contactName) {
      if (contactName && contactName.trim()) {
        return '<strong>' + contactName + '</strong><br><span style=\"color:var(--muted); font-size:11px;\">' + contactId + '</span>';
      }
      return '<span>' + contactId + '</span>';
    }

    async function loadData() {
      if (!localStorage.getItem('tenant_token') && !sessionStorage.getItem('tenant_token')) {
        document.getElementById('auth-overlay').style.display = 'flex';
        return;
      }
      try {
        const res = await fetch('/api/overview', { headers: getAuthHeaders() });
        if (res.status === 401) {
          logout();
          return;
        }
        const data = await res.json();
        document.getElementById('metric-analyzed').textContent = data.totalMessagesAnalyzed;
        document.getElementById('metric-autoreplies').textContent = data.autoRepliesSent;
        document.getElementById('metric-tasks').textContent = data.pendingTasksCount;
        document.getElementById('metric-approvals').textContent = data.pendingApprovalsCount;
        
        const limitInput = document.getElementById('input-daily-limit');
        if (document.activeElement !== limitInput && data.maxDailyAutoReplies) {
          limitInput.value = data.maxDailyAutoReplies;
        }
        
        // Check Gateway QR Status
        const gwRes = await fetch('/api/gateway/status', { headers: getAuthHeaders() });
        const gwData = await gwRes.json();
        const qrContainer = document.getElementById('qr-container');
        const qrImage = document.getElementById('qr-image');
        const connBadge = document.getElementById('connection-badge');
        const btnConnect = document.getElementById('btn-connect');

        if (gwData.status === 'connected') {
          connBadge.textContent = '● CONECTADO';
          connBadge.style.display = 'inline-block';
          connBadge.style.color = '#22C55E';
          connBadge.style.borderColor = '#22C55E';
          btnConnect.style.display = 'none';
          qrContainer.style.display = 'none'; // Keep header clean once connected
        } else if (gwData.qrDataUrl && gwData.status === 'qr_ready') {
          connBadge.textContent = '○ AGUARDANDO LEITURA DO QR';
          connBadge.style.color = 'var(--warn)';
          connBadge.style.borderColor = 'var(--warn)';
          btnConnect.style.display = 'none';
          qrImage.src = gwData.qrDataUrl;
          qrContainer.style.display = 'block';
        } else {
          connBadge.textContent = '○ DESCONECTADO';
          connBadge.style.color = 'var(--muted)';
          connBadge.style.borderColor = 'var(--border)';
          btnConnect.style.display = 'inline-block';
          qrContainer.style.display = 'none';
        }

        // Load Approvals
        const appRes = await fetch('/api/approvals', { headers: getAuthHeaders() });
        const approvals = await appRes.json();
        const appBody = document.getElementById('approvals-body');
        if (approvals.length === 0) {
          appBody.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma mensagem aguardando aprovação.</td></tr>';
        } else {
          appBody.innerHTML = approvals.map(a => \`
            <tr>
              <td>\${formatContactDisplay(a.contactId, a.contactName)}</td>
              <td>\${a.originalMessage}</td>
              <td><strong>\${a.suggestedResponse}</strong></td>
              <td>\${a.reason}</td>
              <td>
                <button onclick="approve('\${a.id}')">Aprovar</button>
                <button class="btn-danger" onclick="reject('\${a.id}')">Rejeitar</button>
              </td>
            </tr>
          \`).join('');
        }

        // Load Heuristic Keywords
        const kwRes = await fetch('/api/heuristics/keywords', { headers: getAuthHeaders() });
        const keywords = await kwRes.json();
        const kwBody = document.getElementById('keywords-body');
        if (keywords.length === 0) {
          kwBody.innerHTML = '<tr><td colspan="5" class="empty">Nenhuma regra cadastrada.</td></tr>';
        } else {
          kwBody.innerHTML = keywords.map(k => {
            const badgeColor = k.category === 'high_confidence' ? 'var(--accent)' : k.category === 'review' ? 'var(--warn)' : 'var(--danger)';
            return \`
              <tr>
                <td><strong>\${k.word}</strong></td>
                <td><span style="color: \${badgeColor}">\${k.category}</span></td>
                <td>\${k.weight}%</td>
                <td>\${k.description || '-'}</td>
                <td>
                  <button class="btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="deleteKeyword('\${k.id}')">Excluir</button>
                </td>
              </tr>
            \`;
          }).join('');
        }

        // Load Important Conversations (Executive Highlights)
        const impRes = await fetch('/api/conversations/important', { headers: getAuthHeaders() });
        const importList = await impRes.json();
        const impBody = document.getElementById('important-body');
        if (importList.length === 0) {
          impBody.innerHTML = '<tr><td colspan="7" class="empty">Nenhuma conversa prioritária ativa no momento.</td></tr>';
        } else {
          impBody.innerHTML = importList.map(item => {
            const statusBadge = item.status === 'pending_action'
              ? '<span style="color:#EF4444; font-weight:bold;">● Ação Necessária</span>'
              : item.status === 'waiting_interlocutor'
              ? '<span style="color:#EAB308; font-weight:bold;">⏳ Aguardando Contato</span>'
              : '<span style="color:#22C55E; font-weight:bold;">✓ Resolvido</span>';

            return \`
              <tr>
                <td>\${formatContactDisplay(item.contactId, item.contactName)}</td>
                <td><strong style="color: #EAB308;">\${item.topic}</strong></td>
                <td style="max-width: 260px; font-size: 12px;">\${item.summary}</td>
                <td style="font-size: 12px; color: var(--text);">\${item.lastDecisionTaken}</td>
                <td style="font-size: 12px; color: #38BDF8; font-weight: 500;">\${item.waitingFor}</td>
                <td>\${statusBadge}</td>
                <td>
                  <button class="btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="dismissImportant('\${item.id}')">Concluir</button>
                </td>
              </tr>
            \`;
          }).join('');
        }

        // Load Audit Logs
        const auditRes = await fetch('/api/audit', { headers: getAuthHeaders() });
        const logs = await auditRes.json();
        const auditBody = document.getElementById('audit-body');
        if (logs.length === 0) {
          auditBody.innerHTML = '<tr><td colspan="6" class="empty">Nenhum evento registrado ainda.</td></tr>';
        } else {
          auditBody.innerHTML = logs.slice(0, 10).map(l => \`
            <tr>
              <td>\${new Date(l.timestamp).toLocaleTimeString()}</td>
              <td>\${formatContactDisplay(l.contactId, l.contactName)}</td>
              <td>\${l.rawInput}</td>
              <td>Nível \${l.riskLevel}</td>
              <td><span style="color: \${l.finalDecision === 'AUTO_REPLY' ? 'var(--accent)' : 'var(--warn)'}">\${l.finalDecision}</span></td>
              <td>\${l.blockedReason || l.reason}</td>
            </tr>
          \`).join('');
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function connectWhatsApp() {
      await fetch('/api/gateway/connect', { method: 'POST', headers: getAuthHeaders(true), body: '{}' });
      loadData();
    }

    async function setMode(mode) {
      await fetch('/api/autonomy/mode', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ mode })
      });
      loadData();
    }

    async function approve(id) {
      await fetch(\`/api/approvals/\${id}/approve\`, { method: 'POST', headers: getAuthHeaders() });
      loadData();
    }

    async function reject(id) {
      await fetch(\`/api/approvals/\${id}/reject\`, { method: 'POST', headers: getAuthHeaders() });
      loadData();
    }

    async function addKeyword() {
      const input = document.getElementById('kw-input');
      const cat = document.getElementById('kw-cat');
      const word = input.value.trim();
      if (!word) return;

      await fetch('/api/heuristics/keywords', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ word, category: cat.value })
      });
      input.value = '';
      loadData();
    }

    async function deleteKeyword(id) {
      await fetch(\`/api/heuristics/keywords/\${id}\`, { method: 'DELETE', headers: getAuthHeaders() });
      loadData();
    }

    async function dismissImportant(id) {
      await fetch(\`/api/conversations/important/\${id}\`, { method: 'DELETE', headers: getAuthHeaders() });
      loadData();
    }

    async function saveDailyLimit() {
      const input = document.getElementById('input-daily-limit');
      const val = Number(input.value);
      if (!val || val < 1) return;

      const res = await fetch('/api/autonomy/limit', {
        method: 'POST',
        headers: getAuthHeaders(true),
        body: JSON.stringify({ limit: val })
      });
      const data = await res.json();
      if (data.success) {
        alert('Limite diário atualizado e salvo no banco de dados com sucesso!');
      } else {
        alert(data.error || 'Erro ao salvar limite.');
      }
      loadData();
    }

    async function resetQuotas() {
      await fetch('/api/contacts/reset-quotas', { method: 'POST', headers: getAuthHeaders() });
      alert('Cotas diárias de todos os contatos foram zeradas!');
      loadData();
    }

    setInterval(loadData, 3000);
    checkAuth().then((authed) => { if (authed) loadData(); });
  </script>
</body>
</html>`;
  });

  return app;
}
