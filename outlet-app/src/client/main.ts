import { hasSupabaseConfig, MissingSupabaseConfigError } from "./supabaseClient.ts";
import { initAuth, subscribeAuth } from "./auth.ts";
import { mountShell } from "./ui/shell.ts";
import { renderLogin } from "./ui/screens/login.ts";
import { renderConfigError } from "./ui/configError.ts";

const root = document.getElementById("app-root")!;

async function boot() {
  if (!hasSupabaseConfig()) {
    renderConfigError(root, new MissingSupabaseConfigError().message);
    return;
  }

  // Estado de carregamento sem "piscar" conteúdo protegido: mostra um loading
  // simples até sessão + perfil estarem validados.
  root.innerHTML = `<div class="boot-loading" role="status" aria-live="polite">Carregando…</div>`;

  try {
    await initAuth();
  } catch (err) {
    renderConfigError(root, err instanceof Error ? err.message : String(err));
    return;
  }

  subscribeAuth((state) => {
    if (state.status === "loading") return; // já mostrado acima
    if (state.status === "signed_out") {
      renderLogin(root, state.error || "");
      return;
    }
    if (state.status === "inactive") {
      root.innerHTML = `
        <div class="boot-loading" role="alert">
          <p>Sua conta está desativada. Fale com um administrador para reativá-la.</p>
        </div>`;
      return;
    }
    if (state.status === "signed_in") {
      mountShell(root);
    }
  });
}

void boot();
