# Índice de Features do GoScan

- `#300926` [Integração com Ordem de Compra na Conferência por NF-e](2026-09-30-integracao-ordem-de-compra.md) — upload de OC (PDF/planilha), vínculo à NF-e e detecção automática de divergência de SKU por GTIN.
- [Performance da busca do Catálogo + correção do vínculo automático da Ordem de Carregamento](2026-10-01-performance-catalogo-e-matching-carregamento.md) — busca consolidada de 5 para 2 requests por vez (medido), e `splitModeloECor()` corrigido para achar a cor em qualquer posição do texto (causa raiz real de a maioria dos itens da Ordem de Carregamento ficar sem vínculo).
