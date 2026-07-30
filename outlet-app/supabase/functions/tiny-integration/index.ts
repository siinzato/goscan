// EXPANSÃO GOSCAN — Integração REAL com o Tiny ERP (API v3, OAuth2).
//
// Toda chamada de rede pro Tiny mora SÓ aqui — nunca no frontend (o token
// de acesso nunca sai do backend; ver integration_credentials, RLS
// habilitado e ZERO policies, só service_role toca essa tabela). Ações
// disponíveis:
//   - test_connection: valida credenciais de verdade (GET /info), gated por
//     'integrations.manage' — é uma ação de configuração, não operacional.
//   - list_warehouses: lista depósitos reais (GET /depositos) — disponível
//     pra qualquer usuário ativo, é só leitura pra popular um seletor.
//   - launch_return_batch / launch_invoice_receipt: lançamento real de
//     estoque (POST /estoque/{id}) por item, com idempotência própria (ver
//     tiny_stock_launches, migration 0051 — nem a API v2 nem a v3 do Tiny
//     garantem isso sozinhas). Disponível pra qualquer usuário ativo, mesmo
//     gate de confirm_return_batch_tiny_launch (0048) — não é ação de admin,
//     é o trabalho operacional de quem confirma lançamentos.
//
// Nunca finge sucesso: se a integração não estiver configurada, devolve
// NOT_CONFIGURED explícito pro frontend cair no fluxo manual já existente
// (confirm_return_batch_tiny_launch/confirm_invoice_receipt_tiny_launch,
// sem chamada real nenhuma).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import {
  TINY_API_BASE,
  TINY_OAUTH_TOKEN_URL,
  isAccessTokenExpired,
  buildTinyLaunchIdempotencyKey,
  describeTinyError,
  buildProdutoLookupParams,
  buildStockMovementBody,
  summarizeLaunchResults,
  buildTokenRefreshBody,
  isValidTinyIntegrationAction,
  type LaunchItemResult,
  type TinyLaunchSourceType,
} from "./logic.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" } });
}

interface CallerProfile {
  id: string;
  role: string;
  active: boolean;
  company_id: string;
}

