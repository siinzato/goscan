// Backend mínimo: mantém no servidor o que não pode ir ao navegador —
// Claude Vision (ANTHROPIC_API_KEY) e, a partir do Catálogo Visual, o
// download SSRF-safe de imagens externas + escrita privilegiada no Storage
// (SUPABASE_SERVICE_ROLE_KEY). Catálogo, aliases, conferências e
// autenticação continuam Supabase direto do frontend (via RLS).
import { MODEL_ALIASES } from "./aliases-seed.ts";
import { getSupabaseAdmin, requireManagerOrAdmin, requireActiveUser, type AdminEnv } from "./supabaseAdmin.ts";
import { processImportBatch, resetErrorItems } from "./catalogImages.ts";
import { processEmbeddingBatch, processEmbeddingsForVariant, getEmbeddingStatusSummary, resetErrorEmbeddings, findSimilarImages } from "./visualEmbeddings.ts";
import { generateImageEmbedding } from "./embeddingPipeline.ts";
import { processAndNormalizeImage } from "./imagePipeline.ts";
import { validateScanFrame, InvalidFrameError } from "./scanFrameValidator.ts";
import { recognizeFrame, logRecognitionPerformance } from "./scanRecognize.ts";
import { recordLearningSample, listLearningSamples, updateLearningSampleStatus, assessFrameQuality, getLibrarySummary, reportUnclassifiedProduct } from "./visualLearning.ts";
import { recalculateRecognitionQuality, getRecognitionQualityForVariants, listRecognitionQuality } from "./recognitionQuality.ts";
import { isRateLimited } from "./scanRateLimiter.ts";
import { SCAN_CONFIG } from "./scanConfig.ts";

