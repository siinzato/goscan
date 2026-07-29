import { escapeHtml } from "../utils.ts";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** Substitui confirm() nativo por um bottom sheet consistente com o resto da UI. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-sheet" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h3 id="confirm-title">${escapeHtml(opts.title)}</h3>
        <p class="hint-text">${escapeHtml(opts.message)}</p>
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="confirm-cancel">${escapeHtml(opts.cancelLabel || "Cancelar")}</button>
          <button type="button" class="${opts.danger ? "btn-danger" : "btn-primary"}" id="confirm-ok">${escapeHtml(opts.confirmLabel || "Confirmar")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function close(result: boolean) {
      overlay.remove();
      resolve(result);
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    overlay.querySelector("#confirm-cancel")!.addEventListener("click", () => close(false));
    overlay.querySelector("#confirm-ok")!.addEventListener("click", () => close(true));
  });
}

export interface ChoiceOption {
  label: string;
  value: string;
  danger?: boolean;
}

export interface ChoiceOptions {
  title: string;
  message: string;
  options: ChoiceOption[];
  /** Rótulo do botão que fecha sem escolher nada — omitir esconde o botão (força uma escolha real). */
  dismissLabel?: string;
}

/**
 * Mesmo bottom sheet de confirmAction, mas com N opções nomeadas em vez de
 * um binário sim/não — usado pelos conflitos de conferência colaborativa
 * (reserva de produto, excesso confirmado) onde o operador escolhe entre
 * várias ações reais, nunca só "confirmar/cancelar" (ver EXPANSÃO GOSCAN —
 * Conferência Colaborativa Segura).
 */
export function chooseAction(opts: ChoiceOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-sheet" role="alertdialog" aria-modal="true" aria-labelledby="choice-title">
        <h3 id="choice-title">${escapeHtml(opts.title)}</h3>
        <p class="hint-text">${escapeHtml(opts.message)}</p>
        <div class="modal-actions modal-actions-stacked">
          ${opts.options
            .map((o, idx) => `<button type="button" class="${o.danger ? "btn-danger" : idx === 0 ? "btn-primary" : "btn-secondary"}" data-choice="${escapeHtml(o.value)}">${escapeHtml(o.label)}</button>`)
            .join("")}
          ${opts.dismissLabel ? `<button type="button" class="btn-secondary" id="choice-dismiss">${escapeHtml(opts.dismissLabel)}</button>` : ""}
        </div>
      </div>`;
    document.body.appendChild(overlay);

    function close(result: string | null) {
      overlay.remove();
      resolve(result);
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    overlay.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((btn) => {
      btn.addEventListener("click", () => close(btn.dataset.choice!));
    });
    overlay.querySelector("#choice-dismiss")?.addEventListener("click", () => close(null));
  });
}

export interface PromptOptions {
  title: string;
  message?: string;
  placeholder?: string;
  confirmLabel?: string;
}

/** Mesmo bottom sheet, mas pra capturar um texto curto — substitui window.prompt() nativo (nunca usado nesta base). */
export function promptText(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-sheet" role="alertdialog" aria-modal="true" aria-labelledby="prompt-title">
        <h3 id="prompt-title">${escapeHtml(opts.title)}</h3>
        ${opts.message ? `<p class="hint-text">${escapeHtml(opts.message)}</p>` : ""}
        <label for="prompt-input" class="sr-only">${escapeHtml(opts.title)}</label>
        <input type="text" id="prompt-input" placeholder="${escapeHtml(opts.placeholder || "")}" autocomplete="off" />
        <div class="modal-actions">
          <button type="button" class="btn-secondary" id="prompt-cancel">Cancelar</button>
          <button type="button" class="btn-primary" id="prompt-ok">${escapeHtml(opts.confirmLabel || "Confirmar")}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector<HTMLInputElement>("#prompt-input")!;
    input.focus();

    function close(result: string | null) {
      overlay.remove();
      resolve(result);
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) close(input.value.trim());
    });
    overlay.querySelector("#prompt-cancel")!.addEventListener("click", () => close(null));
    overlay.querySelector("#prompt-ok")!.addEventListener("click", () => {
      if (input.value.trim()) close(input.value.trim());
    });
  });
}
