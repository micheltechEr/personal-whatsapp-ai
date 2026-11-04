import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import { ResponseGenerator } from '../src/intelligence/ResponseGenerator.js';
import { PersonalityEngine } from '../src/intelligence/PersonalityEngine.js';
import { NormalizedMessage } from '../src/types/index.js';

describe('Owner Facts & Absolute Truths (No Alucination on Relationships)', () => {
  let testDir: string;
  let storage: MemoryFileStorageAdapter;

  beforeEach(async () => {
    testDir = path.join(process.cwd(), `.test_facts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  it('stores and retrieves personal facts', async () => {
    await storage.saveOwnerFact({
      id: 'fact-1',
      topic: 'Relacionamento',
      fact: 'Namoro com a Anny, sou comprometido e fiel.',
      createdAt: Date.now(),
    });

    const facts = await storage.getOwnerFacts();
    expect(facts.length).toBe(1);
    expect(facts[0].fact).toContain('Namoro com a Anny');
  });

  it('incorporates tenant-specific facts into the prompt', async () => {
    const personality = new PersonalityEngine('Amanda');
    const generator = new ResponseGenerator(personality, undefined, undefined, undefined, undefined, storage);

    await storage.saveOwnerFact({
      id: 'fact-amanda-vendas',
      tenantId: 'tenant-amanda',
      topic: 'Personalidade',
      fact: "Vendedora implacável com 'N' habilidades de vendas",
      createdAt: Date.now(),
    }, 'tenant-amanda');

    const facts = await storage.getOwnerFacts('tenant-amanda');
    expect(facts.length).toBe(1);
    expect(facts[0].fact).toContain('Vendedora implacável');
  });
});
