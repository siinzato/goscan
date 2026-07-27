// EXPANSÃO GOSCAN — Consulta automática de NF-e pela chave de acesso (API
// Meu Danfe v2). Esta é a ÚNICA peça do fluxo que fala com api.meudanfe.com.br
// — o navegador nunca acessa a API do Meu Danfe diretamente, e a API key
// (MEUDANFE_API_KEY) só existe aqui, lida via Deno.env.get.
//
// Contrato com o frontend (ver src/client/nfeKeyLookup.ts — deve ser mantido
// em sincronia manualmente, já que este arquivo roda em Deno e não pode ser
// importado pelo bundle Vite):
//   sucesso/andamento: { success: true, status, accessKey, attempt?, message?, xml?, documentType?, fileName? }
//   erro:              { success: false, code, message }
//
// Depois que devolve o XML (status "OK"), a responsabilidade termina aqui —
// quem processa o XML, cria a conferência e decide se já foi importada é o
// MESMO caminho já usado pelo upload manual (ver processXmlText em
// src/client/ui/screens/nfeConference.ts), nunca uma lógica duplicada.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, handleCorsPreflight } from "../_shared/cors.ts";
import {
  sanitizeAccessKey,
  describeUpstreamHttpError,
  describeUpstreamException,
  normalizeBusinessStatus,
  lookupRowToResponse,
  MEUDANFE_BASE_URL,
  UPSTREAM_TIMEOUT_MS,
  MIN_POLL_INTERVAL_MS,
  type LookupRow,
} from "./logic.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCorsPreflight();
  if (req.method !== "POST") {
    return jsonResponse({ success: false, code: "METHOD_NOT_ALLOWED", message: "Método não permitido." }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const MEUDANFE_API_KEY = Deno.env.get("MEUDANFE_API_KEY");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[consultar-nfe-meudanfe] variáveis do Supabase ausentes no ambiente da função (SUPABASE_URL/ANON_KEY/SERVICE_ROLE_KEY).");
    return jsonResponse({ success: false, code: "CONFIG_ERROR", message: "Integração com NF-e não configurada. Procure um administrador." }, 500);
  }

  // 1) Autenticação — Bearer do cliente Supabase, validado antes de qualquer
  // outra coisa. Cliente com a chave anon + o JWT do chamador: respeita RLS
  // (profiles_select já libera a própria linha), nunca eleva privilégio
  // nesta etapa.
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ success: false, code: "UNAUTHENTICATED", message: "Sessão inválida. Faça login novamente." }, 401);
  }

  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ success: false, code: "UNAUTHENTICATED", message: "Sessão inválida ou expirada. Faça login novamente." }, 401);
  }

  // 2) Autorização — mesma barreira real já usada por invoice_receipts_insert
  // (is_active_user()): qualquer usuário ativo pode importar NF-e. Nunca
  // confia em role/user_id enviados pelo corpo da requisição — tudo aqui vem
  // do banco, a partir do usuário validado acima.
  const { data: profile, error: profileError } = await callerClient.from("profiles").select("id, active").eq("id", userData.user.id).maybeSingle();
  if (profileError || !profile) {
    return jsonResponse({ success: false, code: "FORBIDDEN", message: "Perfil não encontrado." }, 403);
  }
  if (!profile.active) {
    return jsonResponse({ success: false, code: "FORBIDDEN", message: "Usuário inativo." }, 403);
  }
  const callerId = profile.id as string;

  if (!MEUDANFE_API_KEY) {
    console.error("[consultar-nfe-meudanfe] MEUDANFE_API_KEY ausente nos secrets da função.");
    return jsonResponse({ success: false, code: "CONFIG_ERROR", message: "Integração com NF-e não configurada. Procure um administrador." }, 500);
  }

  let body: { accessKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ success: false, code: "INVALID_BODY", message: "Corpo da requisição inválido." }, 400);
  }

  const accessKey = sanitizeAccessKey(body?.accessKey);
  if (!accessKey) {
    return jsonResponse({ success: false, code: "NFE_INVALID_KEY", message: "Chave de acesso inválida. Confira os 44 dígitos." }, 400);
  }

  // 3) Daqui em diante, service_role — só depois do usuário validado acima,
  // e só para as duas operações que realmente precisam (dedup/controle de
  // polling e auditoria), nunca para expor dados fora do que esta função
  // já decidiu devolver.
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  async function writeAudit(action: string, metadata: Record<string, unknown>, lookupId: string | null): Promise<void> {
    const { error } = await admin.from("audit_logs").insert({
      user_id: callerId,
      action,
      entity_type: "nfe_lookup",
      entity_id: lookupId,
      metadata,
    });
    if (error) console.error("[consultar-nfe-meudanfe] falha ao gravar audit_logs:", error.message);
  }

  // 4) Já importada? Checagem ampla (service_role, só metadados mínimos) —
  // evita bater na API externa à toa e evita duplicar quando OUTRO operador
  // já importou a mesma nota (a RLS normal de invoice_receipts esconderia
  // isso de quem não é o criador nem manager/admin).
  const { data: existingReceipt } = await admin.from("invoice_receipts").select("id").eq("invoice_key", accessKey).maybeSingle();

  if (existingReceipt) {
    await writeAudit("nfe_lookup_already_imported", { access_key: accessKey, source: "local" }, null);
    console.log(`[consultar-nfe-meudanfe] user=${callerId} access_key=${accessKey} already_imported`);
    return jsonResponse({ success: true, status: "ALREADY_IMPORTED", accessKey, message: "Esta NF-e já foi importada." });
  }

  // 5) Dedup/controle — uma linha por chave (nunca por usuário): evita duas
  // pessoas dispararem consultas concorrentes da MESMA nota, e aplica o
  // intervalo mínimo de 1s documentado pelo Meu Danfe como risco real de
  // bloqueio de conta/IP — não só uma convenção do polling no cliente.
  const { data: existingLookup } = await admin.from("nfe_lookup_requests").select("*").eq("access_key", accessKey).maybeSingle();

  if (existingLookup?.last_polled_at) {
    const elapsed = Date.now() - new Date(existingLookup.last_polled_at as string).getTime();
    if (elapsed < MIN_POLL_INTERVAL_MS) {
      const cached = lookupRowToResponse(existingLookup as LookupRow, accessKey);
      return jsonResponse(cached.body, cached.httpStatus);
    }
  }

  const lookupId = (existingLookup?.id as string | undefined) ?? crypto.randomUUID();
  const attemptCount = ((existingLookup?.attempt_count as number | undefined) ?? 0) + 1;

  async function saveLookup(patch: Record<string, unknown>): Promise<void> {
    const { error } = await admin.from("nfe_lookup_requests").upsert(
      {
        id: lookupId,
        access_key: accessKey,
        requested_by: callerId,
        attempt_count: attemptCount,
        last_polled_at: new Date().toISOString(),
        ...patch,
      },
      { onConflict: "access_key" }
    );
    if (error) console.error("[consultar-nfe-meudanfe] falha ao gravar nfe_lookup_requests:", error.message);
  }

  // 6) PUT — solicita/consulta status (mesma chamada serve pros dois casos,
  // conforme a documentação oficial do Meu Danfe).
  let putJson: { status?: unknown } | null = null;
  try {
    const putResp = await fetch(`${MEUDANFE_BASE_URL}/fd/add/${accessKey}`, {
      method: "PUT",
      headers: { "Api-Key": MEUDANFE_API_KEY },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!putResp.ok) {
      const sanitized = describeUpstreamHttpError(putResp.status);
      await saveLookup({ status: "error", sanitized_error: sanitized.message });
      await writeAudit("nfe_lookup_error", { access_key: accessKey, attempt_count: attemptCount, source: "api", sanitized_error: sanitized.message }, lookupId);
      return jsonResponse({ success: false, code: sanitized.code, message: sanitized.message }, sanitized.httpStatus);
    }
    try {
      putJson = await putResp.json();
    } catch {
      await saveLookup({ status: "error", sanitized_error: "Resposta inválida do serviço de consulta." });
      return jsonResponse({ success: false, code: "NFE_QUERY_ERROR", message: "Resposta inválida do serviço de consulta." }, 502);
    }
  } catch (err) {
    console.error(`[consultar-nfe-meudanfe] falha de rede/timeout no PUT (access_key=${accessKey}):`, err instanceof Error ? err.message : String(err));
    const sanitized = describeUpstreamException(err);
    await saveLookup({ status: "error", sanitized_error: sanitized.message });
    await writeAudit("nfe_lookup_error", { access_key: accessKey, attempt_count: attemptCount, source: "api", sanitized_error: sanitized.message }, lookupId);
    return jsonResponse({ success: false, code: sanitized.code, message: sanitized.message }, sanitized.httpStatus);
  }

  const upstreamStatus = normalizeBusinessStatus(putJson?.status);

  if (upstreamStatus === "WAITING" || upstreamStatus === "SEARCHING") {
    await saveLookup({ status: upstreamStatus.toLowerCase(), sanitized_error: null });
    return jsonResponse({
      success: true,
      status: upstreamStatus,
      accessKey,
      attempt: attemptCount,
      message: upstreamStatus === "WAITING" ? "NF-e aguardando consulta." : "Consulta em andamento.",
    });
  }

  if (upstreamStatus === "NOT_FOUND") {
    await saveLookup({ status: "not_found", sanitized_error: null });
    await writeAudit("nfe_lookup_not_found", { access_key: accessKey, attempt_count: attemptCount, source: "api" }, lookupId);
    return jsonResponse({ success: false, code: "NFE_NOT_FOUND", message: "NF-e não encontrada. Confira a chave de acesso ou envie o XML manualmente." }, 404);
  }

  if (upstreamStatus !== "OK") {
    // "ERROR" ou qualquer status não reconhecido — mesmo tratamento (fail safe).
    await saveLookup({ status: "error", sanitized_error: "Não foi possível consultar esta NF-e." });
    await writeAudit(
      "nfe_lookup_error",
      { access_key: accessKey, attempt_count: attemptCount, source: "api", sanitized_error: `status_meudanfe:${upstreamStatus || "vazio"}` },
      lookupId
    );
    return jsonResponse({ success: false, code: "NFE_QUERY_ERROR", message: "Não foi possível consultar esta NF-e. Você ainda pode importar o XML manualmente." }, 502);
  }

  // 7) OK — baixa o XML nesta mesma requisição (nunca exposto direto ao navegador).
  try {
    const getResp = await fetch(`${MEUDANFE_BASE_URL}/fd/get/xml/${accessKey}`, {
      method: "GET",
      headers: { "Api-Key": MEUDANFE_API_KEY },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (getResp.status === 404) {
      // Corrida real documentada: status vira OK antes do XML estar
      // efetivamente disponível pra download — trata como "ainda buscando",
      // nunca como erro definitivo.
      await saveLookup({ status: "searching", sanitized_error: null });
      return jsonResponse({
        success: true,
        status: "SEARCHING",
        accessKey,
        attempt: attemptCount,
        message: "O XML ainda não está disponível. Aguarde alguns segundos e tente novamente.",
      });
    }
    if (!getResp.ok) {
      const sanitized = describeUpstreamHttpError(getResp.status);
      await saveLookup({ status: "error", sanitized_error: sanitized.message });
      await writeAudit("nfe_lookup_error", { access_key: accessKey, attempt_count: attemptCount, source: "api", sanitized_error: sanitized.message }, lookupId);
      return jsonResponse({ success: false, code: sanitized.code, message: sanitized.message }, sanitized.httpStatus);
    }

    let getJson: { name?: unknown; type?: unknown; format?: unknown; data?: unknown };
    try {
      getJson = await getResp.json();
    } catch {
      await saveLookup({ status: "error", sanitized_error: "Resposta inválida ao baixar o XML." });
      return jsonResponse({ success: false, code: "NFE_QUERY_ERROR", message: "Resposta inválida do serviço de consulta." }, 502);
    }

    if (getJson.format !== "XML" || typeof getJson.data !== "string" || !getJson.data.trim()) {
      await saveLookup({ status: "error", sanitized_error: "XML ausente na resposta do serviço." });
      await writeAudit("nfe_lookup_error", { access_key: accessKey, attempt_count: attemptCount, source: "api", sanitized_error: "xml_ausente_na_resposta" }, lookupId);
      return jsonResponse(
        { success: false, code: "NFE_QUERY_ERROR", message: "Não foi possível obter o XML desta NF-e. Você ainda pode importar o XML manualmente." },
        502
      );
    }

    await saveLookup({ status: "ok", sanitized_error: null });
    // Nunca loga o XML completo nem headers de autenticação — só metadados operacionais.
    await writeAudit("nfe_lookup_ok", { access_key: accessKey, attempt_count: attemptCount, source: "api" }, lookupId);
    console.log(`[consultar-nfe-meudanfe] user=${callerId} access_key=${accessKey} status=OK attempts=${attemptCount}`);

    return jsonResponse({
      success: true,
      status: "OK",
      accessKey,
      documentType: typeof getJson.type === "string" ? getJson.type : "NFE",
      fileName: typeof getJson.name === "string" ? getJson.name : null,
      xml: getJson.data,
    });
  } catch (err) {
    console.error(`[consultar-nfe-meudanfe] falha de rede/timeout no GET do XML (access_key=${accessKey}):`, err instanceof Error ? err.message : String(err));
    const sanitized = describeUpstreamException(err);
    await saveLookup({ status: "error", sanitized_error: sanitized.message });
    await writeAudit("nfe_lookup_error", { access_key: accessKey, attempt_count: attemptCount, source: "api", sanitized_error: sanitized.message }, lookupId);
    return jsonResponse({ success: false, code: sanitized.code, message: sanitized.message }, sanitized.httpStatus);
  }
});
