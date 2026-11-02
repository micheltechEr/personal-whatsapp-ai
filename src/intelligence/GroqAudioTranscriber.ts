export class GroqAudioTranscriber {
  private apiKey: string;
  private endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
  private model = 'whisper-large-v3';

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.GROQ_API_KEY || '';
  }

  public isAvailable(): boolean {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  /**
   * Transcreve exclusivamente arquivos de áudio/voz via Groq Whisper.
   * Não processa mensagens de texto nem executa nenhuma outra tarefa.
   */
  public async transcribe(audioBuffer: Buffer, filename = 'voice_note.ogg'): Promise<string | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2)}`;
      const crlf = '\r\n';

      const postDataParts: Buffer[] = [
        Buffer.from(
          `--${boundary}${crlf}Content-Disposition: form-data; name="model"${crlf}${crlf}${this.model}${crlf}`
        ),
        Buffer.from(
          `--${boundary}${crlf}Content-Disposition: form-data; name="language"${crlf}${crlf}pt${crlf}`
        ),
        Buffer.from(
          `--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}Content-Type: audio/ogg${crlf}${crlf}`
        ),
        audioBuffer,
        Buffer.from(`${crlf}--${boundary}--${crlf}`),
      ];

      const fullBody = Buffer.concat(postDataParts);

      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(fullBody.length),
        },
        body: fullBody,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[GroqAudioTranscriber] Erro na transcrição Groq (${response.status}): ${errorText.slice(0, 120)}`);
        return null;
      }

      const data = (await response.json()) as any;
      const text = data?.text?.trim();
      return text || null;
    } catch (err) {
      console.warn('[GroqAudioTranscriber] Falha ao transcrever áudio com Groq:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}
