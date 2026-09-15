import test from "node:test";
import assert from "node:assert/strict";
import { normalize, escapeHtml, debounce, normalizeEan, isValidEanFormat, parseConferirHash } from "../src/client/utils.ts";

test("normalize strips accents, case and punctuation", () => {
  assert.equal(normalize("Preço: Rosa e Lilás!"), "preco rosa e lilas");
  assert.equal(normalize("  Tote   Mini  "), "tote mini");
  assert.equal(normalize(null), "");
  assert.equal(normalize(undefined), "");
});

test("escapeHtml neutralizes HTML-significant characters", () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(escapeHtml("O'Brien & Cia"), "O&#39;Brien &amp; Cia");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

// ---------------------------------------------------------------------------
// CORREÇÃO — Reconhecimento automático e busca por EAN: normalizeEan é a
// ÚNICA regra de normalização de código de barras usada em todo o app
// (parser, matching, busca, importer, CRUD manual).
// ---------------------------------------------------------------------------
test("normalizeEan remove espaços, pontos e traços, mantendo só dígitos", () => {
  assert.equal(normalizeEan("8800328810198"), "8800328810198");
  assert.equal(normalizeEan(" 8800328810198 "), "8800328810198");
  assert.equal(normalizeEan("8800 3288 10198"), "8800328810198");
  assert.equal(normalizeEan("8800-3288-10198"), "8800328810198");
  assert.equal(normalizeEan("8800.3288.10198"), "8800328810198");
});

test("normalizeEan nunca perde zero à esquerda (nunca converte para número)", () => {
  assert.equal(normalizeEan("0078955555555"), "0078955555555");
});

test("normalizeEan lida com null/undefined/vazio sem lançar exceção", () => {
  assert.equal(normalizeEan(null), "");
  assert.equal(normalizeEan(undefined), "");
  assert.equal(normalizeEan(""), "");
  assert.equal(normalizeEan("SEM GTIN"), "");
});

test("isValidEanFormat aceita só 8, 12, 13 ou 14 dígitos", () => {
  assert.equal(isValidEanFormat("12345678"), true); // EAN-8
  assert.equal(isValidEanFormat("123456789012"), true); // UPC-A
  assert.equal(isValidEanFormat("1234567890123"), true); // EAN-13
  assert.equal(isValidEanFormat("12345678901234"), true); // ITF-14/GTIN-14
});

test("isValidEanFormat rejeita lixo comum de XML de NF-e (nunca finge que é um EAN válido)", () => {
  assert.equal(isValidEanFormat(normalizeEan("0")), false);
  assert.equal(isValidEanFormat(normalizeEan("N/A")), false);
  assert.equal(isValidEanFormat(normalizeEan("SEMGTIN")), false);
  assert.equal(isValidEanFormat(normalizeEan("SEM GTIN")), false);
  assert.equal(isValidEanFormat(normalizeEan("")), false);
  assert.equal(isValidEanFormat(normalizeEan("123")), false); // curto demais
});

test("debounce only invokes the last call within the window", async () => {
  let calls = 0;
  let lastArg = null;
  const fn = debounce((arg) => {
    calls++;
    lastArg = arg;
  }, 20);

  fn("a");
  fn("b");
  fn("c");

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(calls, 1);
  assert.equal(lastArg, "c");
});

// ---------------------------------------------------------------------------
// FASE 4 — rota canônica da NF-e (#/conferir/nfe/<id>). Função pura, sem DOM.
// ---------------------------------------------------------------------------
test("parseConferirHash: #/conferir vira modo imagens (comportamento atual preservado)", () => {
  const result = parseConferirHash("#/conferir");
  assert.equal(result.mode, "imagens");
  assert.equal(result.nfeReceiptId, null);
});

test("parseConferirHash: #/conferir/nfe seleciona o modo Nota Fiscal sem receipt", () => {
  const result = parseConferirHash("#/conferir/nfe");
  assert.equal(result.mode, "nfe");
  assert.equal(result.nfeReceiptId, null);
});

test("parseConferirHash: #/conferir/nfe/<uuid> preserva o receiptId no modo Nota Fiscal", () => {
  const result = parseConferirHash("#/conferir/nfe/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(result.mode, "nfe");
  assert.equal(result.nfeReceiptId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("parseConferirHash nunca lança exceção pra hash ausente/vazio/malformado", () => {
  assert.doesNotThrow(() => parseConferirHash(""));
  assert.doesNotThrow(() => parseConferirHash("#"));
  assert.doesNotThrow(() => parseConferirHash("#/"));
  assert.doesNotThrow(() => parseConferirHash("lixo-qualquer"));
  assert.equal(parseConferirHash("#/conferir/nfe/").nfeReceiptId, null); // receiptId ausente nunca vira string vazia
});

test("parseConferirHash ignora outras rotas (nunca confunde com o módulo NF)", () => {
  assert.equal(parseConferirHash("#/historico").mode, "imagens");
  assert.equal(parseConferirHash("#/conferir/devolucao").mode, "imagens");
});
