import test from "node:test";
import assert from "node:assert/strict";
import { parseNfeXml, diagnoseNfeXml } from "../src/client/nfeParser.ts";

const REAL_SHAPED_NFE = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe xmlns="http://www.portalfiscal.inf.br/nfe">
    <infNFe Id="NFe35260720123456000199550010000001231000001230" versao="4.00">
      <ide>
        <cUF>35</cUF>
        <nNF>123</nNF>
        <serie>1</serie>
        <dhEmi>2026-07-20T09:30:00-03:00</dhEmi>
      </ide>
      <emit>
        <CNPJ>12345678000199</CNPJ>
        <xNome>Fornecedor Teste Ltda</xNome>
      </emit>
      <det nItem="1">
        <prod>
          <cProd>TCGCM42-1</cProd>
          <xProd>Copo Termico Life 880ml Preto</xProd>
          <cEAN>7891234567890</cEAN>
          <uCom>UN</uCom>
          <qCom>10.0000</qCom>
          <vUnCom>25.0000</vUnCom>
          <vProd>250.00</vProd>
        </prod>
      </det>
      <det nItem="2">
        <prod>
          <cProd>GFGCM13-2</cProd>
          <xProd>Garrafa Fresh 650ml Azul</xProd>
          <cEAN>SEM GTIN</cEAN>
          <uCom>UN</uCom>
          <qCom>20.0000</qCom>
          <vUnCom>40.0000</vUnCom>
          <vProd>800.00</vProd>
        </prod>
      </det>
      <det nItem="3">
        <prod>
          <cProd>UGCM10-1</cProd>
          <xProd>Garrafa Urban 500ml</xProd>
          <cEAN>7899876543210</cEAN>
          <uCom>UN</uCom>
          <qCom>15.0000</qCom>
          <vUnCom>30.0000</vUnCom>
          <vProd>450.00</vProd>
        </prod>
      </det>
    </infNFe>
  </NFe>
</nfeProc>`;

test("parseNfeXml extrai chave (sem prefixo NFe), número, série, fornecedor, CNPJ e emissão", () => {
  const parsed = parseNfeXml(REAL_SHAPED_NFE);
  assert.equal(parsed.invoice_key, "35260720123456000199550010000001231000001230");
  assert.equal(parsed.invoice_number, "123");
  assert.equal(parsed.series, "1");
  assert.equal(parsed.supplier_name, "Fornecedor Teste Ltda");
  assert.equal(parsed.supplier_cnpj, "12345678000199");
  assert.equal(parsed.issued_at, "2026-07-20T09:30:00-03:00");
});

test("parseNfeXml extrai todos os itens com código/descrição/EAN/quantidade/valores reais", () => {
  const parsed = parseNfeXml(REAL_SHAPED_NFE);
  assert.equal(parsed.items.length, 3);

  assert.deepEqual(parsed.items[0], {
    invoice_product_code: "TCGCM42-1",
    description: "Copo Termico Life 880ml Preto",
    ean: "7891234567890",
    unit: "UN",
    quantity: 10,
    unit_value: 25,
    total_value: 250,
  });

  assert.equal(parsed.items[2].invoice_product_code, "UGCM10-1");
  assert.equal(parsed.items[2].quantity, 15);
});

test("parseNfeXml trata 'SEM GTIN' como EAN ausente (null), nunca como texto literal", () => {
  const parsed = parseNfeXml(REAL_SHAPED_NFE);
  assert.equal(parsed.items[1].ean, null);
});

test("parseNfeXml normaliza item único (fast-xml-parser retorna objeto, não array, com só 1 <det>) e aceita XML sem wrapper nfeProc", () => {
  const singleItemXml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe1234567890">
    <ide><nNF>1</nNF><dhEmi>2026-01-01T00:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>00000000000000</CNPJ><xNome>Fornecedor Unico</xNome></emit>
    <det nItem="1">
      <prod><cProd>ABC-1</cProd><xProd>Produto Unico</xProd><cEAN>1111111111111</cEAN><uCom>UN</uCom><qCom>5</qCom><vUnCom>10</vUnCom><vProd>50</vProd></prod>
    </det>
  </infNFe>
</NFe>`;
  const parsed = parseNfeXml(singleItemXml);
  assert.equal(parsed.invoice_key, "1234567890");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].invoice_product_code, "ABC-1");
});

test("parseNfeXml rejeita XML que não é uma NF-e (sem infNFe)", () => {
  assert.throws(() => parseNfeXml("<root><foo>bar</foo></root>"), /infNFe/);
});

