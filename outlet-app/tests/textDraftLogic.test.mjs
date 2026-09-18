import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Correção urgente — autosave local do rascunho de "Colar texto"
// (src/client/ui/screens/conference.ts). A tela real importa icons.ts (SVGs
// via `?raw`, só resolvível pelo bundler Vite) — não é seguro importar telas
// no runner puro do Node (mesma restrição já usada nas fases anteriores).
// Este é um espelho FIEL das funções puras textDraftKey/saveTextDraft —
// mudar a intenção lá exige mudar aqui também.
// ---------------------------------------------------------------------------
function textDraftKey(userId, conferenceId) {
  return `goscan:outlet:text-draft:${userId}:${conferenceId}`;
}

/** Espelho da decisão de saveTextDraft: string vazia remove a chave, qualquer outro valor grava. */
function decideSaveAction(value) {
  return value ? { action: "set", value } : { action: "remove" };
}

test("textDraftKey: inclui userId e conferenceId, nunca uma chave global", () => {
  const key = textDraftKey("user-1", "conf-1");
  assert.equal(key, "goscan:outlet:text-draft:user-1:conf-1");
});

test("textDraftKey: usuários diferentes na mesma conferência nunca colidem", () => {
  const a = textDraftKey("user-1", "conf-1");
  const b = textDraftKey("user-2", "conf-1");
  assert.notEqual(a, b);
});

test("textDraftKey: conferências diferentes do mesmo usuário nunca colidem", () => {
  const a = textDraftKey("user-1", "conf-1");
  const b = textDraftKey("user-1", "conf-2");
  assert.notEqual(a, b);
});

test("decideSaveAction: texto não vazio -> grava (setItem), preservando o valor exato (sem trim)", () => {
  assert.deepEqual(decideSaveAction("  Tote Mini - Preto - 3\n"), { action: "set", value: "  Tote Mini - Preto - 3\n" });
});

test("decideSaveAction: texto vazio -> remove a chave, nunca grava string vazia", () => {
  assert.deepEqual(decideSaveAction(""), { action: "remove" });
});
