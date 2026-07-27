// EXPANSÃO GOSCAN — troca obrigatória de senha (definida por um admin ao
// criar/resetar credenciais de outro usuário: profiles.must_change_password).
// Bloqueia o app normal até uma troca real acontecer — ver wiring em
// main.ts (mesmo padrão de gate já usado pelo status "inactive").
import { Icon } from "../icons.ts";
import { goGroupMarqueeHtml } from "../gogroupMarquee.ts";
import { renderPasswordChangeForm } from "../passwordChangeForm.ts";

export function renderForcePasswordChange(root: HTMLElement): void {
  root.innerHTML = `
    <div class="boot-loading" role="alert">
      <div class="boot-loading-content force-password-card">
        <span class="force-password-icon" aria-hidden="true">${Icon.lock}</span>
        <h2>Defina uma nova senha</h2>
        <p>Por segurança, um administrador exigiu a troca da sua senha antes de continuar usando o GoScan.</p>
        <div id="forcePwFormWrap"></div>
      </div>
      ${goGroupMarqueeHtml()}
    </div>`;

  const wrap = root.querySelector<HTMLElement>("#forcePwFormWrap")!;
  renderPasswordChangeForm(wrap, { submitLabel: "Definir nova senha e continuar" });
  // Sem onSuccess explícito: updatePassword() já limpa must_change_password e
  // chama refreshProfile() — a notificação de auth state resultante é o que
  // faz main.ts sair deste gate e montar o app normal, sem F5.
}
