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

  constructor(authDir?: string, audioTranscriber?: GroqAudioTranscriber) {
    super();
    this.authDir = authDir || path.resolve(process.cwd(), '.baileys_auth');
    this.audioTranscriber = audioTranscriber || new GroqAudioTranscriber();
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
          // Strictly drop groups right away
          if (isJidGroup(jid)) {
            continue;
          }

          const normalized = normalizeBaileysMessage(rawMsg);
          if (normalized) {
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

    console.log(`[WhatsAppGateway] Tentando envio (com quoted: ${Boolean(quotedMessage)}) para ${targetJid}: "${text}"`);
    let result: any;

    const options = quotedMessage ? { quoted: quotedMessage } : undefined;

    try {
      result = await this.socket.sendMessage(targetJid, { text }, options);
    } catch (primaryErr) {
      // Se falhou no JID principal (ex: @lid) e o contato tem formato de telefone, tenta o fallback @s.whatsapp.net
      if (targetJid.includes('@lid') && /^\d+$/.test(contactId)) {
        const fallbackJid = `${contactId}@s.whatsapp.net`;
        console.warn(`[WhatsAppGateway] Falha enviando para LID ${targetJid}, tentando fallback ${fallbackJid}...`);
        result = await this.socket.sendMessage(fallbackJid, { text }, options);
      } else {
        throw primaryErr;
      }
    }

    return result?.key?.id || `sent-${Date.now()}`;
  }
}
