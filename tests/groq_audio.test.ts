import { describe, it, expect } from 'vitest';
import { GroqAudioTranscriber } from '../src/intelligence/GroqAudioTranscriber.js';

describe('Groq Audio Transcriber', () => {
  it('correctly initializes and checks availability with provided key', () => {
    const transcriber = new GroqAudioTranscriber('test-key');
    expect(transcriber.isAvailable()).toBe(true);
  });

  it('reports unavailable when no API key is set', () => {
    const transcriber = new GroqAudioTranscriber('');
    expect(transcriber.isAvailable()).toBe(false);
  });

  it('safely returns null when transcribing with empty key', async () => {
    const transcriber = new GroqAudioTranscriber('');
    const result = await transcriber.transcribe(Buffer.from('fake-audio'));
    expect(result).toBeNull();
  });
});
