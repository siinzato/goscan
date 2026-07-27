// EXPANSÃO GOSCAN — formulário real de troca de senha (Supabase Auth via
// updatePassword() já existente em auth.ts). Reaproveitado tanto pela troca
// OBRIGATÓRIA (ui/screens/forcePasswordChange.ts) quanto pela seção
// "Segurança" de Configurações — um único lugar pra não duplicar a lógica
// de validação/força de senha.
import { updatePassword } from "../auth.ts";
import { escapeHtml, passwordRequirements, passwordMeetsRequirements } from "../utils.ts";
import { Icon } from "./icons.ts";
import { showToast } from "./toast.ts";

export interface PasswordChangeFormOptions {
  onSuccess?: () => void;
  submitLabel?: string;
}

/** Renderiza DENTRO de `root` (assume que o container é dedicado a isto). */
export function renderPasswordChangeForm(root: HTMLElement, opts: PasswordChangeFormOptions = {}): void {
  const submitLabel = opts.submitLabel || "Alterar senha";
  root.innerHTML = `
    <form id="pwChangeForm" novalidate>
      <label for="pwNew">Nova senha</label>
      <div class="password-field">
        <input type="password" id="pwNew" autocomplete="new-password" required />
        <button type="button" class="icon-btn" id="pwNewToggle" aria-label="Mostrar senha">${Icon.eye}</button>
      </div>
      <ul class="password-requirements" id="pwRequirements"></ul>

      <label for="pwConfirm">Confirmar nova senha</label>
      <div class="password-field">
        <input type="password" id="pwConfirm" autocomplete="new-password" required />
        <button type="button" class="icon-btn" id="pwConfirmToggle" aria-label="Mostrar senha">${Icon.eye}</button>
      </div>

      <p class="error-box" id="pwError" hidden></p>
      <button type="submit" class="btn-primary btn-block" id="pwSubmit">${escapeHtml(submitLabel)}</button>
    </form>`;

  const form = root.querySelector<HTMLFormElement>("#pwChangeForm")!;
  const newInput = root.querySelector<HTMLInputElement>("#pwNew")!;
  const confirmInput = root.querySelector<HTMLInputElement>("#pwConfirm")!;
  const reqList = root.querySelector<HTMLUListElement>("#pwRequirements")!;
  const errorEl = root.querySelector<HTMLElement>("#pwError")!;
  const submitBtn = root.querySelector<HTMLButtonElement>("#pwSubmit")!;

  function renderRequirements(): void {
    reqList.innerHTML = passwordRequirements(newInput.value)
      .map((r) => `<li class="${r.met ? "met" : ""}">${r.met ? Icon.checkCircle : Icon.xCircle}<span>${escapeHtml(r.label)}</span></li>`)
      .join("");
  }
  renderRequirements();
  newInput.addEventListener("input", renderRequirements);

  function wireToggle(toggleId: string, inputEl: HTMLInputElement): void {
    const btn = root.querySelector<HTMLButtonElement>(`#${toggleId}`)!;
    btn.addEventListener("click", () => {
      const show = inputEl.type === "password";
      inputEl.type = show ? "text" : "password";
      btn.innerHTML = show ? Icon.eyeOff : Icon.eye;
      btn.setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
    });
  }
  wireToggle("pwNewToggle", newInput);
  wireToggle("pwConfirmToggle", confirmInput);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;

    if (!passwordMeetsRequirements(newInput.value)) {
      errorEl.textContent = "A senha não atende aos requisitos mínimos.";
      errorEl.hidden = false;
      return;
    }
    if (newInput.value !== confirmInput.value) {
      errorEl.textContent = "As senhas não coincidem.";
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Salvando…";
    const err = await updatePassword(newInput.value);
    submitBtn.disabled = false;
    submitBtn.textContent = submitLabel;

    if (err) {
      errorEl.textContent = err;
      errorEl.hidden = false;
      return;
    }

    // Nunca mostra a senha de novo — limpa os campos.
    form.reset();
    renderRequirements();
    showToast("Senha alterada com sucesso.", "success");
    opts.onSuccess?.();
  });
}
