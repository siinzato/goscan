// Cabeçalhos CORS compartilhados entre Edge Functions do GoScan.
//
// O app roda localmente e é acessado por uma URL temporária de ngrok que
// muda a cada sessão — nunca fixar uma origem específica aqui. Como a
// autenticação é sempre via Authorization: Bearer (nunca cookie), liberar
// "*" não expõe nada: não há credencial implícita que um site de terceiro
// pudesse "andar de carona" com uma requisição cross-origin.
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function handleCorsPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
