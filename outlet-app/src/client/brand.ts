// Identidade central do app — única fonte de verdade para nome/descrição.
// Usado em: título da página, manifest da PWA, tela de login, cabeçalho,
// perfil, nomes de arquivo de exportação e documentação.
export const APP_NAME = "GoScan";
export const APP_SHORT_NAME = "GoScan";
// EXPANSÃO GOSCAN: o app deixou de ser exclusivo de Outlet (agora também
// cobre Produtos Normais + Conferência por Nota Fiscal) — subtítulo atualizado
// pra refletir isso em qualquer lugar que já use esta constante única.
export const APP_DESCRIPTION = "Conferência Inteligente de Produtos GoCase";
export const APP_COMPANY = "GoGroup";

export const BRAND_ASSETS = {
  wordmark: "/brand/goscan-wordmark.png",
  symbolSource: "/brand/goscan-symbol-source.png",
} as const;
