import type { proto } from '@whiskeysockets/baileys';
import { NormalizedMessage } from '../types/index.js';

export function isJidGroup(jid: string): boolean {
  if (!jid) return false;
  return (
    jid.endsWith('@g.us') ||
    jid.includes('@temp') ||
    jid.includes('broadcast') ||
    jid.includes('@newsletter') ||
    jid.includes('newsletter') ||
    jid.startsWith('120363')
  );
}

export function cleanContactJid(jid: string): string {
  if (!jid) return '';
  // Convert xxx@s.whatsapp.net or xxx@lid into bare canonical format
  return jid.split('@')[0].split(':')[0];
}

export function extractMessageContent(message: proto.IMessage | null | undefined): {
  content: string;
  type: NormalizedMessage['type'];
} {
  if (!message) {
    return { content: '', type: 'other' };
  }

  // Conversation text
  if (message.conversation) {
    return { content: message.conversation.trim(), type: 'text' };
  }

  // Extended text
  if (message.extendedTextMessage?.text) {
    return { content: message.extendedTextMessage.text.trim(), type: 'text' };
  }

  // Image with caption or just image
  if (message.imageMessage) {
    const caption = message.imageMessage.caption ? message.imageMessage.caption.trim() : '';
    return { content: caption || '[Imagem]', type: 'image' };
  }

  // Audio / Voice note
  if (message.audioMessage) {
    return { content: '[Áudio]', type: 'audio' };
  }

  // Video
  if (message.videoMessage) {
    const caption = message.videoMessage.caption ? message.videoMessage.caption.trim() : '';
    return { content: caption || '[Vídeo]', type: 'video' };
  }

  // Document
  if (message.documentMessage) {
    const title = message.documentMessage.title || message.documentMessage.fileName || '[Documento]';
    return { content: title, type: 'document' };
  }

  // Sticker / Figurinha
  if (message.stickerMessage) {
    return { content: '[Figurinha]', type: 'other' };
  }

  // Protocol / reaction / ephemeral
  if (message.protocolMessage) {
    return { content: '[Mensagem do Sistema]', type: 'other' };
  }

  return { content: '', type: 'other' };
}

export function normalizeBaileysMessage(rawMsg: proto.IWebMessageInfo): NormalizedMessage | null {
  const key = rawMsg.key;
  if (!key || !key.remoteJid) return null;

  const remoteJid = key.remoteJid;

  // STRICT REQUIREMENT: Exclude all group chats immediately
  if (isJidGroup(remoteJid)) {
    return null;
  }

  const { content, type } = extractMessageContent(rawMsg.message);
  const contactId = cleanContactJid(remoteJid);
  const id = key.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = typeof rawMsg.messageTimestamp === 'number'
    ? rawMsg.messageTimestamp * 1000
    : Date.now();

  return {
    id,
    contactId,
    remoteJid,
    senderName: rawMsg.pushName || undefined,
    content,
    timestamp,
    fromMe: Boolean(key.fromMe),
    isGroup: false,
    type,
    raw: rawMsg,
  };
}
