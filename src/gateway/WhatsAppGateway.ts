import path from 'node:path';
import EventEmitter from 'node:events';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  ConnectionState,
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

  constructor(authDir?: string) {
    super();
    this.authDir = authDir || path.resolve(process.cwd(), '.baileys_auth');
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
    return {
      status: this.connectionStatus,
      qr: this.qrCode,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  public async start(): Promise<void> {
    if (this.isConnecting || this.socket) return;
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
          this.connectionStatus = 'disconnected';
          this.socket = null;
          this.isConnecting = false;
          this.emit('disconnected', reason);

          if (statusCode === DisconnectReason.loggedOut) {
            this.shouldReconnect = false;
          } else if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        } else if (connection === 'open') {
          this.connectionStatus = 'connected';
          this.qrCode = null;
          this.reconnectAttempts = 0;
          this.isConnecting = false;
          this.emit('ready');
        }
      });

      this.socket.ev.on('messages.upsert', ({ messages, type }) => {
        for (const rawMsg of messages) {
          const jid = rawMsg.key?.remoteJid || '';
          // Strictly drop groups right away
          if (isJidGroup(jid)) {
            continue;
          }

          const normalized = normalizeBaileysMessage(rawMsg);
          if (normalized) {
            this.lidMapping.set(normalized.contactId, jid);
            this.lidMapping.set(jid, jid);
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

  public async sendMessage(contactId: string, text: string): Promise<string> {
    if (!this.socket || this.connectionStatus !== 'connected') {
      throw new Error('WhatsApp gateway is not connected');
    }

    const targetJid =
      this.lidMapping.get(contactId) ||
      (contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`);

    console.log(`[WhatsAppGateway] Enviando mensagem para ${targetJid}: "${text}"`);
    const result = await this.socket.sendMessage(targetJid, { text });
    return result?.key.id || `sent-${Date.now()}`;
  }
}
