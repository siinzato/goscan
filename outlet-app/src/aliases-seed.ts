// Dicionário de apelidos -> model_code (prefixo do SKU antes do código de cor)
// Construído a partir do conhecimento ensinado nas conferências manuais.
// Aliases mais longos/específicos devem ser checados antes dos mais curtos - o motor de
// matching (server.ts) já ordena por tamanho, então a ordem aqui não importa.

export const MODEL_ALIASES: Record<string, string> = {
  // Tote Mini
  "tote mini": "TBGCM55",
  "micro tote": "TBGCM55",
  "bolsa tote mini": "TBGCM55",

  // Tote Daily
  "tote daily": "TBGCM31",
  "bolsa tote daily": "TBGCM31",
  "bolsa tote daily clear": "TBGCM31",

  // Micro Pop Tote
  "micro pop tote": "TBGCM103",
  "micro pop": "TBGCM103",
  "tote pop micro": "TBGCM103",
  "micro tote pop": "TBGCM103",
  "bolsa tote pop": "TBGCM103",
  "tote pop": "TBGCM103",

  // Tote Puffer
  "tote puffer": "TBGCM56",
  "bolsa tote puffer": "TBGCM56",
  "puffer": "TBGCM56",

  // Tote Puffer Moon
  "tote puffer moon": "TBGCM107",
  "tote moon puffer": "TBGCM107",
  "tote moon": "TBGCM107",
  "bolsa moon": "TBGCM107",
  "bolsa tote moon": "TBGCM107",
  "bolsa tote moon puffer": "TBGCM107",

  // Tote Puffer Fitness
  "tote puffer fitness": "BFGCM108",
  "puffer fitness": "BFGCM108",
  "bolsa fitness puffer": "BFGCM108",
  "bolsa puffer fitness": "BFGCM108",

  // Necessaire Puffer M
  "necessaire puffer m": "NPM109",
  "necessarie puffer m": "NPM109",

  // Necessaire Puffer Basic
  "necessaire puffer basic": "NPGCM108",
  "necessarie puffer basic": "NPGCM108",
  "necessarie basica": "NPGCM108",
  "necessarie basic": "NPGCM108",
  "necessaire basica": "NPGCM108",
  "necessaire basic": "NPGCM108",

  // Bolsa Tote Garrafa
  "bolsa tote garrafa": "BGGCM109",
  "bolsa de garrafa puffer": "BGGCM109",
  "bolsa puffer para garrafas": "BGGCM109",
  "bolsa garrafa": "BGGCM109",

  // Moove
  "moove": "BMGCM48",
  "bolsa moove": "BMGCM48",

  // Joy / Joy Pro
  "joy pro": "BVGCM44",
  "joy pró": "BVGCM44",
  "joy": "BVGCM44",

  // Linha Voyage (3 produtos diferentes)
  "mochila voyage": "MCGCM57",
  "necessaire voyage": "NVGCM58",
  "necessarie voyage": "NVGCM58",
  "bolsa voyage": "BVGCM54",

  // Mochilas
  "mochila fun 4 rodas": "MCGCM67",
  "mochila fun": "MCGCM67",
  "mochila pop": "MCGCM22",
  "mochila casual": "MCGCM5",
  "mochila executiva": "MCGCM64",
  "mochila play": "MCGCM43",

  // Notebook
  "capa notebook slim 14": "BNGCM71",
  "notebook slim 14": "BNGCM71",
  "capa notebook slim 15": "BNGCM72",
  "notebook slim 15": "BNGCM72",
  "capa notebook slim 15,6": "BNGCM72",
  "capa notebook puffer": "CNGCM106",
  "capa case puffer notebook": "CNGCM106",

  // Mix / Lancheira Mix
  "lancheira mix": "BMGCM47",
  "mix": "BMGCM47",

  // Fruit
  "fruit": "BTGCM7",
  "lancheira fruit": "BTGCM7",

  // Organizador
  "organizador tote": "OTGCM51",
  "organizador": "OTGCM51",

  // Necessarie Trip
  "necessarie trip": "BAGCM86",
  "necessaire trip": "BAGCM86",

  // Necessarie Holografica
  "necessarie holografica": "NMGCM106",
  "necessaire holografica": "NMGCM106",
  "necessarie holográfica": "NMGCM106",
  "estojo holografica": "NMGCM106",

  // Necessarie Doublé (Makeup Double Basic)
  "necessarie double": "NMGCM11",
  "necessarie doublé": "NMGCM11",
  "necessaire double": "NMGCM11",
  "necessaire doublé": "NMGCM11",

  // Tote Shopper/Shoper
  "tote shopper": "TBGCM90",
  "tote shoper": "TBGCM90",
  "bolsa tote shopper": "TBGCM90",

  // Estojo
  "estojo box fun": "EBGCM29",
  "estojo fun": "EBGCM29",
  "estojo box": "EBGCM29",
  "estojo box play": "EBGCM45",
  "estojo play": "EBGCM45",

  // Lancheira Play
  "lancheira play": "BTGCM49",

  // Bolsa Térmica Fun (lancheira fun)
  "lancheira fun": "BTGCM68",
  "bolsa termica fun": "BTGCM68",
};

// Aliases de cor -> nome canônico da cor (deve bater com o texto após o último " - " no catálogo)
export const COLOR_ALIASES: Record<string, string> = {
  "preto": "Preto",
  "preta": "Preto",
  "black": "Preto",
  "off white": "Off White",
  "offwhite": "Off White",
  "off-white": "Off White",
  "marrom": "Marrom",
  "vinho": "Vinho",
  "rosa": "Rosa",
  "rose": "Rosa",
  "cinza": "Cinza",
  "lilas": "Lilás",
  "lilás": "Lilás",
  "amora": "Amora",
  "bege": "Bege e Caramelo",
  "bege caramelo": "Bege e Caramelo",
  "bege c caramelo": "Bege e Caramelo",
  "bege e caramelo": "Bege e Caramelo",
  "rosa e lilas": "Rosa e Lilás",
  "rosa com lilas": "Rosa e Lilás",
  "rosa e lilás": "Rosa e Lilás",
  "preto com caramelo": "Preto com Caramelo",
  "preto c caramelo": "Preto com Caramelo",
  "preto c marrom": "Preto e marrom",
  "preto e marrom": "Preto e marrom",
  "holografica": "Holográfica",
  "holográfica": "Holográfica",
  "azul claro": "Azul Claro",
  "azul marinho": "Azul Marinho",
  "azul": "Azul",
  "verde": "Verde",
  "roxo": "Roxo",
  "rose gold": "Rose Gold",
  "branco": "Branco",
  "amarelo": "Amarelo",
  "melancia": "Melancia",
  "salmao glitter": "Salmão Glitter",
  "gelo": "Gelo",
};
