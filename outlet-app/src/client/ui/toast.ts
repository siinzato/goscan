import { Icon } from "./icons.ts";
import { escapeHtml } from "../utils.ts";

export type ToastKind = "default" | "success" | "error";

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement("div");
  container.className = "toast-container";
  container.setAttribute("role", "status");
  container.setAttribute("aria-live", "polite");
  document.body.appendChild(container);
  return container;
}

const KIND_ICON: Record<ToastKind, string> = {
  default: Icon.info,
  success: Icon.checkCircle,
  error: Icon.xCircle,
};

export function showToast(message: string, kind: ToastKind = "default", durationMs = 3500): void {
  const el = ensureContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${kind === "default" ? "" : kind}`.trim();
  toast.innerHTML = `${KIND_ICON[kind]}<span>${escapeHtml(message)}</span>`;
  el.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, durationMs);
}
