// EXPANSÃO GOSCAN — Conferência por Nota Fiscal, Parte 1: leitura do XML da
// NF-e. Roda 100% no cliente (nada privilegiado aqui — é o próprio XML que o
// operador está fornecendo), igual ao resto do fluxo de conferências que já
// fala direto com o Supabase. Função pura, sem I/O, por isso testável direto
// com `node --test` (fast-xml-parser funciona igual em Node e no bundle Vite).
import { XMLParser } from "fast-xml-parser";
import { normalizeEan, isValidEanFormat } from "./utils.ts";

export interface NfeParsedItem {
  invoice_product_code: string;
  description: string;
  ean: string | null;
  unit: string | null;
  quantity: number;
  unit_value: number | null;
  total_value: number | null;
}

export interface NfeParsed {
  invoice_key: string;
  invoice_number: string | null;
  series: string | null;
  supplier_name: string | null;
  supplier_cnpj: string | null;
  issued_at: string | null;
  items: NfeParsedItem[];
}

// parseTagValue/parseAttributeValue desligados de propósito: cEAN e cProd
// costumam ser strings puramente numéricas (código de barras, SKU com
// zeros à esquerda) — deixar a lib "adivinhar" number perderia zero à
// esquerda e criaria imprecisão de ponto flutuante sem necessidade nenhuma.
// Convertemos pra number manualmente só nos campos que realmente são
// quantidade/valor (toNumber, abaixo).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type XmlNode = Record<string, unknown>;

function asNode(value: unknown): XmlNode {
  return value && typeof value === "object" ? (value as XmlNode) : {};
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function toNumber(value: unknown): number | null {
  const s = text(value);
  if (s === null) return null;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Regra de EAN (seção 13 do pedido de consulta por chave, endurecida na
 * correção de reconhecimento automático): valores como "SEM GTIN", "SEMGTIN",
 * "N/A" ou "0" nunca são um código de barras — só marcadores de "não
 * informado". Em vez de checar caso a caso, valida o FORMATO real (8/12/13/14
 * dígitos após normalizar) — qualquer lixo sem esse formato é tratado como
 * ausente, nunca como um EAN válido por acidente. Retorna o texto ORIGINAL
 * (trimado, nunca convertido pra número — perderia zero à esquerda), só a
 * checagem de validade usa a forma normalizada.
 */
function validEanCandidate(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || !isValidEanFormat(normalizeEan(trimmed))) return null;
  return trimmed;
}

/** Extrai o nó infNFe independentemente do XML ser um "nfeProc" (com protocolo) ou um "NFe" isolado. */
function findInfNFe(root: XmlNode): XmlNode | null {
  const nfeProc = asNode(root.nfeProc);
  const nfe = asNode(nfeProc.NFe ?? root.NFe);
  const infNFe = nfe.infNFe ?? root.infNFe;
  return infNFe && typeof infNFe === "object" ? (infNFe as XmlNode) : null;
}

export interface NfeXmlDiagnostics {
  arquivoLido: true;
  xmlValido: boolean;
  root: string | null;
  nfeEncontrada: boolean;
  infNFeEncontrada: boolean;
  chave: string | null;
  numero: string | null;
  itensDet: number;
  erro: string | null;
  etapa: string | null;
}

/**
 * Diagnóstico passo a passo — NUNCA lança exceção, sempre retorna o que
 * conseguiu descobrir até o ponto da falha. Usado só no painel de debug
 * temporário (admin) pra mostrar exatamente onde um XML real quebrou, em
 * vez de um "NF não encontrada" genérico.
 */
