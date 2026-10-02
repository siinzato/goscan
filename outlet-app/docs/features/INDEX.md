# Índice de Features do GoScan

- `#021026` [Busca instantânea por SKU/EAN e RLS do catálogo avaliada uma vez por consulta](2026-10-02-busca-exata-sku-ean-e-rls-rapida.md) — SKU/EAN exato resolvido por índice e policies de `products`/`product_variants` calculadas uma vez por consulta; buscas de 5–10 s passaram para milissegundos.
- `#300926` [Integração com Ordem de Compra na Conferência por NF-e](2026-09-30-integracao-ordem-de-compra.md) — upload de OC (PDF/planilha), vínculo à NF-e e detecção automática de divergência de SKU por GTIN.
- [Performance da busca do Catálogo + correção do vínculo automático da Ordem de Carregamento](2026-10-01-performance-catalogo-e-matching-carregamento.md) — busca consolidada de 5 para 2 requests por vez (medido), e `splitModeloECor()` corrigido para achar a cor em qualquer posição do texto (causa raiz real de a maioria dos itens da Ordem de Carregamento ficar sem vínculo).
