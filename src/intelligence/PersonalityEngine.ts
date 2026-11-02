import { ContactMemory, NormalizedMessage } from '../types/index.js';

export interface OwnerVoiceProfile {
  defaultFormality: 'low' | 'medium' | 'high';
  averageLengthWords: number;
  useEmojis: boolean;
  typicalEmojis: string[];
  preferredGreetings: {
    informal: string[];
    formal: string[];
  };
  preferredClosings: {
    informal: string[];
    formal: string[];
  };
  bannedPhrases: string[];
}

export class PersonalityEngine {
  private profile: OwnerVoiceProfile = {
    defaultFormality: 'low',
    averageLengthWords: 12,
    useEmojis: true,
    typicalEmojis: ['👍', '🤝', '👊', 'valeu'],
    preferredGreetings: {
      informal: ['Opa, tudo bem?', 'Fala aí!', 'E aí, beleza?'],
      formal: ['Olá, tudo bem?', 'Bom dia, como posso ajudar?'],
    },
    preferredClosings: {
      informal: ['Valeu!', 'Abraço!', 'Qualquer coisa me chama.'],
      formal: ['Atenciosamente, Ângelo.', 'Fico à disposição.'],
    },
    bannedPhrases: [
      'Como um modelo de IA',
      'Espero que esta mensagem o encontre bem',
      'Prezado senhor',
      'Certamente!',
      'Com certeza meu caro',
    ],
  };

  public getVoiceProfile(): OwnerVoiceProfile {
    return { ...this.profile };
  }

  public learnFromFeedback(
    originalResponse: string,
    action: 'approved' | 'edited' | 'rejected',
    editedResponse?: string
  ): void {
    if (action === 'edited' && editedResponse) {
      // Analyze length and formality difference
      const editedWordCount = editedResponse.split(/\s+/).length;
      this.profile.averageLengthWords = Math.round(
        (this.profile.averageLengthWords * 4 + editedWordCount) / 5
      );
    } else if (action === 'rejected') {
      // If rejected, ensure original phrase structure isn't repeated blindly
      const firstSentence = originalResponse.split(/[.!?]/)[0]?.trim();
      if (firstSentence && firstSentence.length > 10 && !this.profile.bannedPhrases.includes(firstSentence)) {
        this.profile.bannedPhrases.push(firstSentence);
      }
    }
  }

  public getGreeting(relationship: ContactMemory['relationship']): string {
    if (relationship === 'work' || relationship === 'professional') {
      return this.profile.preferredGreetings.formal[0];
    }
    return this.profile.preferredGreetings.informal[0];
  }

  public formatResponse(rawText: string, contactMemory: ContactMemory): string {
    let formatted = rawText.trim();

    // Remove any banned AI-sounding phrases
    for (const banned of this.profile.bannedPhrases) {
      if (formatted.toLowerCase().includes(banned.toLowerCase())) {
        formatted = formatted.replace(new RegExp(banned, 'gi'), '').trim();
      }
    }

    // Adapt to contact formality & relationship dynamics
    if (contactMemory.relationship === 'romantic') {
      // PROIBIDO chamar parceira/namorada de gírias de brother: "mano", "vei", "cara", "irmão", "brother", "parceiro"
      formatted = formatted.replace(/\b(mano|vei|véi|cara|brother|parceiro)\b/gi, '');
      // Remove duplos espaços resultantes
      formatted = formatted.replace(/\s{2,}/g, ' ').trim();
    } else if (contactMemory.formalityLevel === 'high' || contactMemory.relationship === 'work' || contactMemory.relationship === 'professional') {
      // Clean excessive informal slang for formal contacts
      formatted = formatted.replace(/\b(e\s+a[íi]|opa|show|tranquilo|mano|cara|vei)\b/gi, 'olá');
    }

    return formatted;
  }
}
