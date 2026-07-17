import test from "node:test";
import assert from "node:assert/strict";
import { normalize, escapeHtml, debounce } from "../src/client/utils.ts";

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
