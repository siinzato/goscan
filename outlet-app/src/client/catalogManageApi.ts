// EXPANSÃO GOSCAN — Gestão direta do catálogo (Produtos Outlet/Normais) sem
// precisar subir planilha em massa: criar um produto avulso, editar
// nome/SKU/EAN/cor de um já cadastrado, ou excluir/desativar.
//
// Reaproveita DELIBERADAMENTE o mesmo upsert do importador em massa
// (upsertProductsAndVariants, importer.ts) para CRIAR — nunca duplica a
// lógica de upsert por model_code/sku_code em um segundo lugar. EDITAR usa
// update por id (nunca upsert por sku_code, que criaria um duplicado se o
// próprio SKU for renomeado).
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState, isManagerOrAdmin } from "./auth.ts";
import { normalize, normalizeEan, isValidEanFormat } from "./utils.ts";
import { upsertProductsAndVariants, deriveModelCode, type UpsertVariantRow } from "./importer.ts";
import { invalidateSearchCache, type ProductType } from "./catalogApi.ts";

function requireManager(): void {
  const { profile } = getAuthState();
  if (!isManagerOrAdmin(profile)) throw new Error("Apenas manager ou admin podem gerenciar o catálogo.");
}

export interface ManualProductInput {
  produto: string;
  sku_code: string;
  gtin: string;
  cor: string;
  modelo?: string;
  product_type: ProductType;
}

/** Validação de formulário — mesma regra de EAN usada em toda a correção (nunca uma segunda regra divergente). Retorna a mensagem de erro, ou null se válido. */
export function validateManualProduct(input: ManualProductInput): string | null {
  if (!input.produto.trim()) return "Nome do produto é obrigatório.";
  if (!input.sku_code.trim()) return "SKU é obrigatório.";
  if (input.gtin.trim() && !isValidEanFormat(normalizeEan(input.gtin))) {
    return "EAN inválido — deve ter 8, 12, 13 ou 14 dígitos (ou deixe em branco).";
  }
  return null;
}

/** Cria (ou atualiza, se o SKU já existir) um único produto — reaproveita o MESMO upsert do importador em massa, só que com 1 linha. */
export async function createManualProduct(input: ManualProductInput): Promise<void> {
  requireManager();
  const validationError = validateManualProduct(input);
  if (validationError) throw new Error(validationError);

  const row: UpsertVariantRow = {
    sku_code: input.sku_code.trim(),
    base: input.produto.trim(),
    cor: input.cor.trim(),
    gtin: input.gtin.trim(),
    model_code: deriveModelCode(input.sku_code.trim(), input.modelo),
    product_type: input.product_type,
  };
  await upsertProductsAndVariants([row]);
  invalidateSearchCache();
}

export interface VariantFieldsPatch {
  sku_code?: string;
  gtin?: string;
  color?: string;
}

/** Edita um SKU já cadastrado POR ID — nunca por upsert em sku_code (permite renomear o próprio SKU sem virar um registro duplicado). */
export async function updateVariantFields(variantId: string, patch: VariantFieldsPatch): Promise<void> {
  requireManager();
  if (patch.gtin !== undefined && patch.gtin.trim() && !isValidEanFormat(normalizeEan(patch.gtin))) {
    throw new Error("EAN inválido — deve ter 8, 12, 13 ou 14 dígitos (ou deixe em branco).");
  }
  if (patch.sku_code !== undefined && !patch.sku_code.trim()) {
    throw new Error("SKU não pode ficar em branco.");
  }

  const supabase = getSupabase();
  const update: Record<string, unknown> = {};
  if (patch.sku_code !== undefined) update.sku_code = patch.sku_code.trim();
  if (patch.gtin !== undefined) update.gtin = patch.gtin.trim() || null;
  if (patch.color !== undefined) {
    update.color = patch.color.trim() || null;
    update.normalized_color = normalize(patch.color);
  }
  if (Object.keys(update).length === 0) return;

  const { error } = await supabase.from("product_variants").update(update).eq("id", variantId);
  if (error) throw error;
  invalidateSearchCache();
}

/** Edita o nome do produto (família) — afeta todas as variações/cores que compartilham o mesmo product_id. */
export async function updateProductName(productId: string, name: string): Promise<void> {
  requireManager();
  if (!name.trim()) throw new Error("Nome do produto é obrigatório.");
  const supabase = getSupabase();
  const { error } = await supabase.from("products").update({ name: name.trim(), normalized_name: normalize(name) }).eq("id", productId);
  if (error) throw error;
  invalidateSearchCache();
}

export type DeleteVariantResult = { deleted: true } | { deleted: false; reason: "has_history" };

/**
 * Exclusão real — só é permitida quando o SKU NUNCA foi usado (sem histórico
 * de conferência/NF/scan/reconhecimento). As foreign keys que apontam pra
 * product_variants SEM "on delete cascade" (invoice_receipt_items,
 * conference_items, scan_recognition_log, unclassified_product_reports,
 * recognition_quality) já protegem isso no próprio banco — o Postgres recusa
 * a exclusão com um erro de violação de FK (23503) quando há histórico.
 * NUNCA força a exclusão nesse caso: o chamador deve oferecer desativar
 * (active=false) em vez disso, preservando relatórios/auditoria existentes.
 */
export async function deleteVariant(variantId: string): Promise<DeleteVariantResult> {
  requireManager();
  const supabase = getSupabase();
  const { error } = await supabase.from("product_variants").delete().eq("id", variantId);
  if (error) {
    if (error.code === "23503") return { deleted: false, reason: "has_history" };
    throw error;
  }
  invalidateSearchCache();
  return { deleted: true };
}

/** Desativa (ou reativa) um SKU — some/volta na busca (active=true é o filtro de searchCatalog) sem apagar nenhum histórico. */
export async function setVariantActive(variantId: string, active: boolean): Promise<void> {
  requireManager();
  const supabase = getSupabase();
  const { error } = await supabase.from("product_variants").update({ active }).eq("id", variantId);
  if (error) throw error;
  invalidateSearchCache();
}
