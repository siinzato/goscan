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
    //
    // BUG REAL corrigido: uma Garrafa Fresh real (câmera, não foto de
    // catálogo) foi capturada com distância 0.52-0.57 contra a própria
    // categoria "garrafa" (evidência real medida em produção — nenhuma foto
    // de referência da garrafa parecia o suficiente com aquele ambiente
    // real) e 0.36-0.39 contra "copo" — o gate por MARGEM RELATIVA entre
    // categorias (categoryGateMinGap em scanRecognize.ts) via corretamente
    // uma folga grande entre as duas (~0.15-0.21) e declarava a categoria
    // "clara", mesmo a vencedora (copo) sendo, em termos ABSOLUTOS, um match
    // ruim (perto do teto de mediumMaxDistance). Margem relativa entre duas
    // categorias ruins não prova que a vencedora é confiável. Este teto
    // absoluto é deliberadamente mais rígido que mediumMaxDistance — mesmo
    // sacrificando alguns acertos legítimos sob luz muito ruim (a Parte 5
    // mediu até 0.36 pra mesmo-produto em luz forte), prefere dizer "não
    // identificado" a arriscar uma categoria errada, como pedido
    // explicitamente pelo usuário. Provisório — recalibrar com mais fotos
    // reais por variante (catálogo ainda tem só 1 foto por cor em várias).
    categoryMaxDistance: 0.32,
  },

  // Sinal estrutural REAL (não embedding): proporção altura/largura, medida
  // recortando o fundo da imagem (sharp .trim()) e comparando a caixa
  // delimitadora do produto. Medição real contra fotos de catálogo (estúdio,
  // fundo uniforme):
  //   garrafa-fresh: 3.11 / 3.26 / 3.35
  //   copo-vibe:     1.74 / 1.74
  //   copo-life:     1.84 / 2.68 / 2.69
  // Separação limpa entre 2.69 (copo) e 3.11 (garrafa) — usa o meio (2.9)
  // como limite. Só serve como regra ELIMINATÓRIA quando a medição é
  // confiável (o recorte realmente achou um objeto menor que o quadro
  // inteiro) — fundo poluído de uma foto de câmera real geralmente IMPEDE
  // o .trim() de encontrar o produto, e nesse caso a "proporção" medida
  // seria só a do quadro da câmera, não do objeto — por isso nunca é
  // aplicada às cegas, só quando structuralSignals.ts confirma que o
  // recorte é confiável.
  aspectRatio: {
    garrafaMinRatio: 2.9,
  },
} as const;

export type ConfidenceLevel = "high" | "medium" | "low" | "none";
