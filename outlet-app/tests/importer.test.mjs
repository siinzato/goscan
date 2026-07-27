import test from "node:test";
import assert from "node:assert/strict";
import { mapSheetRows, validateAndNormalizeNormalRows } from "../src/client/importer.ts";

test("mapSheetRows recognizes common spreadsheet headers regardless of accents/case", () => {
  const raw = [
    { Produto: "Bolsa Tote Mini - Preto", "Código (SKU)": "OUT-TBGCM55-1", "GTIN/EAN": "789", Cor: "Preto" },
    { produto: "Joy Pro - Marrom", sku: "OUT-BVGCM44-6" },
  ];
  const mapped = mapSheetRows(raw);

  assert.equal(mapped[0].produto, "Bolsa Tote Mini - Preto");
  assert.equal(mapped[0].sku_code, "OUT-TBGCM55-1");
  assert.equal(mapped[0].gtin, "789");
  assert.equal(mapped[0].cor, "Preto");

  assert.equal(mapped[1].produto, "Joy Pro - Marrom");
  assert.equal(mapped[1].sku_code, "OUT-BVGCM44-6");
});

test("mapSheetRows drops empty/blank cells instead of keeping empty strings", () => {
  const raw = [{ Produto: "  ", SKU: "OUT-X-1" }];
  const mapped = mapSheetRows(raw);
  assert.equal(mapped[0].produto, undefined);
  assert.equal(mapped[0].sku_code, "OUT-X-1");
});

test("mapSheetRows ignores unrecognized columns", () => {
  const raw = [{ Observacoes: "nada a ver", Produto: "X", SKU: "OUT-X-1" }];
  const mapped = mapSheetRows(raw);
  assert.equal(Object.keys(mapped[0]).includes("Observacoes" ), false);
});

// BUG REAL corrigido: várias linhas de Produtos Normais com o MESMO
// model_code (mesma família) mas nomes completos diferentes (cada um com
// sua própria cor colada no texto) faziam só o nome do PRIMEIRO SKU
// processado "vencer" e ficar preso em todas as cores da família — porque
// products.name é compartilhado por model_code, e o import não separava
// nome-da-família de cor-no-texto (diferente do import Outlet, que já fazia
// essa separação). Isso é sobre o AGRUPAMENTO por família ficar consistente,
// não sobre extrair a cor certa daqui (a cor real vem do sufixo do SKU).
test("validateAndNormalizeNormalRows remove o sufixo ' - Cor' do nome para a família agrupar com nome limpo e consistente", () => {
  const rows = [
    { nome: "Bolsa de Viagem GoCase Joy - Off White", sku_code: "BVJ-1", ean: "" },
    { nome: "Bolsa de Viagem GoCase Joy - Preto", sku_code: "BVJ-2", ean: "" },
    { nome: "Bolsa de Viagem GoCase Joy - Azul", sku_code: "BVJ-3", ean: "" },
  ];
  const { valid, errors } = validateAndNormalizeNormalRows(rows);
  assert.equal(errors.length, 0);
  assert.equal(valid.length, 3);
  // as 3 linhas viram a MESMA família (mesmo model_code) com o MESMO nome-base limpo —
  // nunca o nome completo com cor de qualquer uma das 3 "vencendo" sobre as outras.
  assert.equal(valid[0].base, "Bolsa de Viagem GoCase Joy");
  assert.equal(valid[1].base, "Bolsa de Viagem GoCase Joy");
  assert.equal(valid[2].base, "Bolsa de Viagem GoCase Joy");
  assert.equal(valid[0].model_code, valid[1].model_code);
  assert.equal(valid[1].model_code, valid[2].model_code);
});

test("validateAndNormalizeNormalRows mantém o nome inteiro quando não há ' - ' (nada pra separar)", () => {
  const { valid } = validateAndNormalizeNormalRows([{ nome: "Alça para Têxteis Gocase", sku_code: "ATGCM74", ean: "" }]);
  assert.equal(valid[0].base, "Alça para Têxteis Gocase");
});
