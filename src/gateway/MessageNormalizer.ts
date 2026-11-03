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

  // Video or GIF
  if (message.videoMessage) {
    const isGif = Boolean(message.videoMessage.gifPlayback);
    const caption = message.videoMessage.caption ? message.videoMessage.caption.trim() : '';
    return {
      content: caption || (isGif ? '[GIF]' : '[Vídeo]'),
      type: isGif ? 'sticker' : 'video',
    };
  }

  // Document
  if (message.documentMessage) {
    const title = message.documentMessage.title || message.documentMessage.fileName || '[Documento]';
    return { content: title, type: 'document' };
  }

  // Sticker / Figurinha
  if (message.stickerMessage) {
    return { content: '[Figurinha]', type: 'sticker' };
  }

  // Protocol / reaction / ephemeral
  if (message.protocolMessage) {
    return { content: '[Mensagem do Sistema]', type: 'other' };
  }

  return { content: '', type: 'other' };
}

export function normalizeBaileysMessage(rawMsg: proto.IWebMessageInfo, allowGroups: boolean = false): NormalizedMessage | null {
  const key = rawMsg.key;
  if (!key || !key.remoteJid) return null;

  const remoteJid = key.remoteJid;
  const isGroup = isJidGroup(remoteJid);

  // STRICT REQUIREMENT: Exclude all group chats unless expressly enabled
  if (isGroup && !allowGroups) {
    return null;
  }

  const { content, type } = extractMessageContent(rawMsg.message);
  
  // Prioriza o número de telefone (JID) real ao invés do LID numérico
  let contactJid = remoteJid;
  let lid: string | undefined = undefined;
  const remoteJidAlt = (key as any)?.remoteJidAlt as string | undefined;

  if (remoteJid.includes('@lid')) {
    lid = cleanContactJid(remoteJid);
    if (remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
      contactJid = remoteJidAlt;
    }
  } else if (remoteJid.includes('@s.whatsapp.net')) {
    contactJid = remoteJid;
    if (remoteJidAlt && remoteJidAlt.includes('@lid')) {
      lid = cleanContactJid(remoteJidAlt);
    }
  }

  const contactId = cleanContactJid(contactJid);
  const id = key.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const timestamp = typeof rawMsg.messageTimestamp === 'number'
    ? rawMsg.messageTimestamp * 1000
    : Date.now();

  const isStickerOrGif =
    Boolean(rawMsg.message?.stickerMessage) ||
    Boolean(rawMsg.message?.videoMessage?.gifPlayback);

  const mimetype =
    rawMsg.message?.stickerMessage?.mimetype ||
    (rawMsg.message?.videoMessage?.gifPlayback ? 'image/gif' : undefined) ||
    rawMsg.message?.imageMessage?.mimetype ||
    rawMsg.message?.audioMessage?.mimetype ||
    rawMsg.message?.videoMessage?.mimetype ||
    undefined;

  // Extrai referência contextual explícita (contextInfo / stanzaId / quotedMessage)
  let quoted: NormalizedMessage['quoted'] = undefined;
  const rawContextInfo =
    rawMsg.message?.extendedTextMessage?.contextInfo ||
    rawMsg.message?.imageMessage?.contextInfo ||
    rawMsg.message?.videoMessage?.contextInfo ||
    rawMsg.message?.audioMessage?.contextInfo ||
    rawMsg.message?.stickerMessage?.contextInfo ||
    rawMsg.message?.documentMessage?.contextInfo;

  if (rawContextInfo && rawContextInfo.stanzaId) {
    const quotedContent = extractMessageContent(rawContextInfo.quotedMessage);
    quoted = {
      stanzaId: rawContextInfo.stanzaId,
      participant: rawContextInfo.participant || undefined,
      quotedMessage: quotedContent.content || undefined,
      quotedType: quotedContent.type,
    };
  }

  return {
    id,
    contactId,
    contactJid,
    lid,
    remoteJid,
    senderName: !Boolean(key.fromMe) ? rawMsg.pushName || undefined : undefined,
    content,
    timestamp,
    fromMe: Boolean(key.fromMe),
    isGroup,
    type,
    mimetype,
    quoted,
    raw: rawMsg,
  };
}
