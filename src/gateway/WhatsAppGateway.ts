import path from 'node:path';
import EventEmitter from 'node:events';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  ConnectionState,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode';
import { normalizeBaileysMessage, isJidGroup } from './MessageNormalizer.js';
import { NormalizedMessage } from '../types/index.js';
import { StorageAdapter } from '../storage/StorageAdapter.js';

export interface GatewayEvents {
  qr: (qr: string) => void;
  ready: () => void;
  disconnected: (reason: string) => void;
  message: (msg: NormalizedMessage) => void;
  message_update: (update: { id: string; remoteJid: string; update: unknown }) => void;
  error: (err: Error) => void;
}

import { GroqAudioTranscriber } from '../intelligence/GroqAudioTranscriber.js';

export class WhatsAppGateway extends EventEmitter {
  private socket: WASocket | null = null;
  private authDir: string;
  private isConnecting = false;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private qrCode: string | null = null;
  private connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'qr_ready' = 'disconnected';
  private lidMapping: Map<string, string> = new Map(); // contactId -> remoteJid
  private logger = pino({ level: 'silent' });
  private audioTranscriber: GroqAudioTranscriber;
  private storage?: StorageAdapter;
  private tenantId?: string;

  constructor(
    authDir?: string,
    audioTranscriber?: GroqAudioTranscriber,
    storage?: StorageAdapter,
    tenantId?: string
  ) {
    super();
    this.authDir = authDir || path.resolve(process.cwd(), '.baileys_auth');
    this.audioTranscriber = audioTranscriber || new GroqAudioTranscriber();
    this.storage = storage;
    this.tenantId = tenantId;
  }

  public setStorage(storage: StorageAdapter): void {
    this.storage = storage;
  }

  public setTenantId(tenantId: string): void {
    this.tenantId = tenantId;
  }

  public async syncParticipatingGroups(): Promise<void> {
    if (!this.socket || !this.storage) return;
    try {
      if (typeof this.socket.groupFetchAllParticipating === 'function') {
        const groupsMap = await this.socket.groupFetchAllParticipating();
        const existingGroups = await this.storage.getGroups();
        const existingMap = new Map(existingGroups.map((g) => [g.id, g]));

        for (const [jid, groupData] of Object.entries(groupsMap)) {
          const prev = existingMap.get(jid);
          await this.storage.saveGroup({
            id: jid,
            name: (groupData as any).subject || prev?.name || 'Grupo do WhatsApp',
            participantCount: (groupData as any).participants?.length || undefined,
            lastMessage: prev?.lastMessage || 'Nenhuma mensagem recente registrada',
            lastActivityTimestamp: prev?.lastActivityTimestamp || Date.now(),
            botEnabled: prev ? prev.botEnabled : false,
          });
        }
        console.log(`[WhatsAppGateway] Sincronizados ${Object.keys(groupsMap).length} grupos participantes.`);
      }
    } catch (e: any) {
      console.warn('[WhatsAppGateway] Não foi possível listar grupos participantes:', e.message);
    }
  }

  public async getQrDataUrl(): Promise<string | null> {
    if (!this.qrCode) return null;
    try {
      return await qrcodeTerminal.toDataURL(this.qrCode);
    } catch {
      return null;
    }
  }