test("parseNfeXml rejeita XML sintaticamente inválido", () => {
  assert.throws(() => parseNfeXml("<not-closed"));
});

// Réplica estrutural do XML REAL reportado pelo usuário (protNFe antes de
// NFe, <det> com nItem como ELEMENTO filho — não atributo — e SEM GTIN em
// todo item) — pin down do formato exato que expôs o bug de embed ambíguo
// em nfeApi.ts (não era o parser, mas testamos o parser contra essa forma
// real mesmo assim, já que foi o XML que revelou o problema).
const REAL_REPORTED_SHAPE = `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><protNFe><infProt><nProt>131267744181833</nProt><chNFe>31260736838707000119550050000112771000128392</chNFe><cStat>100</cStat></infProt></protNFe><NFe><infNFe Id="NFe31260736838707000119550050000112771000128392" versao="4.00"><det><nItem>1</nItem><prod><cEAN>SEM GTIN</cEAN><cProd>0086324000024</cProd><qCom>120.0000</qCom><vUnCom>46.000000</vUnCom><vProd>5520.00</vProd><xProd>BOLSA TERMICA MIX BB BRUTA MARROM</xProd><uCom>UN</uCom></prod></det><ide><nNF>11277</nNF><dhEmi>2026-07-21T17:33:35-03:00</dhEmi><serie>5</serie></ide><emit><xNome>BB INDUSTRIA E COMERCIO DE ARTIGOS DE USO PESSOAL LTDA</xNome><CNPJ>36838707000119</CNPJ></emit></infNFe></NFe><versao>4.00</versao></nfeProc>`;

test("parseNfeXml lida com a forma REAL reportada (protNFe + det com nItem como elemento, não atributo)", () => {
  const parsed = parseNfeXml(REAL_REPORTED_SHAPE);
  assert.equal(parsed.invoice_key, "31260736838707000119550050000112771000128392");
  assert.equal(parsed.invoice_number, "11277");
  assert.equal(parsed.series, "5");
  assert.equal(parsed.supplier_name, "BB INDUSTRIA E COMERCIO DE ARTIGOS DE USO PESSOAL LTDA");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].invoice_product_code, "0086324000024");
  assert.equal(parsed.items[0].ean, null); // SEM GTIN
  assert.equal(parsed.items[0].quantity, 120);
});

test("diagnoseNfeXml nunca lança exceção e relata cada etapa — caso de sucesso", () => {
  const diag = diagnoseNfeXml(REAL_SHAPED_NFE);
  assert.equal(diag.xmlValido, true);
  assert.equal(diag.root, "nfeProc");
  assert.equal(diag.nfeEncontrada, true);
  assert.equal(diag.infNFeEncontrada, true);
  assert.equal(diag.chave, "35260720123456000199550010000001231000001230");
  assert.equal(diag.numero, "123");
  assert.equal(diag.itensDet, 3);
  assert.equal(diag.erro, null);
});

test("diagnoseNfeXml relata exatamente onde quebra — XML malformado", () => {
  const diag = diagnoseNfeXml("<not-closed");
  assert.equal(diag.xmlValido, false);
  assert.ok(diag.erro);
});

test("diagnoseNfeXml relata exatamente onde quebra — sem infNFe", () => {
  const diag = diagnoseNfeXml("<root><foo>bar</foo></root>");
  assert.equal(diag.xmlValido, true);
  assert.equal(diag.infNFeEncontrada, false);
  assert.match(diag.erro, /infNFe/);
});

test("diagnoseNfeXml relata exatamente onde quebra — infNFe sem nenhum <det>", () => {
  const diag = diagnoseNfeXml('<NFe><infNFe Id="NFe123"><ide><nNF>1</nNF></ide></infNFe></NFe>');
  assert.equal(diag.infNFeEncontrada, true);
  assert.equal(diag.itensDet, 0);
  assert.match(diag.erro, /det/);
});

// ---------------------------------------------------------------------------
// EXPANSÃO GOSCAN — consulta por chave (Meu Danfe): regra de EAN da seção 13
// do pedido — cEANTrib é usado como fallback só quando cEAN não serve.
// ---------------------------------------------------------------------------
function xmlWithSingleItem(prodXml) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
  <infNFe Id="NFe11111111111111111111111111111111111111111111">
    <ide><nNF>1</nNF><dhEmi>2026-01-01T00:00:00-03:00</dhEmi></ide>
    <emit><CNPJ>00000000000000</CNPJ><xNome>Fornecedor Teste</xNome></emit>
    <det nItem="1"><prod>${prodXml}</prod></det>
  </infNFe>
