import { GenderIdentity } from '../types/index.js';

export class GenderDetector {
  // Nomes femininos comuns em pt-BR (incluindo apelidos comuns de WhatsApp)
  private static femaleNames = new Set([
    'ana', 'anny', 'annie', 'ani', 'alice', 'aline', 'amanda', 'angela', 'angelica',
    'ariane', 'barbara', 'beatriz', 'bia', 'bianca', 'bruna', 'camila', 'carla',
    'carol', 'carolina', 'cecilia', 'clara', 'claudia', 'cris', 'cristiane', 'daiane',
    'daniela', 'daniele', 'dani', 'debora', 'denise', 'duda', 'eduarda', 'elisa',
    'emanuelle', 'emilly', 'emily', 'fabiana', 'fatima', 'fernanda', 'flavia',
    'gabriela', 'gabriele', 'gabi', 'gaby', 'giovanna', 'giovana', 'giselle', 'graziela',
    'heloisa', 'helen', 'helena', 'isabela', 'isabella', 'isadora', 'isa', 'ingrid',
    'jacqueline', 'jessica', 'jessyca', 'joana', 'julia', 'juliana', 'ju', 'lara',
    'larissa', 'lari', 'laura', 'layla', 'leticia', 'livia', 'lorena', 'luana',
    'luciana', 'luisa', 'luiza', 'luh', 'manu', 'manuela', 'marcela', 'marcia',
    'maria', 'mariana', 'mari', 'marina', 'marli', 'marlene', 'marta', 'mayara',
    'melissa', 'milena', 'mirella', 'monica', 'nadia', 'naiara', 'natasha', 'natalia',
    'nati', 'nayara', 'nicole', 'nicolly', 'olivia', 'paloma', 'pamela', 'patricia',
    'pati', 'paula', 'priscila', 'pri', 'rafaela', 'rafaella', 'rafa', 'raissa',
    'raquel', 'rayane', 'rebeca', 'renata', 'rita', 'roberta', 'rosana', 'sabrina',
    'samara', 'sandra', 'sarah', 'sara', 'silvia', 'simone', 'sofia', 'sophia',
    'stephanie', 'suelen', 'suzana', 'tais', 'thais', 'tatiana', 'tatiane', 'tati',
    'teresa', 'valeria', 'vanessa', 'vera', 'victoria', 'vitoria', 'vivian', 'viviane',
    'yasmin', 'yasmim'
  ]);

  // Nomes masculinos comuns em pt-BR
  private static maleNames = new Set([
    'alan', 'alexandre', 'alex', 'alisson', 'alvaro', 'andre', 'angelo', 'antonio',
    'arthur', 'artur', 'bernardo', 'breno', 'bruno', 'caio', 'carlos', 'cesar',
    'claudio', 'cristiano', 'daniel', 'danilo', 'davi', 'david', 'denis', 'diego',
    'diogo', 'douglas', 'eduardo', 'elias', 'elton', 'emanuel', 'emerson', 'enzo',
    'eric', 'erick', 'evandro', 'fabiano', 'fabio', 'fabricio', 'felipe', 'fernando',
    'flavio', 'francisco', 'gabriel', 'geovane', 'gilberto', 'giovanni', 'guilherme',
    'gustavo', 'heitor', 'henrique', 'henry', 'hugo', 'iago', 'ian', 'icaro', 'icarus',
    'igor', 'isaac', 'isac', 'jailson', 'jeferson', 'joao', 'joaquim', 'jonas',
    'jonathan', 'jorge', 'jose', 'julio', 'kaio', 'kauan', 'kleber', 'leandro',
    'leo', 'leonardo', 'levi', 'lorenzo', 'lucas', 'lucca', 'luis', 'luiz', 'marcelo',
    'marcio', 'marcos', 'mateus', 'matheus', 'mauricio', 'miguel', 'murilo', 'nathan',
    'nicolas', 'otavio', 'pablo', 'paulo', 'pedro', 'rafael', 'ramon', 'raul',
    'reginaldo', 'renan', 'renato', 'ricardo', 'roberto', 'rodrigo', 'rogerio',
    'ruan', 'samuel', 'sandro', 'sergio', 'tales', 'thales', 'theo', 'thiago',
    'tiago', 'victor', 'vinicius', 'vitor', 'wagner', 'wallace', 'wellington',
    'wesley', 'willian', 'william', 'yuri'
  ]);

  /**
   * Extrai o primeiro nome limpo de um contato
   */
  public static extractFirstName(rawName?: string): string {
    if (!rawName) return '';
    // Remove emojis, caracteres especiais e pontuação
    const cleaned = rawName
      .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
      .replace(/[^a-zA-ZáàâãéèêíïóôõöúçñÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇÑ\s]/g, ' ')
      .trim();

    if (!cleaned) return '';
    const firstWord = cleaned.split(/\s+/)[0];
    return firstWord.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Detecta o gênero do contato baseado no nome ou JID
   */
  public static detectGender(name?: string): GenderIdentity {
    const firstName = this.extractFirstName(name);
    if (!firstName || firstName.length < 2) {
      return 'neutral';
    }

    if (this.femaleNames.has(firstName)) {
      return 'feminine';
    }

    if (this.maleNames.has(firstName)) {
      return 'masculine';
    }

    // Heurísticas morfológicas de terminação em português:
    // Nomes terminados em 'a' (ex: Roberta, Luana, Jéssica) tendem a ser femininos,
    // exceto exceções óbvias (ex: Lucas, Jonas, Elias, etc já capturados acima)
    if (firstName.endsWith('a') && !['luca', 'sasha'].includes(firstName)) {
      return 'feminine';
    }

    if (
      firstName.endsWith('o') ||
      firstName.endsWith('os') ||
      firstName.endsWith('el') ||
      firstName.endsWith('er') ||
      firstName.endsWith('or') ||
      firstName.endsWith('on') ||
      firstName.endsWith('an')
    ) {
      return 'masculine';
    }

    return 'neutral';
  }
}