export function diagnoseNfeXml(xml: string): NfeXmlDiagnostics {
  const info: NfeXmlDiagnostics = {
    arquivoLido: true,
    xmlValido: false,
    root: null,
    nfeEncontrada: false,
    infNFeEncontrada: false,
    chave: null,
    numero: null,
    itensDet: 0,
    erro: null,
    etapa: "parse XML",
  };

  let root: XmlNode;
  try {
    root = asNode(parser.parse(xml));
    info.xmlValido = true;
  } catch (err) {
    info.erro = err instanceof Error ? err.message : String(err);
    return info;
  }

  // "?xml" é a declaração <?xml version="1.0"?> — fast-xml-parser expõe
  // como mais uma chave do objeto raiz; não é o elemento raiz de verdade.
  info.root = Object.keys(root).find((k) => !k.startsWith("?")) ?? null;
  info.etapa = "localizar NFe";
  const nfeProc = asNode(root.nfeProc);
  const nfeRaw = nfeProc.NFe ?? root.NFe;
  info.nfeEncontrada = !!(nfeRaw && typeof nfeRaw === "object");

  info.etapa = "localizar infNFe";
  const nfe = asNode(nfeRaw);
  const infNFeRaw = nfe.infNFe ?? root.infNFe;
  info.infNFeEncontrada = !!(infNFeRaw && typeof infNFeRaw === "object");
  if (!info.infNFeEncontrada) {
    info.erro = "Nó infNFe não encontrado";
    return info;
  }

  info.etapa = "ler chave/número/itens";
  const infNFe = asNode(infNFeRaw);
  const chaveRaw = text(infNFe["@_Id"]) || "";
  info.chave = chaveRaw.replace(/^NFe/i, "").trim() || null;
  info.numero = text(asNode(infNFe.ide).nNF);
  info.itensDet = asArray(infNFe.det).length;
  info.etapa = info.itensDet > 0 ? null : "nenhum <det> encontrado";
  if (info.itensDet === 0) info.erro = "NF-e sem itens (nenhum nó det/prod encontrado)";
  return info;
}

export function parseNfeXml(xml: string): NfeParsed {
  let root: XmlNode;
  try {
    root = asNode(parser.parse(xml));
  } catch (err) {
    throw new Error("XML inválido: " + (err instanceof Error ? err.message : String(err)));
  }

  const infNFe = findInfNFe(root);
  if (!infNFe) {
    throw new Error("XML não parece ser uma NF-e válida (nó infNFe não encontrado).");
  }

  const invoiceKeyRaw = text(infNFe["@_Id"]) || "";
  const invoice_key = invoiceKeyRaw.replace(/^NFe/i, "").trim();
  if (!invoice_key) {
    throw new Error("Não foi possível extrair a chave de acesso da NF-e (atributo Id de infNFe).");
  }

  const ide = asNode(infNFe.ide);
  const emit = asNode(infNFe.emit);
  const invoice_number = text(ide.nNF);
  const series = text(ide.serie);
  const supplier_name = text(emit.xNome);
  const supplier_cnpj = text(emit.CNPJ);
  const issued_at = text(ide.dhEmi) || text(ide.dEmi);

  const detList = asArray(infNFe.det);
  if (detList.length === 0) {
    throw new Error("NF-e sem itens (nenhum nó det/prod encontrado).");
  }

  const items: NfeParsedItem[] = detList.map((detRaw, idx) => {
    const det = asNode(detRaw);
    const prodRaw = det.prod;
    if (!prodRaw || typeof prodRaw !== "object") {
      throw new Error(`Item ${idx + 1} da NF-e sem nó <prod>.`);
    }
    const prod = asNode(prodRaw);
    // Prioriza cEAN; cai para cEANTrib (EAN tributável) só quando o primeiro
    // está ausente/"SEM GTIN"/inválido — nunca o contrário (cEAN sempre vence
    // quando é um código real).
    const ean = validEanCandidate(text(prod.cEAN)) ?? validEanCandidate(text(prod.cEANTrib));
    return {
      invoice_product_code: text(prod.cProd) || "",
      description: text(prod.xProd) || "",
      ean,
      unit: text(prod.uCom),
      quantity: toNumber(prod.qCom) ?? 0,
      unit_value: toNumber(prod.vUnCom),
      total_value: toNumber(prod.vProd),
    };
  });

  return { invoice_key, invoice_number, series, supplier_name, supplier_cnpj, issued_at, items };
}
