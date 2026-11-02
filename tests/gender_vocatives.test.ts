import { describe, it, expect } from 'vitest';
import { GenderDetector } from '../src/intelligence/GenderDetector.js';
import { PersonalityEngine } from '../src/intelligence/PersonalityEngine.js';
import { ContactMemory } from '../src/types/index.js';

describe('Gender Detection & Controlled Vocatives (Heuristics)', () => {
  it('correctly detects feminine names', () => {
    expect(GenderDetector.detectGender('Anny')).toBe('feminine');
    expect(GenderDetector.detectGender('Marli🌹')).toBe('feminine');
    expect(GenderDetector.detectGender('Gaby')).toBe('feminine');
    expect(GenderDetector.detectGender('Mariana Souza')).toBe('feminine');
    expect(GenderDetector.detectGender('Beatriz')).toBe('feminine');
  });

  it('correctly detects masculine names', () => {
    expect(GenderDetector.detectGender('Ruan Emanuel')).toBe('masculine');
    expect(GenderDetector.detectGender('Matheus')).toBe('masculine');
    expect(GenderDetector.detectGender('Icarus')).toBe('masculine');
    expect(GenderDetector.detectGender('Paulo Filipe')).toBe('masculine');
    expect(GenderDetector.detectGender('Lorenzo G')).toBe('masculine');
  });

  it('returns neutral for numbers or ambiguous names', () => {
    expect(GenderDetector.detectGender('')).toBe('neutral');
    expect(GenderDetector.detectGender('557588428289')).toBe('neutral');
    expect(GenderDetector.detectGender('Dev')).toBe('neutral');
  });

  it('strips "mano" and "vei" from feminine and neutral contacts', () => {
    const pe = new PersonalityEngine('Ângelo');
    const femaleContact: ContactMemory = {
      contactId: '123',
      name: 'Anny',
      gender: 'feminine',
      relationship: 'informal',
      formalityLevel: 'low',
      notes: [],
      autoReplyAllowed: true,
      blocked: false,
      maxDailyAutoReplies: 30,
      autoRepliesToday: 0,
      lastAutoReplyTimestamp: 0,
    };

    const out1 = pe.formatResponse('Tudo bem mano, como vai?', femaleContact);
    expect(out1).not.toContain('mano');
    expect(out1).toContain('Tudo bem');

    const out2 = pe.formatResponse('Vei, valeu pelo aviso', femaleContact);
    expect(out2).not.toContain('Vei');
  });

  it('strictly blocks "amor" and "vida" for non-romantic contacts', () => {
    const pe = new PersonalityEngine('Ângelo');
    const casualContact: ContactMemory = {
      contactId: '456',
      name: 'Ruan Emanuel',
      gender: 'masculine',
      relationship: 'friend',
      formalityLevel: 'low',
      notes: [],
      autoReplyAllowed: true,
      blocked: false,
      maxDailyAutoReplies: 30,
      autoRepliesToday: 0,
      lastAutoReplyTimestamp: 0,
    };

    const out = pe.formatResponse('Opa amor, tudo certo por aqui', casualContact);
    expect(out).not.toContain('amor');
  });
});
