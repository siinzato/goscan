// EXPANSÃO GOSCAN — "Integrações": introdução, dentro do Perfil, à estrutura
// técnica já preparada para futuras integrações com o ERP (Tiny/Olist) e os
// marketplaces (pedido original, seção 20). Esta tela é status/leitura pra
// qualquer usuário ativo; o CADASTRO real das chaves de API (Client
// ID/Secret/tokens) vive só dentro da Administração (adminPanel.ts, aba
// Integrações — gated por permissão granular 'integrations.manage'), nunca
// aqui — reaproveita os mesmos metadados de provedor/status exportados
// abaixo, pra nunca ter duas listas divergentes.
import { Icon } from "../icons.ts";
import { getSupabase } from "../../supabaseClient.ts";
import { escapeHtml } from "../../utils.ts";
import { getAuthState, isManagerOrAdmin } from "../../auth.ts";
import type { IntegrationProvider, IntegrationStatus } from "../../adminApi.ts";

export interface ProviderInfo {
  key: IntegrationProvider;
  flagKey: string;
  name: string;
  description: string;
  icon: string;
}

export const INTEGRATION_PROVIDER_META: ProviderInfo[] = [
  { key: "tiny", flagKey: "tiny_integration_enabled", name: "Tiny / Olist ERP", icon: Icon.receipt, description: "Consulta de nota fiscal, verificação de estorno de estoque e lançamento de entrada por devolução." },
  { key: "marketplace_mercado_livre", flagKey: "marketplace_mercado_livre_enabled", name: "Mercado Livre", icon: Icon.package, description: "Consulta automática de pedido, devolução e motivo informado pelo marketplace." },
  { key: "marketplace_shopee", flagKey: "marketplace_shopee_enabled", name: "Shopee", icon: Icon.package, description: "Consulta automática de pedido, devolução e motivo informado pelo marketplace." },
  { key: "marketplace_shein", flagKey: "marketplace_shein_enabled", name: "Shein", icon: Icon.package, description: "Consulta automática de pedido, devolução e motivo informado pelo marketplace." },
  { key: "marketplace_amazon", flagKey: "marketplace_amazon_enabled", name: "Amazon", icon: Icon.package, description: "Consulta automática de pedido, devolução e motivo informado pelo marketplace." },
  { key: "marketplace_tiktok", flagKey: "marketplace_tiktok_enabled", name: "TikTok Shop", icon: Icon.package, description: "Consulta automática de pedido, devolução e motivo informado pelo marketplace." },
];

export const INTEGRATION_STATUS_META: Record<IntegrationStatus, { text: string; badge: string; icon: string }> = {
  not_configured: { text: "Não configurada", badge: "offline", icon: Icon.lock },
  configuration_incomplete: { text: "Configuração incompleta", badge: "warning", icon: Icon.alertTriangle },
  connected: { text: "Conectada", badge: "success", icon: Icon.checkCircle },
  auth_error: { text: "Erro de autenticação", badge: "error", icon: Icon.xCircle },
  sync_paused: { text: "Sincronização pausada", badge: "warning", icon: Icon.pause },
};

function providerRow(p: ProviderInfo, status: string | null): string {
  const s = INTEGRATION_STATUS_META[(status || "not_configured") as IntegrationStatus] || INTEGRATION_STATUS_META.not_configured;
  return `
    <div class="integration-provider-card">
      <span class="integration-provider-icon">${p.icon}</span>
      <div class="integration-provider-info">
        <strong>${escapeHtml(p.name)}</strong>
        <span>${escapeHtml(p.description)}</span>
      </div>
      <span class="status-badge ${s.badge}">${s.icon}${s.text}</span>
    </div>`;
}

export async function renderProfileIntegrations(root: HTMLElement): Promise<void> {
  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        <button class="btn-secondary" id="btnBackToProfile">${Icon.chevronLeft}Voltar</button>
        <h2>${Icon.link}Integrações</h2>
      </div>

      <div class="card">
        <p class="hint-text">O GoScan já tem uma estrutura técnica preparada para, futuramente, se conectar de forma automática ao ERP (Tiny/Olist) e aos marketplaces abaixo — consultando pedidos, notas fiscais e confirmando lançamentos de estoque sem depender só de digitação manual.</p>
        <p class="hint-text" style="margin-top:10px"><strong>Hoje, nenhuma integração está configurada.</strong> Todo o fluxo de devolução, estoque e nota fiscal continua 100% manual — nenhuma chamada externa acontece e nada aqui muda o comportamento atual do app até que uma integração seja de fato configurada.</p>
        ${
          canManage
            ? `<button type="button" class="btn-primary btn-block" id="btnGotoIntegrationsAdmin" style="margin-top:14px">${Icon.key}Configurar credenciais de API</button>`
            : `<p class="hint-text" style="margin-top:10px">O cadastro das chaves de API é feito pelos administradores do GoScan, na Administração.</p>`
        }
      </div>

      <div class="card">
        <h3>${Icon.settings}Provedores preparados</h3>
        <div class="integration-provider-list" id="integrationProviderList"></div>
      </div>
    </section>`;

  root.querySelector("#btnBackToProfile")!.addEventListener("click", () => {
    window.location.hash = "/perfil";
  });
  root.querySelector("#btnGotoIntegrationsAdmin")?.addEventListener("click", () => {
    window.location.hash = "/perfil/configuracoes/administracao/integracoes";
  });

  const listEl = root.querySelector<HTMLElement>("#integrationProviderList")!;
  listEl.innerHTML = INTEGRATION_PROVIDER_META.map((p) => providerRow(p, null)).join("");

  try {
    const supabase = getSupabase();
    const [flagsRes, providersRes] = await Promise.all([
      supabase.from("integration_feature_flags").select("key, enabled"),
      supabase.from("integration_providers").select("provider, status"),
    ]);
    const flagMap = new Map<string, boolean>(((flagsRes.data as { key: string; enabled: boolean }[]) || []).map((f) => [f.key, f.enabled]));
    const statusMap = new Map<string, string>(((providersRes.data as { provider: string; status: string }[]) || []).map((r) => [r.provider, r.status]));
    if (!root.isConnected) return;
    listEl.innerHTML = INTEGRATION_PROVIDER_META.map((p) => {
      const knownStatus = statusMap.get(p.key);
      const fallback = flagMap.get(p.flagKey) ? "configuration_incomplete" : "not_configured";
      return providerRow(p, knownStatus || fallback);
    }).join("");
  } catch {
    // Falha de rede/RLS nunca trava a tela — mantém "Não configurada" em todos, que já é o real hoje (ver seção 20.12 do pedido).
  }
}
