// EXPANSÃO GOSCAN — tema claro/escuro. O DOM (data-theme no <html>) é sempre
// aplicado de forma síncrona/local primeiro — nunca espera uma resposta de
// rede pra refletir a escolha do usuário. profiles.theme é a fonte de
// verdade entre dispositivos; localStorage é só cache/fallback (evita flash
// antes do boot assíncrono do Supabase — ver script inline em index.html).
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState, refreshProfile } from "./auth.ts";

export type ThemeName = "light" | "dark";
const STORAGE_KEY = "goscan:theme";

export function getStoredTheme(): ThemeName {
  try {
    return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Aplica no DOM + localStorage — nunca lança mesmo sem storage disponível (modo privado/quota). */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Sem storage disponível — tema já foi aplicado no DOM, só não persiste localmente.
  }
}

/** Troca o tema: aplica local imediatamente e persiste em profiles.theme em segundo plano (fire-and-forget pro DOM, mas aguardável pra quem quiser confirmar o salvamento). */
export async function setTheme(theme: ThemeName): Promise<void> {
  applyTheme(theme);
  const { session } = getAuthState();
  if (!session) return;
  const supabase = getSupabase();
  const { error } = await supabase.from("profiles").update({ theme }).eq("id", session.user.id);
  if (error) {
    console.error("Falha ao salvar preferência de tema:", error.message);
    return;
  }
  await refreshProfile();
}

/** Chamado uma vez logo após o login — profiles.theme é a fonte de verdade; corrige o cache local se divergir (ex.: usuário trocou o tema em outro aparelho). */
export function syncThemeFromProfile(theme: ThemeName): void {
  if (getStoredTheme() !== theme) applyTheme(theme);
}