interface TinyCredentials {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
  client_id: string | null;
  client_secret: string | null;
  expires_at: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsPreflight();
  if (req.method !== "POST") return jsonResponse({ success: false, code: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[tiny-integration] variáveis do Supabase ausentes no ambiente da função.");
    return jsonResponse({ success: false, code: "CONFIG_ERROR", message: "Integração não configurada no ambiente. Procure um administrador." }, 500);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ success: false, code: "UNAUTHENTICATED", message: "Sessão inválida. Faça login novamente." }, 401);

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData?.user) return jsonResponse({ success: false, code: "UNAUTHENTICATED", message: "Sessão inválida ou expirada." }, 401);

  const { data: callerRow, error: callerError } = await callerClient.from("profiles").select("id, role, active, company_id").eq("id", userData.user.id).maybeSingle();
  if (callerError || !callerRow) return jsonResponse({ success: false, code: "FORBIDDEN", message: "Perfil não encontrado." }, 403);
  const caller = callerRow as CallerProfile;
  if (!caller.active) return jsonResponse({ success: false, code: "FORBIDDEN", message: "Usuário inativo." }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, code: "INVALID_BODY", message: "Corpo da requisição inválido." }, 400);
  }

  const action = body.action;
  if (!isValidTinyIntegrationAction(action)) return jsonResponse({ success: false, code: "INVALID_ACTION", message: "Ação inválida." }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

  async function hasPermission(key: string): Promise<boolean> {
    if (caller.role === "super_admin") return true;
    const { data, error } = await callerClient.rpc("has_permission", { perm_key: key });
    if (error) {
      console.error("[tiny-integration] falha ao checar has_permission:", error.message);
      return false;
    }
    return data === true;
  }

  /**
   * O Tiny não faz parte do recurso de múltiplas lojas por marketplace
   * (pedido explícito: "não presumir que o Tiny precisa de 4 conexões
   * nesta etapa") — continua com exatamente 1 conexão real por empresa. Mas
   * como integration_providers agora permite, estruturalmente, mais de uma
   * linha por (company_id, provider) [migration 0052], troca .maybeSingle()
   * (que quebraria se alguma dia existisse mais de uma) por "a conexão ativa
   * mais antiga" — resultado idêntico hoje (só existe 1), e seguro mesmo se
   * isso mudar no futuro.
   */
  async function loadCredentials(): Promise<{ providerId: string; credentials: TinyCredentials } | null> {
    const { data: providerRows } = await admin
      .from("integration_providers")
      .select("id")
      .eq("company_id", caller.company_id)
      .eq("provider", "tiny")
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1);
    const providerRow = providerRows?.[0];
    if (!providerRow) return null;
    const { data: credRow } = await admin
      .from("integration_credentials")
      .select("id, access_token, refresh_token, client_id, client_secret, expires_at")
      .eq("provider_id", providerRow.id)
      .maybeSingle();
    if (!credRow) return null;
    return { providerId: providerRow.id as string, credentials: credRow as TinyCredentials };
  }

  /** Refresh proativo (buffer de 10min antes de expirar de verdade) — nunca deixa o token vencer no meio de um lote com vários itens. */
  async function ensureFreshAccessToken(providerId: string, credentials: TinyCredentials): Promise<{ accessToken: string } | { error: string }> {
    if (!credentials.access_token) return { error: "Nenhum token de acesso salvo. Configure a integração em Administração > Integrações." };
    if (!isAccessTokenExpired(credentials.expires_at, Date.now())) return { accessToken: credentials.access_token };

    if (!credentials.refresh_token || !credentials.client_id || !credentials.client_secret) {
      return { error: "Token de acesso expirado e sem dados suficientes pra renovar automaticamente (client_id/client_secret/refresh_token). Reconecte manualmente." };
    }

    const refreshBody = buildTokenRefreshBody({ clientId: credentials.client_id, clientSecret: credentials.client_secret, refreshToken: credentials.refresh_token });
    let res: Response;
    try {
      res = await fetch(TINY_OAUTH_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: refreshBody });
    } catch (err) {
      return { error: "Falha de rede ao tentar renovar a conexão com o Tiny: " + (err instanceof Error ? err.message : String(err)) };
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return { error: "Não foi possível renovar a conexão com o Tiny — o refresh_token pode ter expirado (validade de 24h). Reconecte manualmente em Administração > Integrações." };
    }
    const newAccessToken = json?.access_token as string | undefined;
    if (!newAccessToken) return { error: "O Tiny não devolveu um novo token de acesso ao renovar." };
    const newRefreshToken = (json?.refresh_token as string | undefined) ?? credentials.refresh_token;
    const expiresInSec = typeof json?.expires_in === "number" ? json.expires_in : 4 * 3600;
    const newExpiresAt = new Date(Date.now() + expiresInSec * 1000).toISOString();

    const { error: updateError } = await admin
      .from("integration_credentials")
      .update({ access_token: newAccessToken, refresh_token: newRefreshToken, expires_at: newExpiresAt })
      .eq("provider_id", providerId);
    if (updateError) console.error("[tiny-integration] falha ao persistir token renovado:", updateError.message);

    return { accessToken: newAccessToken };
  }

  async function tinyFetch(accessToken: string, path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${TINY_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    });
    let responseBody: unknown = null;
    try {
      responseBody = await res.json();
    } catch {
      // corpo vazio (ex.: 204) — segue sem quebrar.
    }
    if (!res.ok) throw new Error(describeTinyError(res.status, responseBody));
    return responseBody;
  }

  async function resolveTinyProductId(accessToken: string, skuCode: string | null, ean: string | null): Promise<string> {
    const params = buildProdutoLookupParams(skuCode, ean);
    if (Object.keys(params).length === 0) throw new Error("Produto sem SKU ou EAN válido pra localizar no Tiny.");
    const query = new URLSearchParams(params).toString();
    const result = (await tinyFetch(accessToken, `/produtos?${query}`)) as { itens?: { id: number }[] };
    const found = result?.itens?.[0];
    if (!found) throw new Error("Produto não encontrado no Tiny (SKU/EAN sem correspondência).");
    return String(found.id);
  }

  /**
   * Reivindica atomicamente a linha de idempotência (insert puro; conflito
   * de chave única == alguém já tentou este item+depósito antes). Retry só
   * acontece pra linhas marcadas 'failed' — uma linha 'success' nunca é
   * reprocessada (ver migration 0051).
   */
  async function claimLedgerRow(params: {
    idempotencyKey: string;
    sourceType: TinyLaunchSourceType;
    sourceId: string;
    productVariantId: string | null;
    quantity: number;
    unitPrice: number;
    depositoId: string;
  }): Promise<{ claimed: true; rowId: string } | { claimed: false; existingStatus: string; externalMovementId: string | null }> {
    const { data: inserted, error: insertError } = await admin
      .from("tiny_stock_launches")
      .insert({
        company_id: caller.company_id,
        idempotency_key: params.idempotencyKey,
        source_type: params.sourceType,
        source_id: params.sourceId,
        product_variant_id: params.productVariantId,
        quantity: params.quantity,
        unit_price: params.unitPrice,
        tiny_deposito_id: params.depositoId,
        status: "pending",
        requested_by: caller.id,
      })
      .select("id")
      .single();

    if (!insertError) return { claimed: true, rowId: inserted!.id as string };
    if (insertError.code !== "23505") throw insertError;

    const { data: existing } = await admin
      .from("tiny_stock_launches")
      .select("id, status, external_movement_id")
      .eq("idempotency_key", params.idempotencyKey)
      .maybeSingle();
    if (!existing) throw insertError;
    if (existing.status === "failed") {
      await admin.from("tiny_stock_launches").update({ status: "pending", error_message: null }).eq("id", existing.id);
      return { claimed: true, rowId: existing.id as string };
    }
    return { claimed: false, existingStatus: existing.status as string, externalMovementId: existing.external_movement_id as string | null };
  }

  try {
    switch (action) {
      // -----------------------------------------------------------------
      case "test_connection": {
        if (!(await hasPermission("integrations.manage")))
          return jsonResponse({ success: false, code: "FORBIDDEN", message: "Você não tem permissão para gerenciar credenciais de integrações." }, 403);

        const loaded = await loadCredentials();
        if (!loaded) return jsonResponse({ success: false, code: "NOT_CONFIGURED", message: "Nenhuma credencial do Tiny foi salva ainda." }, 400);

        const tokenResult = await ensureFreshAccessToken(loaded.providerId, loaded.credentials);
        if ("error" in tokenResult) {
          await admin.from("integration_providers").update({ status: "auth_error", last_error: tokenResult.error }).eq("id", loaded.providerId);
          return jsonResponse({ success: false, code: "AUTH_ERROR", message: tokenResult.error });
        }

        try {
          const info = await tinyFetch(tokenResult.accessToken, "/info");
          await admin.from("integration_providers").update({ status: "connected", last_error: null, last_sync_at: new Date().toISOString() }).eq("id", loaded.providerId);
          return jsonResponse({ success: true, connected: true, account: info });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await admin.from("integration_providers").update({ status: "auth_error", last_error: message }).eq("id", loaded.providerId);
          return jsonResponse({ success: false, code: "CONNECTION_FAILED", message });
        }
      }

      // -----------------------------------------------------------------
      case "list_warehouses": {
        const loaded = await loadCredentials();
        if (!loaded) return jsonResponse({ success: false, code: "NOT_CONFIGURED", message: "Nenhuma credencial do Tiny foi salva ainda." }, 400);

        const tokenResult = await ensureFreshAccessToken(loaded.providerId, loaded.credentials);
        if ("error" in tokenResult) return jsonResponse({ success: false, code: "AUTH_ERROR", message: tokenResult.error });

        try {
          const result = (await tinyFetch(tokenResult.accessToken, "/depositos")) as { id: number; descricao: string }[] | { itens?: { id: number; descricao: string }[] };
          const warehouses = Array.isArray(result) ? result : result?.itens ?? [];
          return jsonResponse({ success: true, warehouses: warehouses.map((w) => ({ id: String(w.id), name: w.descricao })) });
        } catch (err) {
          return jsonResponse({ success: false, code: "CONNECTION_FAILED", message: err instanceof Error ? err.message : String(err) });
        }
      }

      // -----------------------------------------------------------------
      case "launch_return_batch": {
        const batchId = body.batchId;
        const warehouseId = body.warehouseId;
        const warehouseName = typeof body.warehouseName === "string" ? body.warehouseName.trim() : "";
        const unitPriceOverride = typeof body.unitPrice === "number" ? body.unitPrice : null;
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (typeof batchId !== "string" || !batchId) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Lote inválido." }, 400);
        if (typeof warehouseId !== "string" || !warehouseId || !warehouseName)
          return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Selecione um depósito." }, 400);

        const { data: batchRow } = await admin.from("return_batches").select("id, status, company_id").eq("id", batchId).maybeSingle();
        if (!batchRow) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Lote não encontrado." }, 404);
        if (batchRow.company_id !== caller.company_id) return jsonResponse({ success: false, code: "FORBIDDEN", message: "Acesso negado a este lote." }, 403);
        if (batchRow.status === "concluida") return jsonResponse({ success: false, code: "ALREADY_DONE", message: "Este lote já foi concluído." }, 400);

        const loaded = await loadCredentials();
        if (!loaded) return jsonResponse({ success: false, code: "NOT_CONFIGURED", message: "Integração com o Tiny não configurada — use a confirmação manual." }, 400);

        const tokenResult = await ensureFreshAccessToken(loaded.providerId, loaded.credentials);
        if ("error" in tokenResult) return jsonResponse({ success: false, code: "AUTH_ERROR", message: tokenResult.error });
        const accessToken = tokenResult.accessToken;

        const { data: items } = await admin
          .from("return_batch_items")
          .select("id, product_variant_id, total_quantity, product_variants(sku_code, gtin)")
          .eq("batch_id", batchId);
        const rows = (items as { id: string; product_variant_id: string; total_quantity: number; product_variants: { sku_code: string; gtin: string | null } | null }[]) || [];

        const results: LaunchItemResult[] = [];
        for (const item of rows) {
          const idempotencyKey = buildTinyLaunchIdempotencyKey("return_batch_item", item.id, warehouseId);
          const claim = await claimLedgerRow({
            idempotencyKey,
            sourceType: "return_batch_item",
            sourceId: item.id,
            productVariantId: item.product_variant_id,
            quantity: item.total_quantity,
            unitPrice: unitPriceOverride ?? 0,
            depositoId: warehouseId,
          });
          if (!claim.claimed) {
            if (claim.existingStatus === "success") {
              results.push({ sourceId: item.id, status: "skipped_already_done", externalMovementId: claim.externalMovementId ?? undefined });
            } else {
              results.push({ sourceId: item.id, status: "failed", error: "Lançamento em andamento por outra requisição." });
            }
            continue;
          }
          try {
            const tinyProductId = await resolveTinyProductId(accessToken, item.product_variants?.sku_code ?? null, item.product_variants?.gtin ?? null);
            const movementBody = buildStockMovementBody({
              tipo: "E",
              quantidade: item.total_quantity,
              precoUnitario: unitPriceOverride ?? 0,
              depositoId: warehouseId,
              observacoes: `GoScan - Devolução, lote ${batchId}`,
            });
            const movementResult = (await tinyFetch(accessToken, `/estoque/${tinyProductId}`, { method: "POST", body: JSON.stringify(movementBody) })) as { idLancamento?: number };
            const externalMovementId = movementResult?.idLancamento != null ? String(movementResult.idLancamento) : null;
            await admin
              .from("tiny_stock_launches")
              .update({ status: "success", tiny_product_id: tinyProductId, external_movement_id: externalMovementId, completed_at: new Date().toISOString() })
              .eq("idempotency_key", idempotencyKey);
            results.push({ sourceId: item.id, status: "success", externalMovementId: externalMovementId ?? undefined });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await admin.from("tiny_stock_launches").update({ status: "failed", error_message: message, completed_at: new Date().toISOString() }).eq("idempotency_key", idempotencyKey);
            results.push({ sourceId: item.id, status: "failed", error: message });
          }
        }

        const summary = summarizeLaunchResults(results);
        if (summary.allSucceeded) {
          const { error: confirmError } = await callerClient.rpc("confirm_return_batch_tiny_launch", {
            p_batch_id: batchId,
            p_warehouse: warehouseName,
            p_launched_at: new Date().toISOString(),
            p_note: note || `Lançado automaticamente via integração Tiny (${summary.succeeded} item(ns)).`,
          });
          if (confirmError) return jsonResponse({ success: false, code: "CONFIRM_FAILED", message: confirmError.message, summary, results });
        } else if (summary.succeeded > 0 || summary.alreadyDone > 0) {
          await admin.from("return_batches").update({ status: "lancada_tiny" }).eq("id", batchId);
        }

        return jsonResponse({ success: true, summary, results });
      }

      // -----------------------------------------------------------------
      case "launch_invoice_receipt": {
        const receiptId = body.receiptId;
        const warehouseId = body.warehouseId;
        const warehouseName = typeof body.warehouseName === "string" ? body.warehouseName.trim() : "";
        const unitPriceOverride = typeof body.unitPrice === "number" ? body.unitPrice : null;
        const note = typeof body.note === "string" ? body.note.trim() : "";
        if (typeof receiptId !== "string" || !receiptId) return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Nota fiscal inválida." }, 400);
        if (typeof warehouseId !== "string" || !warehouseId || !warehouseName)
          return jsonResponse({ success: false, code: "VALIDATION_ERROR", message: "Selecione um depósito." }, 400);

        const { data: receiptRow } = await admin.from("invoice_receipts").select("id, status, tiny_launch_status, company_id").eq("id", receiptId).maybeSingle();
        if (!receiptRow) return jsonResponse({ success: false, code: "NOT_FOUND", message: "Nota fiscal não encontrada." }, 404);
        if (receiptRow.company_id !== caller.company_id) return jsonResponse({ success: false, code: "FORBIDDEN", message: "Acesso negado a esta nota fiscal." }, 403);
        if (!["completed", "with_divergences"].includes(receiptRow.status))
          return jsonResponse({ success: false, code: "NOT_FINALIZED", message: "A conferência precisa estar finalizada antes de lançar no Tiny." }, 400);
        if (receiptRow.tiny_launch_status === "lancado") return jsonResponse({ success: false, code: "ALREADY_DONE", message: "Esta nota já foi lançada no Tiny." }, 400);

        const loaded = await loadCredentials();
        if (!loaded) return jsonResponse({ success: false, code: "NOT_CONFIGURED", message: "Integração com o Tiny não configurada — use a confirmação manual." }, 400);

        const tokenResult = await ensureFreshAccessToken(loaded.providerId, loaded.credentials);
        if ("error" in tokenResult) return jsonResponse({ success: false, code: "AUTH_ERROR", message: tokenResult.error });
        const accessToken = tokenResult.accessToken;

        const { data: items } = await admin
          .from("invoice_receipt_items")
          .select("id, product_variant_id, physical_quantity, unit_value, product_variants(sku_code, gtin)")
          .eq("receipt_id", receiptId)
          .in("status", ["ok", "surplus"])
          .not("product_variant_id", "is", null)
          .gt("physical_quantity", 0);
        const rows =
          (items as {
            id: string;
            product_variant_id: string;
            physical_quantity: number;
            unit_value: number | null;
            product_variants: { sku_code: string; gtin: string | null } | null;
          }[]) || [];

        if (rows.length === 0) return jsonResponse({ success: false, code: "NOTHING_TO_LAUNCH", message: "Nenhum item fisicamente confirmado (OK/sobra) com produto vinculado pra lançar." }, 400);

        const results: LaunchItemResult[] = [];
        for (const item of rows) {
          const idempotencyKey = buildTinyLaunchIdempotencyKey("invoice_receipt_item", item.id, warehouseId);
          const claim = await claimLedgerRow({
            idempotencyKey,
            sourceType: "invoice_receipt_item",
            sourceId: item.id,
            productVariantId: item.product_variant_id,
            quantity: item.physical_quantity,
            unitPrice: unitPriceOverride ?? item.unit_value ?? 0,
            depositoId: warehouseId,
          });
          if (!claim.claimed) {
            if (claim.existingStatus === "success") {
              results.push({ sourceId: item.id, status: "skipped_already_done", externalMovementId: claim.externalMovementId ?? undefined });
            } else {
              results.push({ sourceId: item.id, status: "failed", error: "Lançamento em andamento por outra requisição." });
            }
            continue;
          }
          try {
            const tinyProductId = await resolveTinyProductId(accessToken, item.product_variants?.sku_code ?? null, item.product_variants?.gtin ?? null);
            const movementBody = buildStockMovementBody({
              tipo: "E",
              quantidade: item.physical_quantity,
              precoUnitario: unitPriceOverride ?? item.unit_value ?? 0,
              depositoId: warehouseId,
              observacoes: `GoScan - Conferência NF ${receiptId}`,
            });
            const movementResult = (await tinyFetch(accessToken, `/estoque/${tinyProductId}`, { method: "POST", body: JSON.stringify(movementBody) })) as { idLancamento?: number };
            const externalMovementId = movementResult?.idLancamento != null ? String(movementResult.idLancamento) : null;
            await admin
              .from("tiny_stock_launches")
              .update({ status: "success", tiny_product_id: tinyProductId, external_movement_id: externalMovementId, completed_at: new Date().toISOString() })
              .eq("idempotency_key", idempotencyKey);
            results.push({ sourceId: item.id, status: "success", externalMovementId: externalMovementId ?? undefined });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await admin.from("tiny_stock_launches").update({ status: "failed", error_message: message, completed_at: new Date().toISOString() }).eq("idempotency_key", idempotencyKey);
            results.push({ sourceId: item.id, status: "failed", error: message });
          }
        }

        const summary = summarizeLaunchResults(results);
        if (summary.allSucceeded) {
          const { error: confirmError } = await callerClient.rpc("confirm_invoice_receipt_tiny_launch", {
            p_receipt_id: receiptId,
            p_warehouse: warehouseName,
            p_launched_at: new Date().toISOString(),
            p_note: note || `Lançado automaticamente via integração Tiny (${summary.succeeded} item(ns)).`,
          });
          if (confirmError) return jsonResponse({ success: false, code: "CONFIRM_FAILED", message: confirmError.message, summary, results });
        } else if (summary.succeeded > 0 || summary.alreadyDone > 0) {
          await admin.from("invoice_receipts").update({ tiny_launch_status: "parcial" }).eq("id", receiptId);
        }

        return jsonResponse({ success: true, summary, results });
      }

      default: {
        const _exhaustive: never = action;
        return jsonResponse({ success: false, code: "INVALID_ACTION", message: "Ação inválida.", _exhaustive }, 400);
      }
    }
  } catch (err) {
    console.error("[tiny-integration] erro inesperado:", err instanceof Error ? err.message : String(err));
    return jsonResponse({ success: false, code: "INTERNAL_ERROR", message: "Não foi possível concluir a operação. Tente novamente." }, 500);
  }
});
