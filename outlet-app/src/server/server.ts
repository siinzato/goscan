// Backend mínimo: mantém no servidor o que não pode ir ao navegador —
// Claude Vision (ANTHROPIC_API_KEY) e, a partir do Catálogo Visual, o
// download SSRF-safe de imagens externas + escrita privilegiada no Storage
// (SUPABASE_SERVICE_ROLE_KEY). Catálogo, aliases, conferências e
// autenticação continuam Supabase direto do frontend (via RLS).
import { MODEL_ALIASES } from "./aliases-seed.ts";
import { getSupabaseAdmin, requireManagerOrAdmin, type AdminEnv } from "./supabaseAdmin.ts";
import { processImportBatch, resetErrorItems } from "./catalogImages.ts";

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

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err instanceof Error ? err.message : err) }, 500);
    }
  },
};