interface Env extends AdminEnv {
  ANTHROPIC_API_KEY?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function callClaudeVision(env: Env, images: { data: string; media_type: string }[]) {
  if (!env.ANTHROPIC_API_KEY) {
    return {
      error:
        "ANTHROPIC_API_KEY não configurada. Peça para o administrador cadastrar a chave da API Anthropic (console.anthropic.com) nas variáveis de ambiente do servidor.",
    };
  }

  const modelListText = Object.keys(MODEL_ALIASES).join(", ");

  const systemPrompt = `Você está lendo prints de uma conversa de WhatsApp onde um funcionário de estoque conferiu produtos manualmente. Cada mensagem/balão pode conter um ou mais produtos, cores e quantidades, em formatos variados como:
"Tote pop micro\\n4 marrom\\n1 off WHITE\\n1 preta" (um modelo, várias cores)
"Tote Mini preto 1uni" (modelo cor quantidade na mesma linha)
"Puffer marrom 3 uni" (as vezes o modelo aparece abreviado)
"Necessarie Puffer M\\nRosa 2 uni\\nPreta 2 uni" (um modelo, várias cores, várias linhas)

Quando não houver número de quantidade explícito, assuma 1 unidade.
Alguns nomes de modelo conhecidos (apelidos que os funcionários usam) incluem: ${modelListText}.

Extraia TODOS os itens de TODAS as imagens fornecidas e retorne SOMENTE um JSON válido (sem markdown, sem texto antes ou depois), no formato:
{"items": [{"modelo": "texto exato como escrito", "cor": "texto exato como escrito", "quantidade": numero}]}`;

  const content: unknown[] = images.map((img) => ({
    type: "image",
    source: { type: "base64", media_type: img.media_type, data: img.data },
  }));
  content.push({
    type: "text",
    text: "Extraia os itens dessas imagens seguindo as instruções do sistema.",
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4000,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Erro na API Anthropic (${resp.status}): ${text}` };
  }

  const data = (await resp.json()) as { content?: { type: string; text?: string }[] };
  const textBlock = (data.content || []).find((c) => c.type === "text");
  if (!textBlock || !textBlock.text) return { error: "Resposta da IA sem conteúdo de texto." };

  let cleaned = textBlock.text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(cleaned);
    return { items: parsed.items || [] };
  } catch {
    return { error: "Não foi possível interpretar a resposta da IA como JSON." };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/status" && request.method === "GET") {
        return json({
          has_anthropic_key: !!env.ANTHROPIC_API_KEY,
          has_catalog_images_backend: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
        });
      }

      if (path === "/api/parse-images" && request.method === "POST") {
        const body = (await request.json()) as { images?: { data: string; media_type: string }[] };
        const result = await callClaudeVision(env, body.images || []);
        return json(result);
      }

      if (path === "/api/catalog-images/process-batch" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = (await request.json()) as { import_id?: string; limit?: number };
        if (!body.import_id) return json({ error: "import_id é obrigatório." }, 400);
        const admin = getSupabaseAdmin(env);
        const result = await processImportBatch(admin, body.import_id, Math.min(Math.max(body.limit || 5, 1), 20));
        return json(result);
      }

      if (path === "/api/catalog-images/reset-errors" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = (await request.json()) as { import_id?: string };
        if (!body.import_id) return json({ error: "import_id é obrigatório." }, 400);
        const admin = getSupabaseAdmin(env);
        const reset = await resetErrorItems(admin, body.import_id);
        return json({ reset });
      }

      // --- Modo Scan (Parte 2): preparação da base visual (embeddings) ---
      // Rotas administrativas — sempre atrás de requireManagerOrAdmin, sempre
      // com service_role só aqui no backend. Nunca logamos o vetor completo.
      if (path === "/api/visual-embeddings/status" && request.method === "GET") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const admin = getSupabaseAdmin(env);
        const summary = await getEmbeddingStatusSummary(admin);
        return json(summary);
      }

      if (path === "/api/visual-embeddings/process-batch" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = (await request.json().catch(() => ({}))) as { limit?: number };
        const admin = getSupabaseAdmin(env);
        const result = await processEmbeddingBatch(admin, Math.min(Math.max(body.limit || 5, 1), 20));
        return json(result);
      }

      if (path === "/api/visual-embeddings/process-variant" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = (await request.json().catch(() => ({}))) as { variant_id?: string };
        if (!body.variant_id) return json({ error: "variant_id é obrigatório." }, 400);
        const admin = getSupabaseAdmin(env);
        const result = await processEmbeddingsForVariant(admin, body.variant_id);
        return json(result);
      }

      if (path === "/api/visual-embeddings/reset-errors" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const admin = getSupabaseAdmin(env);
        const reset = await resetErrorEmbeddings(admin);
        return json({ reset });
      }

      if (path === "/api/visual-embeddings/test-query" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        const body = (await request.json()) as { image_base64?: string; media_type?: string; product_image_id?: string; limit?: number };
        const admin = getSupabaseAdmin(env);
        const limit = Math.min(Math.max(body.limit || 5, 1), 10);

        let queryVector: number[];
        let querySource: string;
        if (body.product_image_id) {
          const { data: img, error } = await admin.from("product_images").select("storage_path").eq("id", body.product_image_id).maybeSingle();
          if (error || !img?.storage_path) return json({ error: "Imagem de referência não encontrada." }, 404);
          const { data: fileData, error: downloadError } = await admin.storage.from("product-images").download(img.storage_path);
          if (downloadError || !fileData) return json({ error: `Falha ao baixar imagem de teste: ${downloadError?.message}` }, 500);
          const buffer = Buffer.from(await fileData.arrayBuffer());
          queryVector = await generateImageEmbedding(buffer);
          querySource = `product_images:${body.product_image_id}`;
        } else if (body.image_base64) {
          const raw = Buffer.from(body.image_base64, "base64");
          const processed = await processAndNormalizeImage(raw);
          queryVector = await generateImageEmbedding(processed.buffer);
          querySource = "upload_manual";
        } else {
          return json({ error: "Envie product_image_id (imagem já do catálogo) ou image_base64 (imagem externa)." }, 400);
        }

        const { matches, usedPgvector } = await findSimilarImages(admin, queryVector, limit);
        return json({ query_source: querySource, used_pgvector: usedPgvector, matches });
      }

      // --- Modo Scan (Parte 3): reconhecimento em tempo de conferência ---
      // Qualquer usuário ativo (operador inclusive) pode chamar — quem faz a
      // conferência normalmente não é manager/admin. O quadro nunca é salvo
      // em Storage/disco/log; é descartado assim que a função retorna.
      if (path === "/api/scan/recognize" && request.method === "POST") {
        const auth = await requireActiveUser(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        if (isRateLimited(auth.profile.id)) {
          return json({ error: "Muitas requisições em pouco tempo. Aguarde um instante e tente novamente." }, 429);
        }

        let body: { conference_id?: string; image_base64?: string; media_type?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.conference_id || typeof body.conference_id !== "string") {
          return json({ error: "conference_id é obrigatório." }, 400);
        }
        if (!body.image_base64 || typeof body.image_base64 !== "string") {
          return json({ error: "image_base64 é obrigatório." }, 400);
        }

        const admin = getSupabaseAdmin(env);

        // Autorização: mesma regra da RLS de conferences (operador dono ou manager/admin)
        // — replicada manualmente aqui porque o service_role ignora RLS.
        const { data: conference, error: conferenceError } = await admin
          .from("conferences")
          .select("id, operator_id")
          .eq("id", body.conference_id)
          .maybeSingle();
        if (conferenceError || !conference) return json({ error: "Conferência não encontrada." }, 404);
        const isOwner = conference.operator_id === auth.profile.id;
        const isPrivileged = auth.profile.role === "admin" || auth.profile.role === "manager";
        if (!isOwner && !isPrivileged) return json({ error: "Você não tem acesso a esta conferência." }, 403);

        let rawBuffer: Buffer;
        try {
          rawBuffer = Buffer.from(body.image_base64, "base64");
        } catch {
          return json({ error: "image_base64 inválido (não é base64 válido)." }, 400);
        }

        try {
          const result = await withTimeout(
            (async () => {
              const frame = await validateScanFrame(rawBuffer);
              return recognizeFrame(admin, frame.buffer);
            })(),
            SCAN_CONFIG.processingTimeoutMs
          );
          // Log só de metadados operacionais — nunca o quadro, nunca o vetor.
          console.log(
            `[scan/recognize] recognition_id=${result.recognition_id} status=${result.status} confidence=${result.confidence_level} candidates=${result.candidates.length} time_ms=${result.processing_time_ms}`
          );
          // Histórico real de performance/candidato vencedor (migration 0020) —
          // fire-and-forget: nunca atrasa nem derruba a resposta ao operador
          // por causa de uma falha no log.
          void logRecognitionPerformance(admin, result);
          const { timings: _timings, ...publicResult } = result;
          return json(publicResult);
        } catch (err) {
          if (err instanceof InvalidFrameError) return json({ error: err.message }, 422);
          if (err instanceof Error && err.message === "TIMEOUT") {
            return json({ error: `Tempo esgotado ao processar o quadro (limite ${SCAN_CONFIG.processingTimeoutMs}ms).` }, 504);
          }
          throw err;
        } finally {
          // rawBuffer/frame saem de escopo aqui — nada foi persistido em disco,
          // Storage ou log; a única coisa que sobrevive é o resultado estrutural.
        }
      }

      // --- Memória visual (aprendizado controlado a partir de scans reais) ---
      // Só grava com confirmação humana explícita — o operador já viu o
      // resultado e confirmou/corrigiu antes desta chamada acontecer. Nunca
      // é chamado automaticamente pelo loop de análise.
      if (path === "/api/scan/learn" && request.method === "POST") {
        const auth = await requireActiveUser(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: {
          variant_id?: string;
          image_base64?: string;
          source_type?: "confirmed_scan" | "corrected_scan";
          original_prediction_id?: string | null;
          original_confidence?: number | null;
          recognition_status?: string | null;
        };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.variant_id || typeof body.variant_id !== "string") {
          return json({ error: "variant_id é obrigatório." }, 400);
        }
        if (!body.image_base64 || typeof body.image_base64 !== "string") {
          return json({ error: "image_base64 é obrigatório." }, 400);
        }
        if (body.source_type !== "confirmed_scan" && body.source_type !== "corrected_scan") {
          return json({ error: "source_type deve ser 'confirmed_scan' ou 'corrected_scan'." }, 400);
        }

        let rawBuffer: Buffer;
        try {
          rawBuffer = Buffer.from(body.image_base64, "base64");
        } catch {
          return json({ error: "image_base64 inválido (não é base64 válido)." }, 400);
        }

        const admin = getSupabaseAdmin(env);
        try {
          const frame = await validateScanFrame(rawBuffer);
          const result = await recordLearningSample(admin, {
            variantId: body.variant_id,
            imageBuffer: frame.buffer,
            sourceType: body.source_type,
            originalPredictionId: body.original_prediction_id ?? null,
            originalConfidence: body.original_confidence ?? null,
            recognitionStatus: body.recognition_status ?? null,
            correctedBy: body.source_type === "corrected_scan" ? auth.profile.id : null,
          });
          console.log(
            `[scan/learn] variant_id=${body.variant_id} source_type=${body.source_type} saved=${result.saved} reinforced=${result.reinforcedExisting} reason=${result.reason ?? "-"}`
          );
          return json(result);
        } catch (err) {
          if (err instanceof InvalidFrameError) return json({ error: err.message }, 422);
          throw err;
        }
      }

      if (path === "/api/visual-learning/list" && request.method === "GET") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const admin = getSupabaseAdmin(env);
        const status = url.searchParams.get("status") || undefined;
        const variantId = url.searchParams.get("variant_id") || undefined;
        const page = Number(url.searchParams.get("page") || "0");
        const pageSize = Number(url.searchParams.get("page_size") || "30");
        const { rows, total } = await listLearningSamples(admin, { status, variantId, page, pageSize });
        return json({ rows, total });
      }

      if (path === "/api/visual-learning/update-status" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { sample_id?: string; status?: "validated" | "rejected" | "disabled" };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.sample_id || typeof body.sample_id !== "string") {
          return json({ error: "sample_id é obrigatório." }, 400);
        }
        if (!body.status || !["validated", "rejected", "disabled"].includes(body.status)) {
          return json({ error: "status deve ser 'validated', 'rejected' ou 'disabled'." }, 400);
        }

        const admin = getSupabaseAdmin(env);
        await updateLearningSampleStatus(admin, body.sample_id, body.status);
        return json({ ok: true });
      }

      // --- "Criar Reconhecimento": treinamento guiado multi-ângulo (Catálogo Visual) ---
      // Restrito a manager/admin — é uma ferramenta de curadoria da empresa,
      // não uma ação operacional de conferência.
      if (path === "/api/scan/assess-quality" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { image_base64?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.image_base64 || typeof body.image_base64 !== "string") {
          return json({ error: "image_base64 é obrigatório." }, 400);
        }
        let rawBuffer: Buffer;
        try {
          rawBuffer = Buffer.from(body.image_base64, "base64");
        } catch {
          return json({ error: "image_base64 inválido (não é base64 válido)." }, 400);
        }
        try {
          const frame = await validateScanFrame(rawBuffer);
          const assessment = await assessFrameQuality(frame.buffer);
          return json(assessment);
        } catch (err) {
          if (err instanceof InvalidFrameError) return json({ error: err.message }, 422);
          throw err;
        }
      }

      if (path === "/api/visual-learning/admin-reference" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { variant_id?: string; image_base64?: string; view_angle?: string | null };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.variant_id || typeof body.variant_id !== "string") {
          return json({ error: "variant_id é obrigatório." }, 400);
        }
        if (!body.image_base64 || typeof body.image_base64 !== "string") {
          return json({ error: "image_base64 é obrigatório." }, 400);
        }
        let rawBuffer: Buffer;
        try {
          rawBuffer = Buffer.from(body.image_base64, "base64");
        } catch {
          return json({ error: "image_base64 inválido (não é base64 válido)." }, 400);
        }

        const admin = getSupabaseAdmin(env);
        try {
          const frame = await validateScanFrame(rawBuffer);
          const result = await recordLearningSample(admin, {
            variantId: body.variant_id,
            imageBuffer: frame.buffer,
            sourceType: "admin_upload",
            originalPredictionId: null,
            originalConfidence: null,
            recognitionStatus: null,
            correctedBy: null,
            viewAngle: body.view_angle ?? null,
          });
          console.log(`[visual-learning/admin-reference] variant_id=${body.variant_id} view_angle=${body.view_angle ?? "-"} saved=${result.saved} reinforced=${result.reinforcedExisting} reason=${result.reason ?? "-"}`);
          return json(result);
        } catch (err) {
          if (err instanceof InvalidFrameError) return json({ error: err.message }, 422);
          throw err;
        }
      }

      if (path === "/api/visual-learning/library-summary" && request.method === "GET") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const variantId = url.searchParams.get("variant_id");
        if (!variantId) return json({ error: "variant_id é obrigatório." }, 400);

        const admin = getSupabaseAdmin(env);
        const summary = await getLibrarySummary(admin, variantId);
        return json(summary);
      }

      // --- "Nenhuma dessas opções" → produto ainda não cadastrado ---
      // Qualquer usuário ativo pode abrir a pendência (é quem está no chão
      // fazendo a conferência que esbarra num produto sem SKU cadastrado).
      if (path === "/api/visual-learning/report-unclassified" && request.method === "POST") {
        const auth = await requireActiveUser(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { image_base64?: string; observation?: string | null };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.image_base64 || typeof body.image_base64 !== "string") {
          return json({ error: "image_base64 é obrigatório." }, 400);
        }
        let rawBuffer: Buffer;
        try {
          rawBuffer = Buffer.from(body.image_base64, "base64");
        } catch {
          return json({ error: "image_base64 inválido (não é base64 válido)." }, 400);
        }

        const admin = getSupabaseAdmin(env);
        try {
          const frame = await validateScanFrame(rawBuffer);
          const result = await reportUnclassifiedProduct(admin, {
            reportedBy: auth.profile.id,
            imageBuffer: frame.buffer,
            observation: typeof body.observation === "string" && body.observation.trim() ? body.observation.trim().slice(0, 2000) : null,
          });
          console.log(`[visual-learning/report-unclassified] reported_by=${auth.profile.id} report_id=${result.reportId}`);
          return json(result);
        } catch (err) {
          if (err instanceof InvalidFrameError) return json({ error: err.message }, 422);
          throw err;
        }
      }

      // --- Qualidade de Reconhecimento (Catálogo Visual) ---
      if (path === "/api/visual-learning/recognition-quality-batch" && request.method === "GET") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const idsParam = url.searchParams.get("variant_ids") || "";
        const variantIds = idsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const admin = getSupabaseAdmin(env);
        const rows = await getRecognitionQualityForVariants(admin, variantIds);
        return json({ rows });
      }

      if (path === "/api/visual-learning/recognition-quality-list" && request.method === "GET") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        const admin = getSupabaseAdmin(env);
        const band = url.searchParams.get("band") || undefined;
        const onlyNoReferences = url.searchParams.get("only_no_references") === "1";
        const page = Number(url.searchParams.get("page") || "0");
        const pageSize = Number(url.searchParams.get("page_size") || "20");
        const sortBy = url.searchParams.get("sort") === "score_desc" ? "score_desc" : "score_asc";
        const { rows, total } = await listRecognitionQuality(admin, { band, onlyNoReferences, page, pageSize, sortBy });
        return json({ rows, total });
      }

      if (path === "/api/visual-learning/recalc-quality" && request.method === "POST") {
        const auth = await requireManagerOrAdmin(request, env);
        if (!auth.ok) return json({ error: auth.error }, auth.status);

        let body: { variant_id?: string };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return json({ error: "Corpo da requisição inválido (JSON esperado)." }, 400);
        }
        if (!body.variant_id) return json({ error: "variant_id é obrigatório." }, 400);

        const admin = getSupabaseAdmin(env);
        await recalculateRecognitionQuality(admin, body.variant_id);
        return json({ ok: true });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: errorMessage(err) }, 500);
    }
  },
};

// BUG REAL corrigido: erros do PostgREST/Supabase (ex.: ambiguidade de
// relacionamento, violação de constraint) chegam aqui como objeto plano
// { message, code, details, hint }, não como instância de Error — o extrator
// antigo (`err instanceof Error ? err.message : err`) caía no `else` e
// serializava o objeto inteiro como string, virando "[object Object]" pro
// operador. Qualquer objeto com uma propriedade `message` string agora é
// tratado como teria um `.message` de verdade.
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
