// EXPANSÃO GOSCAN — Configurações: Aparência, Minha conta, Segurança,
// Administração (só o portão de acesso na Fase A — o painel em si é a Fase B).
import { getAuthState, isManagerOrAdmin, refreshProfile, sendPasswordReset } from "../../auth.ts";
import { getSupabase } from "../../supabaseClient.ts";
import { escapeHtml, isValidEmail, isValidBrPhone, describeError } from "../../utils.ts";
import { Icon } from "../icons.ts";
import { showToast } from "../toast.ts";
import { setTheme, type ThemeName } from "../../theme.ts";
import { renderPasswordChangeForm } from "../passwordChangeForm.ts";

export async function renderProfileSettings(root: HTMLElement, sub: string[]): Promise<void> {
  if (sub[0] === "administracao") {
    renderAdministracaoGate(root);
    return;
  }
  renderSettingsHub(root);
}

function backButton(): string {
  return `<button class="btn-secondary" id="btnBackToProfile">${Icon.chevronLeft}Voltar</button>`;
}

function wireBack(root: HTMLElement, hash = "/perfil"): void {
  root.querySelector("#btnBackToProfile")!.addEventListener("click", () => {
    window.location.hash = hash;
  });
}

function renderSettingsHub(root: HTMLElement): void {
  const { profile } = getAuthState();
  const canManage = isManagerOrAdmin(profile);

  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        ${backButton()}
        <h2>Configurações</h2>
      </div>

      <div class="card" id="settingsAparencia">
        <h3>${Icon.settings}Aparência</h3>
        <p class="hint-text">Escolha como o GoScan aparece pra você neste dispositivo.</p>
        <div class="theme-switch" role="radiogroup" aria-label="Tema">
          <button type="button" class="theme-option ${profile?.theme !== "dark" ? "active" : ""}" data-theme-choice="light">
            ${Icon.sun}<span>Claro</span>
          </button>
          <button type="button" class="theme-option ${profile?.theme === "dark" ? "active" : ""}" data-theme-choice="dark">
            ${Icon.moon}<span>Escuro</span>
          </button>
        </div>
      </div>

      <div class="card" id="settingsContaWrap"></div>

      <div class="card" id="settingsSegurancaWrap"></div>

      <button type="button" class="profile-menu-item" id="btnGotoAdmin">
        <span class="profile-menu-icon">${canManage ? Icon.settings : Icon.lock}</span>
        <span class="profile-menu-text">
          <strong>Administração</strong>
          <span>${canManage ? "Gerenciar usuários, permissões e auditoria." : "Acesso restrito aos administradores do GoScan."}</span>
        </span>
        <span class="profile-menu-chevron">${canManage ? Icon.chevronRight : Icon.lock}</span>
      </button>
    </section>`;

  wireBack(root);

  root.querySelectorAll<HTMLButtonElement>("[data-theme-choice]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const choice = btn.dataset.themeChoice as ThemeName;
      root.querySelectorAll("[data-theme-choice]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await setTheme(choice);
    });
  });

  root.querySelector("#btnGotoAdmin")!.addEventListener("click", () => {
    window.location.hash = "/perfil/configuracoes/administracao";
  });

  renderMinhaConta(root.querySelector<HTMLElement>("#settingsContaWrap")!);
  renderSeguranca(root.querySelector<HTMLElement>("#settingsSegurancaWrap")!);
}

// ---------------------------------------------------------------------------
// Minha conta
// ---------------------------------------------------------------------------
interface AccountSnapshot {
  full_name: string;
  job_title: string;
  work_group: string;
  phone: string;
  recovery_email: string;
  email: string;
}

function renderMinhaConta(root: HTMLElement): void {
  const { profile, session } = getAuthState();
  const snapshot: AccountSnapshot = {
    full_name: profile?.full_name || "",
    job_title: profile?.job_title || "",
    work_group: profile?.work_group || "",
    phone: profile?.phone || "",
    recovery_email: profile?.recovery_email || "",
    email: session?.user.email || "",
  };

  root.innerHTML = `
    <h3>${Icon.user}Minha conta</h3>
    <form id="accountForm" novalidate>
      <label for="acctName">Nome completo</label>
      <input type="text" id="acctName" value="${escapeHtml(snapshot.full_name)}" required />

      <label for="acctJobTitle">Cargo</label>
      <input type="text" id="acctJobTitle" value="${escapeHtml(snapshot.job_title)}" />

      <label for="acctWorkGroup">Grupo de trabalho</label>
      <input type="text" id="acctWorkGroup" value="${escapeHtml(snapshot.work_group)}" placeholder="Ex.: Estoque, Recebimento…" />

      <label for="acctPhone">Telefone</label>
      <input type="tel" id="acctPhone" value="${escapeHtml(snapshot.phone)}" placeholder="(11) 91234-5678" />

      <label for="acctEmail">E-mail de trabalho (login)</label>
      <input type="email" id="acctEmail" value="${escapeHtml(snapshot.email)}" />
      <p class="hint-text" id="acctEmailHint" style="margin-top:-10px">Alterar este e-mail exige confirmar sua senha atual e confirmar o novo endereço por e-mail.</p>

      <label for="acctRecoveryEmail">E-mail de recuperação (alternativo)</label>
      <input type="email" id="acctRecoveryEmail" value="${escapeHtml(snapshot.recovery_email)}" placeholder="opcional" />
      <p class="hint-text" style="margin-top:-10px">
        ${profile?.recovery_email_verified ? `<span class="status-badge success">${Icon.checkCircle}Verificado</span>` : `<span class="status-badge warning">${Icon.alertTriangle}Não verificado — ainda não pode ser usado pra recuperação de conta</span>`}
      </p>

      <div id="acctReauthWrap" hidden>
        <label for="acctReauthPassword">Confirme sua senha atual pra alterar o e-mail de login</label>
        <input type="password" id="acctReauthPassword" autocomplete="current-password" />
      </div>

      <p class="error-box" id="acctError" hidden></p>
      <button type="submit" class="btn-primary btn-block" id="acctSubmit" disabled>Salvar alterações</button>
    </form>`;

  const form = root.querySelector<HTMLFormElement>("#accountForm")!;
  const fields = {
    full_name: root.querySelector<HTMLInputElement>("#acctName")!,
    job_title: root.querySelector<HTMLInputElement>("#acctJobTitle")!,
    work_group: root.querySelector<HTMLInputElement>("#acctWorkGroup")!,
    phone: root.querySelector<HTMLInputElement>("#acctPhone")!,
    email: root.querySelector<HTMLInputElement>("#acctEmail")!,
    recovery_email: root.querySelector<HTMLInputElement>("#acctRecoveryEmail")!,
  };
  const reauthWrap = root.querySelector<HTMLElement>("#acctReauthWrap")!;
  const reauthInput = root.querySelector<HTMLInputElement>("#acctReauthPassword")!;
  const errorEl = root.querySelector<HTMLElement>("#acctError")!;
  const submitBtn = root.querySelector<HTMLButtonElement>("#acctSubmit")!;

  function isDirty(): boolean {
    return (Object.keys(fields) as (keyof AccountSnapshot)[]).some((key) => fields[key].value.trim() !== snapshot[key]);
  }
  function refreshDirtyState(): void {
    const emailChanged = fields.email.value.trim() !== snapshot.email;
    reauthWrap.hidden = !emailChanged;
    submitBtn.disabled = !isDirty();
  }
  Object.values(fields).forEach((el) => el.addEventListener("input", refreshDirtyState));
  refreshDirtyState();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    if (!isDirty()) return;

    const newName = fields.full_name.value.trim();
    const newJobTitle = fields.job_title.value.trim();
    const newWorkGroup = fields.work_group.value.trim();
    const newPhone = fields.phone.value.trim();
    const newEmail = fields.email.value.trim();
    const newRecoveryEmail = fields.recovery_email.value.trim();
    const emailChanged = newEmail !== snapshot.email;
    const recoveryEmailChanged = newRecoveryEmail !== snapshot.recovery_email;

    if (!newName) {
      errorEl.textContent = "Nome completo é obrigatório.";
      errorEl.hidden = false;
      return;
    }
    if (newPhone && !isValidBrPhone(newPhone)) {
      errorEl.textContent = "Telefone inválido — use um número brasileiro (com DDD).";
      errorEl.hidden = false;
      return;
    }
    if (emailChanged && !isValidEmail(newEmail)) {
      errorEl.textContent = "E-mail de trabalho inválido.";
      errorEl.hidden = false;
      return;
    }
    if (newRecoveryEmail && !isValidEmail(newRecoveryEmail)) {
      errorEl.textContent = "E-mail de recuperação inválido.";
      errorEl.hidden = false;
      return;
    }
    if (emailChanged && !reauthInput.value) {
      errorEl.textContent = "Confirme sua senha atual pra alterar o e-mail de login.";
      errorEl.hidden = false;
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = "Salvando…";
    const supabase = getSupabase();

    try {
      // Mudança sensível (e-mail de login) exige reautenticação real — nunca
      // só um campo de senha decorativo: valida de fato contra o Supabase Auth
      // antes de prosseguir (mesma conta, então isto só reconfirma a sessão,
      // nunca troca de identidade).
      if (emailChanged) {
        const { error: reauthError } = await supabase.auth.signInWithPassword({ email: snapshot.email, password: reauthInput.value });
        if (reauthError) {
          errorEl.textContent = "Senha atual incorreta.";
          errorEl.hidden = false;
          return;
        }
      }

      const { error: profileError } = await supabase
        .from("profiles")
        .update({
          full_name: newName,
          job_title: newJobTitle || null,
          work_group: newWorkGroup || null,
          phone: newPhone || null,
          // Só reseta a verificação se o e-mail de recuperação realmente mudou —
          // nunca marca como verificado sozinho (isso só acontece por um fluxo
          // de verificação real, ainda não disponível nesta versão).
          ...(recoveryEmailChanged ? { recovery_email: newRecoveryEmail || null, recovery_email_verified: false } : {}),
        })
        .eq("id", getAuthState().session!.user.id);
      if (profileError) throw profileError;

      if (emailChanged) {
        const { error: emailError } = await supabase.auth.updateUser({ email: newEmail });
        if (emailError) throw emailError;
        showToast("Enviamos um link de confirmação pro novo e-mail — a troca só é concluída depois de confirmada.", "success");
      } else {
        showToast("Dados salvos com sucesso.", "success");
      }

      await refreshProfile();
      snapshot.full_name = newName;
      snapshot.job_title = newJobTitle;
      snapshot.work_group = newWorkGroup;
      snapshot.phone = newPhone;
      snapshot.recovery_email = newRecoveryEmail;
      // snapshot.email só atualiza de verdade quando a confirmação acontecer
      // (session.user.email não muda até lá) — mantém o form coerente com o
      // que está realmente salvo agora.
      reauthInput.value = "";
      refreshDirtyState();
    } catch (err) {
      errorEl.textContent = describeError(err);
      errorEl.hidden = false;
    } finally {
      submitBtn.textContent = "Salvar alterações";
      submitBtn.disabled = !isDirty();
    }
  });
}

// ---------------------------------------------------------------------------
// Segurança e recuperação
// ---------------------------------------------------------------------------
function renderSeguranca(root: HTMLElement): void {
  const { session } = getAuthState();
  root.innerHTML = `
    <h3>${Icon.lock}Segurança e recuperação</h3>
    <div id="segPasswordFormWrap"></div>
    <div class="card" style="margin:14px 0 0;background:var(--bg-subtle)">
      <p class="hint-text" style="margin-bottom:8px">Canal de recuperação verificado:</p>
      <p class="hint-text" style="margin:0">${Icon.mail}${escapeHtml(session?.user.email || "-")} <span class="status-badge success">${Icon.checkCircle}Verificado</span></p>
      <button type="button" class="btn-secondary btn-block" id="btnSendResetLink" style="margin-top:12px">Enviar link de recuperação por e-mail</button>
    </div>`;

  renderPasswordChangeForm(root.querySelector<HTMLElement>("#segPasswordFormWrap")!);

  root.querySelector("#btnSendResetLink")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (!session?.user.email) return;
    btn.disabled = true;
    btn.textContent = "Enviando…";
    const err = await sendPasswordReset(session.user.email);
    btn.disabled = false;
    btn.textContent = "Enviar link de recuperação por e-mail";
    showToast(err || `Link enviado para ${session.user.email}.`, err ? "error" : "success");
  });
}

// ---------------------------------------------------------------------------
// Administração — Fase A só protege a rota de verdade; painel é a Fase B.
// ---------------------------------------------------------------------------
function renderAdministracaoGate(root: HTMLElement): void {
  const { profile } = getAuthState();
  if (!isManagerOrAdmin(profile)) {
    root.innerHTML = `
      <section class="profile-screen">
        <div class="card">
          ${backButton()}
          <div class="empty-state">
            ${Icon.lock}
            <p>Acesso restrito aos administradores do GoScan.</p>
          </div>
        </div>
      </section>`;
    wireBack(root, "/perfil/configuracoes");
    return;
  }

  root.innerHTML = `
    <section class="profile-screen">
      <div class="card">
        ${backButton()}
        <h2>Administração</h2>
        <p class="hint-text">O painel completo (usuários, permissões, auditoria) chega na próxima etapa desta expansão.</p>
      </div>
    </section>`;
  wireBack(root, "/perfil/configuracoes");
}
