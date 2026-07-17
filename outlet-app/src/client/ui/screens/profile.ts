import { getAuthState, signOut } from "../../auth.ts";
import { escapeHtml } from "../../utils.ts";

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  manager: "Gerente",
  operator: "Operador",
};

export function renderProfile(root: HTMLElement): void {
  const { profile, session } = getAuthState();

  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        <div class="operator-card">
          <span class="operator-avatar" aria-hidden="true">👤</span>
          <div>
            <strong>${escapeHtml(profile?.full_name || "Operador")}</strong>
            <span class="role-tag">${escapeHtml(ROLE_LABELS[profile?.role || ""] || "")}</span>
          </div>
        </div>
        <p class="hint-text">${escapeHtml(session?.user.email || "")}</p>
        <button class="btn-secondary btn-block" id="btnLogout">Sair</button>
      </div>
    </section>`;

  root.querySelector("#btnLogout")!.addEventListener("click", async () => {
    const btn = root.querySelector("#btnLogout") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Saindo…";
    await signOut();
  });
}
