// MODO SCAN — Parte 3: todos os limiares/números "mágicos" do serviço de
// reconhecimento ficam centralizados aqui, nunca espalhados pelo código.
//
// IMPORTANTE: estes valores são um ponto de partida razoável para embeddings
// CLIP (distância = 1 - similaridade de cosseno), mas NÃO foram calibrados
// contra a base visual real deste catálogo — até a data desta entrega, a
// Parte 2 (migrations 0010/0011/0012) ainda não tinha sido aplicada no
// Supabase e nenhum embedding real existe. Assim que houver embeddings
// reais + testes reais, estes números devem ser revisados com dados de
// verdade, não só teoricamente.
export const SCAN_CONFIG = {
  // Validação do quadro recebido
  maxFrameBytes: 3 * 1024 * 1024, // 3MB — um frame de câmera deve ser bem menor que uma foto de catálogo
  minDimensionPx: 64,
  maxDimensionPx: 4000,
  processingTimeoutMs: 8000,

  // Frequência de chamadas (rate limit) por usuário — em memória, válido
  // enquanto o backend rodar num único processo (ver limitação no relatório
  // da Parte 3 sobre múltiplas instâncias).
  //
  // BUG REAL corrigido na Parte 5: o loop da câmera (src/client/ui/screens/scan.ts,
  // TICK_INTERVAL_MS=1000) manda ~1 req/s sustentado — com o limite antigo
  // (8 por 10s = 0.8 req/s) o escaneamento contínuo levava 429 a cada
  // ~8-10s, bem no meio da janela de estabilização, fazendo o produto
  // "nunca ser reconhecido" mesmo apontando certo. O novo valor dá folga de
  // 2x sobre o ritmo real do loop — se TICK_INTERVAL_MS mudar lá, revisar aqui também.
  rateLimit: {
    windowMs: 10_000,
    maxRequestsPerWindow: 20,
  },

  // Busca vetorial
  rawMatchLimit: 30, // candidatos brutos (por imagem) buscados antes de agrupar por produto
  topCandidates: 5, // candidatos finais devolvidos (fora das expansões de família)

  // Confiança — thresholds sobre "distance" (1 - cosine similarity; menor = mais parecido)
  //
  // CALIBRADO na Parte 5 com evidência real: apliquei variações realistas de
  // câmera (compressão igual à do app, brilho ±40%, rotação 15°, produto
  // distante ocupando ~40% do quadro) sobre 6 fotos reais do catálogo e medi
  // a distância contra a própria foto original. Compressão/rotação/distância
  // ficaram quase sempre <=0.22; luz forte foi o pior caso, chegando a
  // 0.31-0.36 em 2 das 6 fotos — ainda MAIS PARECIDO que dois produtos
  // realmente diferentes deveriam ficar, mas acima do antigo mediumMaxDistance
  // (0.30), o que classificava incorretamente o próprio produto como baixa
  // confiança sob luz forte. mediumMaxDistance subiu para 0.38 por causa
  // dessa evidência — não é afrouxar “pra dar certo”, é o valor que cobre o
  // pior caso real medido sem tocar em highMaxDistance/noResultMinDistance.
  // Com só 13 embeddings reais e nenhuma foto de câmera de verdade ainda
  // testada, isso continua provisório — revisar de novo com mais dados reais.
  confidence: {
    noResultMinDistance: 0.45, // acima disso: não há correspondência confiável
    mediumMaxDistance: 0.38, // até aqui (e sem "alta"): confiança média
    highMaxDistance: 0.15, // só pode ser "alta" com distância até aqui...
    highMinGapToSecond: 0.08, // ...E com folga mínima pro 2º produto (não-irmão de família) mais próximo
  },
} as const;

export type ConfidenceLevel = "high" | "medium" | "low" | "none";
