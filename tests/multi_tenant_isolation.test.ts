import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { TenantManager } from '../src/tenant/TenantManager.js';

describe('Multi-Tenant Architecture & Behavioral Isolation', () => {
  const testDir = path.resolve(process.cwd(), '.test_tenant_' + Date.now());
  let storage: MemoryFileStorageAdapter;
  let tenantManager: TenantManager;

  beforeEach(async () => {
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
    tenantManager = new TenantManager(storage, path.join(testDir, 'auth'));
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('allows user registration and login with password isolation', async () => {
    const reg = await tenantManager.register('Carlos Lima', 'carlos', 'senha123');
    expect(reg.success).toBe(true);
    expect(reg.token).toBeDefined();
    expect(reg.tenant?.username).toBe('carlos');

    // Reject wrong password
    const failLogin = await tenantManager.login('carlos', 'errada');
    expect(failLogin.success).toBe(false);

    // Accept right password
    const okLogin = await tenantManager.login('carlos', 'senha123');
    expect(okLogin.success).toBe(true);
    expect(okLogin.token).toBeDefined();
  });

  it('creates completely isolated runtime containers for different tenants', async () => {
    const t1 = (await tenantManager.register('User One', 'user1', 'pass123')).tenant!;
    const t2 = (await tenantManager.register('User Two', 'user2', 'pass123')).tenant!;

    const r1 = await tenantManager.getOrCreateRuntime(t1);
    const r2 = await tenantManager.getOrCreateRuntime(t2);

    expect(r1).not.toBe(r2);
    expect(r1.gateway).not.toBe(r2.gateway);
    expect(r1.styleRAG).not.toBe(r2.styleRAG);
    expect(r1.personalityEngine.getOwnerName()).toBe('User One');
    expect(r2.personalityEngine.getOwnerName()).toBe('User Two');
    expect(r1.autonomyController).not.toBe(r2.autonomyController);
  });

  it('strictly isolates stored messages and RAG memory between tenants', async () => {
    const t1 = (await tenantManager.register('User One', 'user1', 'pass123')).tenant!;
    const t2 = (await tenantManager.register('User Two', 'user2', 'pass123')).tenant!;

    // Save message for Tenant 1
    await storage.saveMessage(
      {
        id: 'msg-t1',
        contactId: 'client-99',
        content: 'Informação confidencial do Tenant 1',
        timestamp: Date.now(),
        fromMe: false,
        isGroup: false,
        type: 'text',
      },
      t1.id
    );

    // Save message for Tenant 2
    await storage.saveMessage(
      {
        id: 'msg-t2',
        contactId: 'client-99',
        content: 'Conversa privada do Tenant 2',
        timestamp: Date.now(),
        fromMe: false,
        isGroup: false,
        type: 'text',
      },
      t2.id
    );

    const msgsT1 = await storage.getRecentMessages('client-99', 10, t1.id);
    const msgsT2 = await storage.getRecentMessages('client-99', 10, t2.id);

    expect(msgsT1.length).toBe(1);
    expect(msgsT1[0].content).toBe('Informação confidencial do Tenant 1');

    expect(msgsT2.length).toBe(1);
    expect(msgsT2[0].content).toBe('Conversa privada do Tenant 2');
  });

  it('isolates keyword rules between tenants', async () => {
    const t1 = (await tenantManager.register('User One', 'user1', 'pass123')).tenant!;
    const t2 = (await tenantManager.register('User Two', 'user2', 'pass123')).tenant!;

    await storage.saveKeywordRule(
      {
        id: 'kw-1',
        word: 'termo-exclusivo-t1',
        category: 'review',
        weight: 90,
      },
      t1.id
    );

    const t1Rules = await storage.getKeywordRules(t1.id);
    const t2Rules = await storage.getKeywordRules(t2.id);

    expect(t1Rules.some((r) => r.word === 'termo-exclusivo-t1')).toBe(true);
    expect(t2Rules.some((r) => r.word === 'termo-exclusivo-t1')).toBe(false);
  });
});
