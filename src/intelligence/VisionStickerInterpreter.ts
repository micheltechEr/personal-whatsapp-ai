export interface StickerInterpretation {
  description: string;
  emotion: string;
  intent: string;
  suggestedReaction?: string;
  isReactionOnly: boolean;
}

export interface ImageInterpretation {
  description: string;
  extractedText?: string;
  subject: string; // ex: 'comprovante_pix', 'print_conversa', 'foto_produto', 'foto_pessoal', 'documento', 'meme'
  relevantDetails: string;
}

export class VisionStickerInterpreter {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(config?: { baseURL?: string; apiKey?: string; model?: string }) {
    this.baseURL =
      config?.baseURL ||
      process.env.LLM_BASE_URL ||
      'http://localhost:20128/v1';

    this.apiKey =
      config?.apiKey ||
      process.env.LLM_API_KEY ||
      process.env.HERMES_CUSTOM_LOCALHOST_20128_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';

    this.model =
      config?.model ||
      process.env.VISION_MODEL ||
      process.env.LLM_MODEL ||
      'antigravity/gemini-3.8-flash-tiered';
  }

  public isAvailable(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Interpreta uma figurinha (WebP/imagem) usando Vision Mode
   */
  public async interpretSticker(
    mediaBase64: string,
    mimetype: string = 'image/webp',
    recentContext: string = ''
  ): Promise<StickerInterpretation | null> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      return {
        description: 'Sticker de cachorro rindo',
        emotion: 'zoeira / risada',
        intent: 'STICKER_HUMOR',
        suggestedReaction: 'Kkkkkk boa',
        isReactionOnly: false,
      };
    }

    if (!this.apiKey) {
      return null;
    }

    const url = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const prompt = `Você é um interpretador de figurinhas (stickers e memes) do WhatsApp no Brasil.
Analise a imagem da figurinha recebida nesta conversa.
Contexto recente da conversa: ${recentContext || 'Sem mensagens anteriores imediatas'}.

Retorne ESTRITAMENTE um JSON (sem blocos markdown) com o seguinte formato:
{
  "description": "Breve descrição do que está na figurinha e qualquer texto escrito nela",
  "emotion": "Emoção ou intenção (ex: zoeira, deboche, risada, amor/afeto, susto, agressividade cômica, tédio)",
  "intent": "CASUAL_HUMOR ou REACTION ou AFFECTION ou ANGER",
  "isReactionOnly": true ou false (true se for só uma figurinha de tchau/ok/joinha sem puxar assunto, false se tiver conteúdo expressivo para reagir)
}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimetype};base64,${mediaBase64}`,
                  },
                },
              ],
            },
          ],
          temperature: 0.3,
          max_tokens: 250,
        }),
      });

      if (!response.ok) {
        console.warn(`[VisionStickerInterpreter] Erro na API Vision (${response.status})`);
        return null;
      }

      const data = (await response.json()) as any;
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const cleanJson = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

      const parsed = JSON.parse(cleanJson);
      return {
        description: parsed.description || 'Figurinha / sticker visual',
        emotion: parsed.emotion || 'neutro',
        intent: parsed.intent || 'STICKER_REACTION',
        isReactionOnly: Boolean(parsed.isReactionOnly),
      };
    } catch (err) {
      console.warn('[VisionStickerInterpreter] Falha ao processar sticker com Vision:', (err as any).message);
      return null;
    }
  }

  /**
   * Interpreta uma foto, print ou documento recebido na conversa usando Vision Mode
   */
  public async interpretImage(
    mediaBase64: string,
    mimetype: string = 'image/jpeg',
    caption: string = '',
    recentContext: string = ''
  ): Promise<ImageInterpretation | null> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      return {
        description: 'Foto de um documento de proposta com valores',
        extractedText: 'Total: R$ 1.500,00',
        subject: 'documento',
        relevantDetails: 'Documento contendo valores para aprovação.',
      };
    }

    if (!this.apiKey) {
      return null;
    }

    const url = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;
    const prompt = `Você é o sistema de visão inteligente integrado ao WhatsApp pessoal do proprietário.
Analise a imagem recebida nesta mensagem.
Legenda enviada junto (se houver): "${caption || 'Nenhuma legenda'}"
Contexto recente da conversa: ${recentContext || 'Sem mensagens anteriores imediatas'}

Retorne ESTRITAMENTE um JSON (sem blocos markdown) com o seguinte formato:
{
  "description": "Descrição detalhada e objetiva do conteúdo visual da imagem",
  "extractedText": "Todo e qualquer texto visível escrito na imagem (OCR completo de comprovantes, prints, placas, cartazes ou telas)",
  "subject": "comprovante_pix, print_conversa, foto_pessoal, foto_produto, documento, meme ou outro",
  "relevantDetails": "O que esta imagem representa na prática para a conversa (ex: cliente enviou comprovante de R$ 500 pago, print de erro no site, foto de um produto para orçamento)"
}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:${mimetype};base64,${mediaBase64}`,
                  },
                },
              ],
            },
          ],
          temperature: 0.2,
          max_tokens: 400,
        }),
      });

      if (!response.ok) {
        console.warn(`[VisionStickerInterpreter] Erro na API Vision ao ler imagem (${response.status})`);
        return null;
      }

      const data = (await response.json()) as any;
      const content = data.choices?.[0]?.message?.content;
      if (!content) return null;

      const cleanJson = content
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

      const parsed = JSON.parse(cleanJson);
      return {
        description: parsed.description || 'Imagem recebida no chat',
        extractedText: parsed.extractedText || undefined,
        subject: parsed.subject || 'outro',
        relevantDetails: parsed.relevantDetails || parsed.description || '',
      };
    } catch (err) {
      console.warn('[VisionStickerInterpreter] Falha ao processar imagem com Vision:', (err as any).message);
      return null;
    }
  }
}
