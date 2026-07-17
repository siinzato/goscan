import test from "node:test";
import assert from "node:assert/strict";
import { mapSheetRows } from "../src/client/importer.ts";

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