</NFe>`;
}

test("parseNfeXml usa cEANTrib quando cEAN está vazio", () => {
  const xml = xmlWithSingleItem(
    "<cProd>A-1</cProd><xProd>Produto</xProd><cEAN></cEAN><cEANTrib>7891111111111</cEANTrib><uCom>UN</uCom><qCom>1</qCom>"
  );
  assert.equal(parseNfeXml(xml).items[0].ean, "7891111111111");
});

test("parseNfeXml usa cEANTrib quando cEAN é 'SEM GTIN'", () => {
  const xml = xmlWithSingleItem(
    "<cProd>A-2</cProd><xProd>Produto</xProd><cEAN>SEM GTIN</cEAN><cEANTrib>7892222222222</cEANTrib><uCom>UN</uCom><qCom>1</qCom>"
  );
  assert.equal(parseNfeXml(xml).items[0].ean, "7892222222222");
});

test("parseNfeXml prioriza cEAN mesmo quando cEANTrib também está presente", () => {
  const xml = xmlWithSingleItem(
    "<cProd>A-3</cProd><xProd>Produto</xProd><cEAN>7893333333333</cEAN><cEANTrib>7894444444444</cEANTrib><uCom>UN</uCom><qCom>1</qCom>"
  );
  assert.equal(parseNfeXml(xml).items[0].ean, "7893333333333");
});

test("parseNfeXml retorna null quando cEAN e cEANTrib estão ausentes ou são 'SEM GTIN'", () => {
  const xml = xmlWithSingleItem(
    "<cProd>A-4</cProd><xProd>Produto</xProd><cEAN>SEM GTIN</cEAN><cEANTrib>SEM GTIN</cEANTrib><uCom>UN</uCom><qCom>1</qCom>"
  );
  assert.equal(parseNfeXml(xml).items[0].ean, null);
});

test("parseNfeXml preserva zeros à esquerda do EAN vindo de cEANTrib (nunca vira número)", () => {
  const xml = xmlWithSingleItem(
    "<cProd>A-5</cProd><xProd>Produto</xProd><cEAN></cEAN><cEANTrib>0078955555555</cEANTrib><uCom>UN</uCom><qCom>1</qCom>"
  );
  assert.equal(parseNfeXml(xml).items[0].ean, "0078955555555");
});

// ---------------------------------------------------------------------------
// CORREÇÃO — Reconhecimento automático por EAN: validEanCandidate agora
// valida o FORMATO real (8/12/13/14 dígitos), não só "SEM GTIN" com espaço —
// lixo como "0", "N/A" ou "SEMGTIN" sem espaço não pode ser tratado como um
// EAN válido (bug real: um XML assim fazia o item nunca cair pro cEANTrib).
// ---------------------------------------------------------------------------
test("parseNfeXml rejeita cEAN='0' e usa cEANTrib (antes era aceito como EAN válido por engano)", () => {
  const xml = xmlWithSingleItem("<cProd>A-6</cProd><xProd>Produto</xProd><cEAN>0</cEAN><cEANTrib>7895555555555</cEANTrib><uCom>UN</uCom><qCom>1</qCom>");
  assert.equal(parseNfeXml(xml).items[0].ean, "7895555555555");
});

test("parseNfeXml rejeita cEAN='N/A' e usa cEANTrib", () => {
  const xml = xmlWithSingleItem("<cProd>A-7</cProd><xProd>Produto</xProd><cEAN>N/A</cEAN><cEANTrib>7896666666666</cEANTrib><uCom>UN</uCom><qCom>1</qCom>");
  assert.equal(parseNfeXml(xml).items[0].ean, "7896666666666");
});

test("parseNfeXml rejeita cEAN='SEMGTIN' (sem espaço) igual a 'SEM GTIN'", () => {
  const xml = xmlWithSingleItem("<cProd>A-8</cProd><xProd>Produto</xProd><cEAN>SEMGTIN</cEAN><cEANTrib>7897777777777</cEANTrib><uCom>UN</uCom><qCom>1</qCom>");
  assert.equal(parseNfeXml(xml).items[0].ean, "7897777777777");
});

test("parseNfeXml retorna null quando cEAN e cEANTrib são ambos lixo sem formato de EAN", () => {
  const xml = xmlWithSingleItem("<cProd>A-9</cProd><xProd>Produto</xProd><cEAN>0</cEAN><cEANTrib>N/A</cEANTrib><uCom>UN</uCom><qCom>1</qCom>");
  assert.equal(parseNfeXml(xml).items[0].ean, null);
});
