import { escapeHtml } from "../utils.ts";

export function renderConfigError(root: HTMLElement, message: string): void {
  root.innerHTML = `
    <div class="boot-loading config-error" role="alert">
      <h1>Configuração incompleta</h1>
      <p>${escapeHtml(message)}</p>
    </div>`;
}
