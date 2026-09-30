// Robô semanal (Task Scheduler, sexta-feira) — loga no Tiny COMO UM HUMANO
// (nunca usa API do Tiny, por pedido explícito), baixa o PDF de cada Ordem de
// Compra "em aberto" e sobe pro GoScan (avulsa, pra vincular à NF depois na
// tela normal). Escreve DIRETO no Supabase com a service role key (decisão:
// mais rápido que logar no GoScan também, mas a chave é sensível — nunca sai
// deste .env local, nunca vai pro GitHub). Roda 100% no seu PC.
//
// Antes de rodar pela 1ª vez: veja o README.md desta pasta — precisa ajustar
// os SELETORES DO TINY (marcados "AJUSTAR AQUI" abaixo) olhando a tela real,
// porque eu nunca tive acesso a uma sessão logada do Tiny pra confirmá-los.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { extractPurchaseOrderFromPdf } from "./parsePdf.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv(path.join(DIR, ".env"));

const {
  TINY_EMAIL,
  TINY_PASSWORD,
  TINY_LOGIN_URL = "https://erp.tiny.com.br/login",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GOSCAN_COMPANY_ID,
  TINY_HEADLESS = "true",
} = process.env;

const REQUIRED = { TINY_EMAIL, TINY_PASSWORD, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOSCAN_COMPANY_ID };
for (const [key, value] of Object.entries(REQUIRED)) {
  if (!value) {
    console.error(`[tiny-po-sync] Variável obrigatória ausente: ${key}. Copie .env.example para .env e preencha (ver README.md).`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = [];
function say(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  log.push(line);
}

async function main() {
  const browser = await chromium.launch({ headless: TINY_HEADLESS !== "false" });
  const page = await browser.newPage();

  try {
    say(`Abrindo login do Tiny: ${TINY_LOGIN_URL}`);
    await page.goto(TINY_LOGIN_URL, { waitUntil: "domcontentloaded" });

    // AJUSTAR AQUI se o Tiny renomear os campos — hoje procura por rótulo
    // "E-mail"/"Senha" (texto acessível), não por id/classe (mais resistente
    // a mudança de layout que não muda o texto visível).
    await page.getByLabel(/e-?mail/i).fill(TINY_EMAIL);
    await page.getByLabel(/senha/i).fill(TINY_PASSWORD);
    await page.getByRole("button", { name: /entrar/i }).click();

    await page.waitForLoadState("networkidle");
    // AJUSTAR AQUI — confirmação de login bem-sucedido. Se o Tiny pedir 2FA
    // ou captcha, este waitForURL some no timeout: rode com TINY_HEADLESS=false
    // pra ver a tela na hora e ajustar manualmente.
    await page.waitForURL(/tiny\.com\.br\/(?!login)/i, { timeout: 30000 });
    say("Login no Tiny concluído.");

    // AJUSTAR AQUI — navegação até a lista de Ordens de Compra.
    await page.getByRole("link", { name: /ordens de compra/i }).click();
    await page.waitForLoadState("networkidle");

    // Só as "em aberto" — evita reprocessar OCs já atendidas/canceladas toda semana.
    await page.getByRole("tab", { name: /em aberto/i }).click();
    await page.waitForLoadState("networkidle");

    const rows = page.locator("table tbody tr");
    const rowCount = await rows.count();
    say(`${rowCount} ordem(ns) de compra "em aberto" encontrada(s).`);

    let inserted = 0;
    let skippedDuplicate = 0;
    let failed = 0;

    for (let i = 0; i < rowCount; i++) {
      const row = rows.nth(i);
      const numeroPedido = (await row.locator("td").first().innerText()).trim();

      try {
        // Dedup ANTES de baixar/abrir o PDF — mais barato e evita reprocessar
        // uma OC que o robô já subiu numa sexta anterior.
        const { data: existing, error: existingError } = await supabase
          .from("invoice_purchase_orders")
          .select("id")
          .eq("company_id", GOSCAN_COMPANY_ID)
          .eq("order_number", numeroPedido)
          .limit(1);
        if (existingError) throw existingError;
        if (existing && existing.length > 0) {
          say(`OC ${numeroPedido}: já existe no GoScan, pulando.`);
          skippedDuplicate++;
          continue;
        }

        // AJUSTAR AQUI — ação real de baixar o PDF desta linha (menu "⋮" ->
        // "Imprimir"/"Baixar PDF", ou abrir a OC e clicar em "Imprimir" lá
        // dentro — depende de como o Tiny expõe isso na tela real).
        const [download] = await Promise.all([page.waitForEvent("download"), row.getByRole("button", { name: /mais ações|imprimir|pdf/i }).click()]);
        const pdfPath = path.join(DIR, "downloads", download.suggestedFilename() || `oc-${numeroPedido}.pdf`);
        mkdirSync(path.dirname(pdfPath), { recursive: true });
        await download.saveAs(pdfPath);

        const buffer = readFileSync(pdfPath);
        const { items, metadata } = await extractPurchaseOrderFromPdf(buffer);
        const validItems = items.filter((it) => it.gtin_normalized && it.sku_code);
        if (validItems.length === 0) {
          say(`OC ${numeroPedido}: PDF baixado mas nenhum item válido extraído — pulando (confira o layout deste PDF manualmente).`);
          failed++;
          continue;
        }

        const { data: po, error: poError } = await supabase
          .from("invoice_purchase_orders")
          .insert({
            receipt_id: null,
            file_name: path.basename(pdfPath),
            title: path.basename(pdfPath),
            order_number: metadata.orderNumber || numeroPedido,
            supplier_name: metadata.supplierName,
            order_date: metadata.orderDate,
            expected_date: metadata.expectedDate,
            uploaded_by: null,
            company_id: GOSCAN_COMPANY_ID,
          })
          .select()
          .single();
        if (poError) throw poError;

        const { error: itemsError } = await supabase.from("invoice_purchase_order_items").insert(
          validItems.map((it) => ({
            purchase_order_id: po.id,
            gtin_normalized: it.gtin_normalized,
            sku_code: it.sku_code,
            description: it.description,
            quantity: it.quantity,
          }))
        );
        if (itemsError) throw itemsError;

        say(`OC ${numeroPedido}: ${validItems.length} item(ns) enviado(s) ao GoScan (avulsa — vincule à NF quando ela chegar).`);
        inserted++;
      } catch (err) {
        say(`OC ${numeroPedido}: ERRO — ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    say(`Resumo: ${inserted} nova(s), ${skippedDuplicate} já existente(s), ${failed} com erro.`);
  } catch (err) {
    say(`FALHA GERAL — ${err instanceof Error ? err.message : String(err)}`);
    try {
      await page.screenshot({ path: path.join(DIR, "logs", `erro-${Date.now()}.png`) });
      say("Screenshot do erro salvo em logs/.");
    } catch {
      // nunca deixa uma falha ao tirar screenshot mascarar o erro real acima
    }
    process.exitCode = 1;
  } finally {
    await browser.close();
    writeLog();
  }
}

function writeLog() {
  const dir = path.join(DIR, "logs");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`);
  writeFileSync(file, log.join("\n") + "\n", { flag: "a" });
}

/** Sem dependência de "dotenv" — o script só precisa ler NOME=valor de um arquivo local. */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

await main();
