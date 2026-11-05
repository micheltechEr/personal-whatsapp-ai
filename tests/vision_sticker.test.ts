import { describe, it, expect } from 'vitest';
import { VisionStickerInterpreter } from '../src/intelligence/VisionStickerInterpreter.js';
import { ResponseGenerator } from '../src/intelligence/ResponseGenerator.js';
import { PersonalityEngine } from '../src/intelligence/PersonalityEngine.js';
import { NormalizedMessage } from '../src/types/index.js';

describe('Vision Sticker Interpreter & Response Integration', () => {
  const vision = new VisionStickerInterpreter();

  it('interprets sticker with base64 and detects visual content', async () => {
    const mockBase64 = 'UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/1/4AAAD+kY/W/i/6l9S2v7/9S+pbX9/+pfUtr+/wAA==';
    const result = await vision.interpretSticker(mockBase64, 'image/webp');

    expect(result).toBeDefined();
    expect(result?.description).toContain('Sticker');
    expect(result?.emotion).toBeDefined();
    expect(result?.intent).toBe('STICKER_HUMOR');
  });

  it('interprets GIF animations (image/gif) with vision mode', async () => {
    const mockGifBase64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const result = await vision.interpretSticker(mockGifBase64, 'image/gif');

    expect(result).toBeDefined();
    expect(result?.description).toBeDefined();
    expect(result?.emotion).toBeDefined();
  });

  it('interprets photo/document with vision mode, performing OCR and visual description', async () => {
    const mockImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const result = await vision.interpretImage(mockImageBase64, 'image/png', 'Veja este comprovante');

    expect(result).toBeDefined();
    expect(result?.description).toBeDefined();
    expect(result?.subject).toBe('documento');
    expect(result?.extractedText).toContain('1.500,00');
  });

  it('generates contextual response when an expressive sticker is received', async () => {
    const personality = new PersonalityEngine('Ângelo');
    const generator = new ResponseGenerator(personality, undefined, undefined, undefined, vision);

    const msg: NormalizedMessage = {
      id: 'stk-msg-1',
      contactId: '5575999990001',
      content: '[Figurinha]',
      timestamp: Date.now(),
      fromMe: false,
      isGroup: false,
      type: 'sticker',
      mimetype: 'image/webp',
      mediaBase64: 'UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoAAP7/1/4AAAD+kY/W/i/6l9S2v7/9S+pbX9/+pfUtr+/wAA==',
    };

    const context = {
      contactMemory: {
        contactId: '5575999990001',
        relationship: 'friend' as const,
        formalityLevel: 'low' as const,
        notes: [],
        autoReplyAllowed: true,
        blocked: false,
        maxDailyAutoReplies: 30,
        autoRepliesToday: 0,
        lastAutoReplyTimestamp: 0,
      },
      recentMessages: [],
      recentSummary: 'Falando sobre memes de cachorros',
      pendingTasks: [],
      contextConfidence: 95,
      ownerSentManualReplyRecently: false,
    };

    const risk = {
      riskLevel: 0 as const,
      safetyFlags: [],
      reasons: [],
      promptInjectionDetected: false,
      isSensitiveTopic: false,
      requiresHumanReview: false,
    };

    const intent = {
      intent: 'MEDIA_SHARE_NO_TEXT',
      isQuestion: false,
      isUrgent: false,
      requiresResponse: false,
      operationalAction: 'IGNORAR' as const,
      confidence: 95,
    };

    const decision = await generator.generateDecision(msg, context, risk, intent);
    expect(decision.decision).toBe('AUTO_REPLY');
    expect(decision.suggested_response).toBeDefined();
    expect(decision.suggested_response.length).toBeGreaterThan(0);
  });
});
