# PERSONAL WHATSAPP AI
## Autonomous Controlled Personal Communication Agent

Assistente pessoal inteligente integrado ao WhatsApp via Baileys com autonomia controlada determinística (`AUTONOMOUS_CONTROLLED`).

---

### Funcionalidades Implementadas

1. **WhatsApp Gateway (`@whiskeysockets/baileys`)**
   - Conexão e sincronização via QR Code / Multi-file auth.
   - Reconexão com backoff exponencial.
   - Filtro antecipado de grupos: grupos descartados imediatamente no limiar de entrada.

2. **Processador & Debounce de Mensagens (H02/H09/H15)**
   - Agrupamento temporal de mensagens consecutivas enviadas em sequência.
   - Detecção de resposta manual pelo proprietário com cancelamento imediato de respostas automáticas pendentes.

3. **Motores de Inteligência**
   - **RiskEngine**: Matriz em 4 níveis (0: Risco muito baixo, 1: Risco baixo, 2: Moderado, 3: Risco alto).
   - **IntentClassifier**: Identificação de intenções, saudações, urgências operacionais e silêncio inteligente (H03/H10/H16).
   - **ContextEngine**: Histórico consolidado por contato, memórias e fatos operacionais.
   - **PersonalityEngine**: Estilo conciso do proprietário, sem clichês de IA corporativa, com adaptação ao interlocutor e feedback loop.
   - **ResponseGenerator**: Decisões baseadas em evidências com respeito a contexto insuficiente (H05).

4. **Controlador de Autonomia & Despacho**
   - Precedência determinística: Exclusão -> Segurança -> Risco -> Quotas -> Confiança.
   - O LLM nunca acessa o despachante diretamente.
   - MessageDispatcher com garantia de idempotência estrita, proteção contra loops e botão de emergência.

5. **Dashboard & API Cockpit**
   - Interface web dark moderna em Fastify (`http://localhost:3000`).
   - Métricas em tempo real, fila de aprovação (aprovar, editar, rejeitar), caixa de entrada inteligente e trilha de auditoria.

---

### Comandos de Execução

```bash
# Instalação de dependências
npm install

# Execução da suíte completa de 25 testes (Critérios Obrigatórios da Seção 15)
npm test

# Build do TypeScript
npm run build

# Execução local da API e Dashboard
npm run dev
```

### Variáveis de Ambiente (.env)

```env
PORT=3000
DATABASE_URL= # Opcional: se fornecido conecta ao Postgres, caso contrário usa adaptador local
START_WHATSAPP=false # Defina como true para conectar ao WhatsApp e gerar QR Code
```