  public getStatus(): { status: string; qr: string | null; reconnectAttempts: number } {
    console.log(`[WhatsAppGateway] getStatus() chamado -> ${this.connectionStatus}`);
    return {
      status: this.connectionStatus,
      qr: this.qrCode,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  public async start(): Promise<void> {
    console.log('[WhatsAppGateway] Método start() chamado');
    if (this.isConnecting || this.socket) {
      console.log('[WhatsAppGateway] Já conectando ou socket existente, abortando novo start()');
      return;
    }
    this.isConnecting = true;
    this.connectionStatus = 'connecting';

    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

      this.socket = makeWASocket({
        auth: state,
        logger: this.logger as any,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false,
      });

      this.socket.ev.on('creds.update', saveCreds);

      this.socket.ev.on('connection.update', (update: Partial<ConnectionState>) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.qrCode = qr;
          this.connectionStatus = 'qr_ready';
          this.emit('qr', qr);
          qrcodeTerminal.toString(qr, { type: 'terminal', small: true }, (err: any, text: string) => {
            if (!err && text) {
              console.log('\n================ ESCANEIE O QR CODE NO WHATSAPP ================');
              console.log(text);
              console.log('Também disponível visualmente no Dashboard: http://localhost:3000');
              console.log('=================================================================\n');
            }
          });
        }

        if (connection === 'close') {
          const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
          const reason = DisconnectReason[statusCode as keyof typeof DisconnectReason] || 'unknown';
          console.warn(`[WhatsAppGateway] Conexão fechada. Motivo: ${reason} (${statusCode})`);
          this.connectionStatus = 'disconnected';
          this.socket = null;
          this.isConnecting = false;
          this.emit('disconnected', reason);

          if (statusCode === DisconnectReason.loggedOut) {
            console.warn('[WhatsAppGateway] Sessão desconectada no celular (401 loggedOut). Limpando credenciais antigas e gerando novo QR Code...');
            this.shouldReconnect = true;
            this.isConnecting = false;
            import('node:fs/promises').then(({ default: fsp }) => {
              fsp.rm(this.authDir, { recursive: true, force: true }).then(() => {
                setTimeout(() => this.start(), 1500);
              }).catch(console.error);
            });
          } else if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        } else if (connection === 'open') {
          console.log('[WhatsAppGateway] CONEXÃO ABERTA COM SUCESSO (STATUS: CONNECTED)!');
          this.connectionStatus = 'connected';
          this.qrCode = null;
          this.reconnectAttempts = 0;
          this.isConnecting = false;
          this.emit('ready');

          // Sincroniza lista de grupos participantes no banco de dados para controle no Dashboard
          this.syncParticipatingGroups().catch((err) => {
            console.warn('[WhatsAppGateway] Aviso ao sincronizar grupos:', err.message);
          });
        }
      });

      this.socket.ev.on('messages.upsert', async ({ messages, type }) => {
        // REGRA DE SEGURANÇA 1: Processa apenas mensagens recebidas em tempo real ('notify').
        // Descarta 'append' (sincronização de histórico antigo do WhatsApp que causava disparos em massa)
        if (type !== 'notify') {
          return;
        }

        const now = Date.now();

        for (const rawMsg of messages) {
          const jid = rawMsg.key?.remoteJid || '';

          // Rastreamento progressivo de grupos
          if (isJidGroup(jid)) {
            if (this.storage && rawMsg.key?.remoteJid) {
              const textContent =
                rawMsg.message?.conversation ||
                rawMsg.message?.extendedTextMessage?.text ||
                rawMsg.message?.imageMessage?.caption ||
                '[Mídia/Mensagem]';

              // Tenta descobrir o nome do grupo via socket
              let groupName = 'Grupo do WhatsApp';
              try {
                if (this.socket && typeof this.socket.groupMetadata === 'function') {
                  const meta = await this.socket.groupMetadata(jid).catch(() => null);
                  if (meta && meta.subject) {
                    groupName = meta.subject;
                  }
                }
              } catch {}

              const existingGroups = await this.storage.getGroups();
              const existing = existingGroups.find((g) => g.id === jid);

              await this.storage.saveGroup({
                id: jid,
                name: existing?.name && existing.name !== 'Grupo do WhatsApp' ? existing.name : groupName,
                lastMessage: `${rawMsg.pushName || 'Membro'}: "${textContent.slice(0, 60)}"`,
                lastActivityTimestamp: typeof rawMsg.messageTimestamp === 'number' ? rawMsg.messageTimestamp * 1000 : Date.now(),
                botEnabled: existing ? existing.botEnabled : false, // Desativado por padrão (progressivo e seguro)
              });

              // Se o bot estiver desativado para este grupo, descarta o processamento de resposta
              if (!existing?.botEnabled) {
                continue;
              }
            } else {
              continue;
            }
          }

          const normalized = normalizeBaileysMessage(rawMsg, true);
          if (normalized) {
            normalized.tenantId = this.tenantId;
            // REGRA DE SEGURANÇA 2: Descarta mensagens com mais de 2 minutos de atraso (mensagens velhas descarregadas na reconexão)
            if (now - normalized.timestamp > 2 * 60 * 1000) {
              console.log(`[WhatsAppGateway] Mensagem antiga de ${normalized.contactId} descartada (atraso: ${Math.round((now - normalized.timestamp) / 1000)}s)`);
              continue;
            }

            this.lidMapping.set(normalized.contactId, jid);
            if (rawMsg.key?.remoteJidAlt) {
              this.lidMapping.set(normalized.contactId, rawMsg.key.remoteJidAlt);
            }
            this.lidMapping.set(jid, jid);

            // Download de Imagens (Fotos / Prints / Comprovantes) para Vision Mode
            if (normalized.type === 'image' && rawMsg.message?.imageMessage) {
              try {
                console.log(`[WhatsAppGateway] Imagem/Foto recebida de ${normalized.contactId}. Baixando para Vision Mode...`);
                const buffer = await downloadMediaMessage(
                  rawMsg,
                  'buffer',
                  {},
                  {
                    logger: this.logger as any,
                    reuploadRequest: this.socket!.updateMediaMessage,
                  }
                );
                if (Buffer.isBuffer(buffer)) {
                  normalized.mediaBase64 = buffer.toString('base64');
                  normalized.mimetype = rawMsg.message.imageMessage.mimetype || 'image/jpeg';
                  console.log(`[WhatsAppGateway] Imagem baixada com sucesso (${buffer.length} bytes, mimetype: ${normalized.mimetype})`);
                }
              } catch (imgErr) {
                console.warn('[WhatsAppGateway] Falha ao baixar mídia da imagem:', imgErr);
              }
            }

            // Download da mídia da figurinha (Sticker WebP ou GIF) para interpretação com Vision Mode
            const isStickerOrGifMessage =
              (normalized.type === 'sticker' && rawMsg.message?.stickerMessage) ||
              (rawMsg.message?.videoMessage?.gifPlayback);

            if (isStickerOrGifMessage) {
              try {
                console.log(`[WhatsAppGateway] Figurinha ou GIF recebido de ${normalized.contactId}. Baixando mídia para Vision Mode...`);
                const buffer = await downloadMediaMessage(
                  rawMsg,
                  'buffer',
                  {},
                  {
                    logger: this.logger as any,
                    reuploadRequest: this.socket!.updateMediaMessage,
                  }
                );
                if (Buffer.isBuffer(buffer)) {
                  normalized.mediaBase64 = buffer.toString('base64');
                  normalized.mimetype =
                    rawMsg.message?.stickerMessage?.mimetype ||
                    (rawMsg.message?.videoMessage?.gifPlayback ? 'image/gif' : 'image/webp');
                  console.log(`[WhatsAppGateway] Mídia baixada com sucesso (${buffer.length} bytes, mimetype: ${normalized.mimetype})`);
                }
              } catch (mediaErr) {
                console.warn('[WhatsAppGateway] Falha ao baixar mídia da figurinha/GIF:', mediaErr);
              }
            }

            // Transcrição de áudio com Groq Whisper (SOMENTE para áudios/mensagens de voz)
            if (normalized.type === 'audio' && rawMsg.message?.audioMessage && this.audioTranscriber.isAvailable()) {
              try {
                console.log(`[WhatsAppGateway] Áudio recebido de ${normalized.contactId}. Baixando para transcrição com Groq Whisper...`);
                const buffer = await downloadMediaMessage(
                  rawMsg,
                  'buffer',
                  {},
                  {
                    logger: this.logger as any,
                    reuploadRequest: this.socket!.updateMediaMessage,
                  }
                );

                if (Buffer.isBuffer(buffer)) {
                  const transcript = await this.audioTranscriber.transcribe(buffer);
                  if (transcript && transcript.length > 0) {
                    console.log(`[WhatsAppGateway] Áudio transcrito com Groq Whisper: "${transcript}"`);
                    normalized.content = transcript;
                    // Promove tipo de conteúdo para texto para alimentar o pipeline de decisão
                    normalized.type = 'text';
                  }
                }
              } catch (audioErr) {
                console.warn('[WhatsAppGateway] Falha ao baixar/transcrever mensagem de voz:', audioErr);
              }
            }

            this.emit('message', normalized);
          }
        }
      });

      this.socket.ev.on('messages.update', (updates) => {
        for (const upd of updates) {
          const remoteJid = upd.key.remoteJid || '';
          if (isJidGroup(remoteJid)) continue;
          this.emit('message_update', {
            id: upd.key.id || '',
            remoteJid,
            update: upd.update,
          });
        }
      });
    } catch (err) {
      this.isConnecting = false;
      this.connectionStatus = 'disconnected';
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    // Exponential backoff with jitter
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), this.maxReconnectDelay);
    setTimeout(() => {
      if (this.shouldReconnect) {
        this.start();
      }
    }, delay);
  }

  public async stop(): Promise<void> {
    this.shouldReconnect = false;
    if (this.socket) {
      try {
        await this.socket.logout();
      } catch {
        // ignore logout errors on force stop
      }
      this.socket.end(undefined);
      this.socket = null;
    }
    this.connectionStatus = 'disconnected';
  }

  public async sendMessage(contactId: string, text: string, quotedMessage?: any): Promise<string> {
    if (!this.socket || this.connectionStatus !== 'connected') {
      throw new Error('WhatsApp gateway is not connected');
    }

    const cachedJid = this.lidMapping.get(contactId);
    let targetJid = cachedJid || (contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`);

    // Trata número de telefone brasileiro: se tiver 13 dígitos (55 + DDD 2 dígitos + 9 dígitos),
    // o WhatsApp pode aceitar a versão com ou sem o 9º dígito
    const getBrazilianVariants = (num: string): string[] => {
      const clean = num.replace(/\D/g, '');
      const variants: string[] = [];
      if (clean.startsWith('55') && clean.length === 13) {
        // Formato com 9 dígitos: 55 + DD + 9 + 8 dígitos
        const ddd = clean.slice(2, 4);
        const rest = clean.slice(5); // sem o 9
        const withoutNine = `55${ddd}${rest}@s.whatsapp.net`;
        variants.push(withoutNine);
      } else if (clean.startsWith('55') && clean.length === 12) {
        // Formato sem 9 dígitos: 55 + DD + 8 dígitos -> com 9
        const ddd = clean.slice(2, 4);
        const rest = clean.slice(4);
        const withNine = `55${ddd}9${rest}@s.whatsapp.net`;
        variants.push(withNine);
      }
      return variants;
    };

    console.log(`[WhatsAppGateway] Tentando envio (com quoted: ${Boolean(quotedMessage)}) para ${targetJid}: "${text}"`);
    let result: any;

    // Em caso de quoted com erro 406 (not-acceptable), podemos tentar enviar sem quoted como fallback
    let sendOptions = quotedMessage ? { quoted: quotedMessage } : undefined;

    // Simulação de comportamento humano (Anti-Bot):
    // 1. Marca visualização (read receipts)
    // 2. Marca presença "composing" (digitando...)
    // 3. Aguarda um delay proporcional ao tamanho da mensagem (leitura + digitação)
    // 4. Pausa presença e dispara a mensagem
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      try {
        if (quotedMessage && typeof this.socket.readMessages === 'function') {
          await this.socket.readMessages([quotedMessage.key]).catch(() => {});
        }

        if (typeof this.socket.sendPresenceUpdate === 'function') {
          await this.socket.sendPresenceUpdate('composing', targetJid);
        }

        // Tempo de digitação: entre 1.5s e 4.5s baseado no tamanho do texto
        const typingDelay = Math.min(Math.max(text.length * 45, 1500), 4500) + Math.floor(Math.random() * 800);
        console.log(`[WhatsAppGateway] Simulando digitação humana (${typingDelay}ms) para ${targetJid}...`);
        await new Promise((resolve) => setTimeout(resolve, typingDelay));

        if (typeof this.socket.sendPresenceUpdate === 'function') {
          await this.socket.sendPresenceUpdate('paused', targetJid);
        }
      } catch (presErr) {
        // Presença é opcional, falhas não devem travar o envio
      }
    }

    try {
      result = await this.socket.sendMessage(targetJid, { text }, sendOptions);
    } catch (primaryErr: any) {
      console.warn(`[WhatsAppGateway] Falha primária no envio para ${targetJid} (${primaryErr?.message || primaryErr}). Tentando estratégias de recuperação...`);

      // 1. Se falhou com quoted (406 not-acceptable), tenta enviar sem quoted imediatamente
      if (sendOptions) {
        try {
          console.log(`[WhatsAppGateway] Tentando envio sem quoted para ${targetJid}...`);
          result = await this.socket.sendMessage(targetJid, { text }, undefined);
          return result?.key?.id || `sent-${Date.now()}`;
        } catch (noQuoteErr: any) {
          console.warn(`[WhatsAppGateway] Falha sem quoted para ${targetJid}:`, noQuoteErr?.message || noQuoteErr);
        }
      }

      // 2. Se falhou no LID, tenta fallback regular @s.whatsapp.net
      if (targetJid.includes('@lid') && /^\d+$/.test(contactId)) {
        const fallbackJid = `${contactId}@s.whatsapp.net`;
        try {
          console.warn(`[WhatsAppGateway] Tentando fallback para telefone regular ${fallbackJid}...`);
          result = await this.socket.sendMessage(fallbackJid, { text }, undefined);
          return result?.key?.id || `sent-${Date.now()}`;
        } catch (lidFallbackErr: any) {
          console.warn(`[WhatsAppGateway] Falha no fallback regular:`, lidFallbackErr?.message || lidFallbackErr);
        }
      }

      // 3. Fallback de dígito 9 brasileiro (com/sem o 9º dígito para o WhatsApp aceitar a sessão)
      const variants = getBrazilianVariants(contactId);
      for (const variantJid of variants) {
        if (variantJid !== targetJid) {
          try {
            console.log(`[WhatsAppGateway] Tentando variante de número brasileiro ${variantJid}...`);
            result = await this.socket.sendMessage(variantJid, { text }, undefined);
            return result?.key?.id || `sent-${Date.now()}`;
          } catch (varErr: any) {
            console.warn(`[WhatsAppGateway] Falha na variante ${variantJid}:`, varErr?.message || varErr);
          }
        }
      }

      throw primaryErr;
    }

    return result?.key?.id || `sent-${Date.now()}`;
  }
}
