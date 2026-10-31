import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MemoryFileStorageAdapter } from '../src/storage/MemoryFileStorageAdapter.js';
import {
  isJidGroup,
  cleanContactJid,
  normalizeBaileysMessage,
  extractMessageContent,
} from '../src/gateway/MessageNormalizer.js';
import { NormalizedMessage } from '../src/types/index.js';

describe('Phase 1 - Infrastructure & WhatsApp Normalization', () => {
  const testDir = path.resolve(process.cwd(), '.test_data_' + Date.now());
  let storage: MemoryFileStorageAdapter;

  beforeEach(async () => {
    storage = new MemoryFileStorageAdapter(testDir);
    await storage.init();
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Group Filtering & JID Normalization', () => {
    it('strictly identifies and flags group jids', () => {
      expect(isJidGroup('123456789-987654@g.us')).toBe(true);
      expect(isJidGroup('community123@temp')).toBe(true);
      expect(isJidGroup('status@broadcast')).toBe(true);
      expect(isJidGroup('5571999998888@s.whatsapp.net')).toBe(false);
      expect(isJidGroup('5571999998888:12@s.whatsapp.net')).toBe(false);
    });

    it('cleans contact JID properly to canonical phone number / id', () => {
      expect(cleanContactJid('5571988887777:2@s.whatsapp.net')).toBe('5571988887777');
      expect(cleanContactJid('5571988887777@s.whatsapp.net')).toBe('5571988887777');
      expect(cleanContactJid('contact_lid_123@lid')).toBe('contact_lid_123');
    });

    it('returns null and drops message when raw message is from a group', () => {
      const groupMsg = {
        key: {
          remoteJid: '120363024888888888@g.us',
          fromMe: false,
          id: 'test-group-msg-1',
        },
        message: {
          conversation: 'Hello group!',
        },
      };

      const result = normalizeBaileysMessage(groupMsg as any);
      expect(result).toBeNull();
    });
  });

  describe('Message Content Extraction & Normalization', () => {
    it('extracts plain conversation text correctly', () => {
      const msg = {
        key: {
          remoteJid: '5571988887777@s.whatsapp.net',
          fromMe: false,
          id: 'msg-1',
        },
        pushName: 'Carlos',
        message: {
          conversation: 'Oi, tudo bem?',
        },
        messageTimestamp: 1700000000,
      };

      const result = normalizeBaileysMessage(msg as any);
      expect(result).not.toBeNull();
      expect(result?.id).toBe('msg-1');
      expect(result?.contactId).toBe('5571988887777');
      expect(result?.senderName).toBe('Carlos');
      expect(result?.content).toBe('Oi, tudo bem?');
      expect(result?.type).toBe('text');
      expect(result?.isGroup).toBe(false);
      expect(result?.fromMe).toBe(false);
    });

    it('extracts extended text messages', () => {
      const msg = {
        key: {
          remoteJid: '5571988887777@s.whatsapp.net',
          fromMe: false,
          id: 'msg-ext-1',
        },
        message: {
          extendedTextMessage: {
            text: 'Segue o link do projeto https://example.com',
          },
        },
      };

      const result = normalizeBaileysMessage(msg as any);
      expect(result?.content).toBe('Segue o link do projeto https://example.com');
      expect(result?.type).toBe('text');
    });

    it('handles image with and without caption', () => {
      const imgWithCaption = {
        imageMessage: { caption: 'Foto do contrato' },
      };
      const imgWithoutCaption = {
        imageMessage: {},
      };

      expect(extractMessageContent(imgWithCaption as any)).toEqual({
        content: 'Foto do contrato',
        type: 'image',
      });
      expect(extractMessageContent(imgWithoutCaption as any)).toEqual({
        content: '[Imagem]',
        type: 'image',
      });
    });

    it('handles audio and document messages', () => {
      const audio = { audioMessage: {} };
      const doc = { documentMessage: { fileName: 'relatorio.pdf' } };

      expect(extractMessageContent(audio as any)).toEqual({
        content: '[Áudio]',
        type: 'audio',
      });
      expect(extractMessageContent(doc as any)).toEqual({
        content: 'relatorio.pdf',
        type: 'document',
      });
    });
  });

  describe('Storage Adapter', () => {
    it('persists and retrieves normalized messages', async () => {
      const msg: NormalizedMessage = {
        id: 'msg-store-1',
        contactId: '5571999990000',
        content: 'Teste de persistência',
        timestamp: Date.now(),
        fromMe: false,
        isGroup: false,
        type: 'text',
      };

      await storage.saveMessage(msg);
      const retrieved = await storage.getMessage('msg-store-1');
      expect(retrieved).toEqual(msg);

      const recent = await storage.getRecentMessages('5571999990000');
      expect(recent.length).toBe(1);
      expect(recent[0].content).toBe('Teste de persistência');
    });

    it('enforces idempotency on sent messages', async () => {
      const firstTry = await storage.recordSentMessage('send-123', 'contact-1', 'Resposta');
      expect(firstTry).toBe(true);

      const secondTry = await storage.recordSentMessage('send-123', 'contact-1', 'Resposta');
      expect(secondTry).toBe(false);

      expect(await storage.isMessageAlreadySent('send-123')).toBe(true);
      expect(await storage.isMessageAlreadySent('unknown-id')).toBe(false);
    });
  });
});
