import { hasSupabaseConfig, MissingSupabaseConfigError } from "./supabaseClient.ts";
import { initAuth, subscribeAuth, getAuthState } from "./auth.ts";
import { mountShell } from "./ui/shell.ts";
import { renderLogin } from "./ui/screens/login.ts";
import { renderConfigError } from "./ui/configError.ts";
import { goGroupMarqueeHtml } from "./ui/gogroupMarquee.ts";
import { syncThemeFromProfile } from "./theme.ts";
import { renderForcePasswordChange } from "./ui/screens/forcePasswordChange.ts";

const root = document.getElementById("app-root")!;

function renderBootLoading(step: string): void {
  root.innerHTML = `
    <div class="boot-loading" role="status" aria-live="polite">
      <div class="boot-loading-content">
        <img class="boot-loading-logo" src="/brand/goscan-wordmark.png" alt="GoScan" />
        <p>${step}</p>
      </div>
      ${goGroupMarqueeHtml()}
    </div>`;
}

function renderBootError(message: string): void {
  root.innerHTML = `
    <div class="boot-loading" role="alert">
      <div class="boot-loading-content">
        <img class="boot-loading-logo" src="/brand/goscan-wordmark.png" alt="GoScan" />
        <p>${message}</p>
        <div class="boot-loading-actions">
          <button class="btn-primary" id="boot-retry">Tentar novamente</button>
          <button class="btn-secondary" id="boot-back-to-login">Voltar ao login</button>
        </div>
      </div>
      ${goGroupMarqueeHtml()}
    </div>`;
  document.getElementById("boot-retry")!.addEventListener("click", () => void boot());
  document.getElementById("boot-back-to-login")!.addEventListener("click", () => {
    renderLogin(root);
  });
}

let shellMountedOnce = false;

async function boot() {
  if (!hasSupabaseConfig()) {
    renderConfigError(root, new MissingSupabaseConfigError().message);
    return;
  }

  // Estado de carregamento sem "piscar" conteúdo protegido: mostra a etapa
  // real (nunca inventada — reflete o passo que auth.ts está executando)
  // até sessão + perfil estarem validados.
  renderBootLoading(getAuthState().bootStep);

  await initAuth();

  subscribeAuth((state) => {
    if (state.status === "initializing") {
      renderBootLoading(state.bootStep);
      return;
    }
    if (state.status === "error") {
      renderBootError(state.error || "Não foi possível concluir o carregamento da sua conta.");
      return;
    }
    if (state.status === "signed_out") {
      renderLogin(root, state.sessionExpired ? "Sua sessão expirou por segurança. Entre novamente para continuar." : state.error || "");
      return;
    }
    if (state.status === "inactive") {
      root.innerHTML = `
        <div class="boot-loading" role="alert">
          <div class="boot-loading-content">
            <p>Sua conta está desativada. Fale com um administrador para reativá-la.</p>
          </div>
          ${goGroupMarqueeHtml()}
        </div>`;
      return;
    }
    if (state.status === "signed_in") {
      // profiles.theme é a fonte de verdade entre dispositivos — sincroniza o
      // cache local (localStorage) se divergir, sem esperar isso pra montar a tela.
      if (state.profile) syncThemeFromProfile(state.profile.theme);

      // EXPANSÃO GOSCAN — troca obrigatória de senha (definida por um admin
      // ao criar/resetar credenciais de outro usuário): bloqueia o app
      // normal até a troca real acontecer, mesmo padrão de gate já usado
      // pelo status "inactive" acima. shellMountedOnce fica false aqui de
      // propósito — se o flag for limpo depois (updatePassword() já chama
      // refreshProfile()), esta mesma notificação re-executa o listener e
      // cai no mountShell() abaixo sem precisar de F5.
      if (state.profile?.must_change_password) {
        shellMountedOnce = false;
        renderForcePasswordChange(root);
        return;
      }

      // mountShell() já é idempotente (shellMounted interno), mas evita até
      // recriar a subscrição de estado à toa se signed_in disparar de novo
      // (ex.: token refresh) sem ter saído de signed_in nesse meio-tempo.
      shellMountedOnce = true;
      mountShell(root);
    }
  });
}

void boot();

// Se o boot nunca terminou (initAuth ficou pendurado por algum motivo
// imprevisto fora do próprio timeout interno), garante que o usuário nunca
// fique olhando pra um "Carregando…" indefinidamente sem nenhuma ação
// disponível — mesmo tempo do timeout interno de initAuth, como rede de
// segurança adicional.
setTimeout(() => {
  if (!shellMountedOnce && getAuthState().status === "initializing") {
    renderBootError("Não foi possível concluir o carregamento da sua conta.");
  }
}, 12_000);
