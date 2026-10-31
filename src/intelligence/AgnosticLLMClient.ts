export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMClientConfig {
  provider?: 'openai-compatible' | 'gemini' | 'auto';
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export class AgnosticLLMClient {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(config?: LLMClientConfig) {
    // Priority: Explicit config -> OmniRoute env -> Standard OpenAI/Gemini env -> fallback
    this.baseURL =
      config?.baseURL ||
      process.env.LLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      'http://localhost:20128/v1';

    this.apiKey =
      config?.apiKey ||
      process.env.LLM_API_KEY ||
      process.env.HERMES_CUSTOM_LOCALHOST_20128_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';

    this.model =
      config?.model ||
      process.env.LLM_MODEL ||
      'antigravity/gemini-3.8-flash-tiered';
  }

  public getModel(): string {
    return this.model;
  }

  public getBaseURL(): string {
    return this.baseURL;
  }

  public async complete(messages: LLMMessage[]): Promise<string | null> {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      // In automated test suite, avoid real network latency
      return null;
    }

    if (!this.apiKey) {
      // In unconfigured environments without API key, avoid hanging network calls
      return null;
    }

    const url = `${this.baseURL.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.6,
          max_tokens: 300,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.warn(`[AgnosticLLMClient] API error (${response.status}): ${errorText.slice(0, 150)}`);
        return null;
      }

      const data = (await response.json()) as any;
      const content = data.choices?.[0]?.message?.content;
      return content ? content.trim() : null;
    } catch (err) {
      console.warn('[AgnosticLLMClient] Request failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}
