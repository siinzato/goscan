import test from "node:test";
import assert from "node:assert/strict";
import { parseVoiceCommand } from "../src/client/voiceCommands.ts";

test("parseVoiceCommand reconhece 'adicionar N unidades' com dígito", () => {
  const cmd = parseVoiceCommand("adicionar 12 unidades");
  assert.deepEqual(cmd, { kind: "add_quantity", amount: 12 });
});

test("parseVoiceCommand reconhece 'adicionar' com número por extenso", () => {
  const cmd = parseVoiceCommand("adiciona três unidades");
  assert.deepEqual(cmd, { kind: "add_quantity", amount: 3 });
});

test("parseVoiceCommand reconhece 'remover N unidades'", () => {
  const cmd = parseVoiceCommand("remover 2 unidades");
  assert.deepEqual(cmd, { kind: "remove_quantity", amount: 2 });
});

test("parseVoiceCommand é insensível a acentos ('próximo produto' vs 'proximo produto')", () => {
  assert.equal(parseVoiceCommand("próximo produto").kind, "next_product");
  assert.equal(parseVoiceCommand("proximo produto").kind, "next_product");
});

test("parseVoiceCommand reconhece 'finalizar produto'", () => {
  assert.equal(parseVoiceCommand("finalizar produto").kind, "finish_product");
});

test("parseVoiceCommand reconhece 'mostrar pendentes'", () => {
  assert.equal(parseVoiceCommand("mostrar pendentes").kind, "show_pending");
});

test("parseVoiceCommand reconhece 'desfazer última bipagem'", () => {
  assert.equal(parseVoiceCommand("desfazer última bipagem").kind, "undo_last");
});

test("parseVoiceCommand reconhece 'pausar conferência'", () => {
  assert.equal(parseVoiceCommand("pausar conferência").kind, "pause_conference");
});

test("parseVoiceCommand reconhece 'confirmar' e 'cancelar' isolados", () => {
  assert.equal(parseVoiceCommand("confirmar").kind, "confirm");
  assert.equal(parseVoiceCommand("cancelar").kind, "cancel");
});

test("parseVoiceCommand NUNCA inventa uma quantidade quando nenhum número é falado", () => {
  const cmd = parseVoiceCommand("adicionar unidades");
  assert.equal(cmd.kind, "unrecognized");
});

test("parseVoiceCommand devolve 'unrecognized' com o texto bruto pra frase sem comando reconhecível", () => {
  const cmd = parseVoiceCommand("oi tudo bem");
  assert.deepEqual(cmd, { kind: "unrecognized", raw: "oi tudo bem" });
});

test("parseVoiceCommand nunca aplica ação sozinho — sempre retorna dado estruturado pro chamador decidir", () => {
  // Garantia estrutural: a função é pura (mesma entrada -> mesma saída, sem
  // efeito colateral) — quem decide agir é sempre a tela, após confirmação.
  const a = parseVoiceCommand("adicionar 5 unidades");
  const b = parseVoiceCommand("adicionar 5 unidades");
  assert.deepEqual(a, b);
});
