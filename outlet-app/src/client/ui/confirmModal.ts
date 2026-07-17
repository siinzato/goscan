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
