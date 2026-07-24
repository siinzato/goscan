import { signIn, sendPasswordReset, updatePassword } from "../../auth.ts";
import { escapeHtml } from "../../utils.ts";
import { APP_NAME, APP_DESCRIPTION, APP_COMPANY } from "../../brand.ts";
import { goGroupMarqueeHtml } from "../gogroupMarquee.ts";
import { installGuideButtonHtml, wireInstallGuideButton } from "../pwaInstall.ts";

function isRecoveryLink(): boolean {
  return window.location.hash.includes("type=recovery") || window.location.search.includes("type=recovery");
}

export function renderLogin(root: HTMLElement, authError = ""): void {
  if (isRecoveryLink()) {
    renderRecoveryForm(root);
    return;
  }
  renderLoginForm(root, "login", "", authError);
}

function renderLoginForm(root: HTMLElement, mode: "login" | "forgot" = "login", notice = "", authError = ""): void {
  root.innerHTML = `
    <div class="auth-screen">
      <div class="auth-screen-content">
        <div class="auth-card">
          <img class="auth-logo" src="/brand/goscan-wordmark.png" alt="${APP_NAME}" />
          <p class="auth-tagline">${escapeHtml(APP_DESCRIPTION)}</p>
          <p class="auth-subtagline">Uma ferramenta ${escapeHtml(APP_COMPANY)}</p>

          ${notice ? `<div class="notice-box">${escapeHtml(notice)}</div>` : ""}
          <div id="auth-error" class="error-box" ${authError ? "" : "hidden"}>${escapeHtml(authError)}</div>

          ${
            mode === "login"
              ? `
            <form id="login-form" novalidate>
              <label for="login-email">E-mail</label>
              <input id="login-email" name="email" type="email" autocomplete="username" required inputmode="email" />
              <label for="login-password">Senha</label>
              <input id="login-password" name="password" type="password" autocomplete="current-password" required />
              <button type="submit" class="btn-primary btn-block" id="login-submit">Entrar</button>
            </form>
            <button type="button" class="link-btn" id="go-forgot">Esqueci minha senha</button>
          `
              : `
            <form id="forgot-form" novalidate>
              <label for="forgot-email">E-mail</label>
              <input id="forgot-email" name="email" type="email" autocomplete="username" required inputmode="email" />
              <button type="submit" class="btn-primary btn-block" id="forgot-submit">Enviar link de recuperação</button>
            </form>
            <button type="button" class="link-btn" id="go-login">Voltar para o login</button>
          `
          }

          ${installGuideButtonHtml()}
        </div>
      </div>
      ${goGroupMarqueeHtml()}
    </div>`;

  const errorBox = document.getElementById("auth-error")!;
  const showError = (message: string) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  if (mode === "login") {
    document.getElementById("go-forgot")!.addEventListener("click", () => renderLoginForm(root, "forgot"));
    document.getElementById("login-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
      const password = (form.elements.namedItem("password") as HTMLInputElement).value;
      const submitBtn = document.getElementById("login-submit") as HTMLButtonElement;
      submitBtn.disabled = true;
      submitBtn.textContent = "Entrando…";
      const error = await signIn(email, password);
      if (error) {
        showError(error);
        submitBtn.disabled = false;
        submitBtn.textContent = "Entrar";
      }
      // sucesso: subscribeAuth (main.ts) troca de tela sozinho.
    });
  } else {
    document.getElementById("go-login")!.addEventListener("click", () => renderLoginForm(root, "login"));
    document.getElementById("forgot-form")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const form = e.target as HTMLFormElement;
      const email = (form.elements.namedItem("email") as HTMLInputElement).value.trim();
      const submitBtn = document.getElementById("forgot-submit") as HTMLButtonElement;
      submitBtn.disabled = true;
      submitBtn.textContent = "Enviando…";
      const error = await sendPasswordReset(email);
      if (error) {
        showError(error);
        submitBtn.disabled = false;
        submitBtn.textContent = "Enviar link de recuperação";
        return;
      }
      renderLoginForm(root, "login", "Se o e-mail existir, enviamos um link de recuperação de senha.");
    });
  }

  wireInstallGuideButton();
}

function renderRecoveryForm(root: HTMLElement): void {
  root.innerHTML = `
    <div class="auth-screen">
      <div class="auth-screen-content">
        <div class="auth-card">
          <img class="auth-logo" src="/brand/goscan-wordmark.png" alt="${APP_NAME}" />
          <p class="auth-tagline">Nova senha</p>
          <p class="hint-text">Defina uma nova senha para sua conta.</p>
          <div id="auth-error" class="error-box" hidden></div>
          <form id="recovery-form" novalidate>
            <label for="recovery-password">Nova senha</label>
            <input id="recovery-password" name="password" type="password" autocomplete="new-password" minlength="6" required />
            <button type="submit" class="btn-primary btn-block" id="recovery-submit">Salvar nova senha</button>
          </form>
        </div>
      </div>
      ${goGroupMarqueeHtml()}
    </div>`;

  const errorBox = document.getElementById("auth-error")!;
  document.getElementById("recovery-form")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    const submitBtn = document.getElementById("recovery-submit") as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = "Salvando…";
    const error = await updatePassword(password);
    if (error) {
      errorBox.textContent = error;
      errorBox.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Salvar nova senha";
      return;
    }
    window.location.hash = "";
    window.location.href = "/";
  });
}
