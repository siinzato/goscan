// EXPANSÃO GOSCAN — Preferências de som/voz/vibração/comandos de voz da
// Conferência Colaborativa (seção 19 do pedido). Lidas de
// profiles.conference_preferences (só o que o usuário explicitamente
// sobrescreveu NESTE dispositivo/conta) com fallback pro padrão da empresa
// (companies.default_conference_preferences) — nunca perde a herança do
// padrão da empresa pra campos que o usuário nunca tocou.
import { getSupabase } from "./supabaseClient.ts";
import { getAuthState } from "./auth.ts";
import { setSoundPreferences } from "./soundManager.ts";
import { setVoicePreferences } from "./voiceFeedback.ts";
import { setVibrationEnabled } from "./vibrationFeedback.ts";

export interface ConferencePreferences {
  soundsEnabled: boolean;
  /** 0..1 */
  soundVolume: number;
  voiceEnabled: boolean;
  speakProductName: boolean;
  vibrationEnabled: boolean;
  voiceCommandsEnabled: boolean;
  notifyItemCompleted: boolean;
  notifyExcess: boolean;
  notifyConflict: boolean;
}

export const DEFAULT_CONFERENCE_PREFERENCES: ConferencePreferences = {
  soundsEnabled: true,
  soundVolume: 0.6,
  voiceEnabled: true,
  speakProductName: true,
  vibrationEnabled: true,
  voiceCommandsEnabled: true,
  notifyItemCompleted: true,
  notifyExcess: true,
  notifyConflict: true,
};

let companyDefault: Partial<ConferencePreferences> = {};
let storedOverride: Partial<ConferencePreferences> = {};
let current: ConferencePreferences = { ...DEFAULT_CONFERENCE_PREFERENCES };
let loaded = false;

function recompute(): ConferencePreferences {
  current = { ...DEFAULT_CONFERENCE_PREFERENCES, ...companyDefault, ...storedOverride };
  setSoundPreferences({ enabled: current.soundsEnabled, volume: current.soundVolume });
  setVoicePreferences({ enabled: current.voiceEnabled, speakProductName: current.speakProductName });
  setVibrationEnabled(current.vibrationEnabled);
  return current;
}

/** Valor já resolvido (empresa + usuário) — síncrono, sempre disponível mesmo antes do load (usa o default seguro). */
export function getConferencePreferences(): ConferencePreferences {
  return current;
}

interface ProfilePrefsRow {
  conference_preferences: Partial<ConferencePreferences> | null;
}
interface CompanyPrefsRow {
  default_conference_preferences: Partial<ConferencePreferences> | null;
}

/**
 * Carrega profiles.conference_preferences + companies.default_conference_preferences
 * e sincroniza os módulos de feedback (soundManager/voiceFeedback/vibrationFeedback).
 * Idempotente/barato: só refaz a consulta se ainda não tiver carregado nesta sessão do app.
 */
export async function loadConferencePreferences(force = false): Promise<ConferencePreferences> {
  if (loaded && !force) return current;
  const { profile } = getAuthState();
  if (!profile) return current;

  const supabase = getSupabase();
  const [{ data: profileRow }, { data: companyRow }] = await Promise.all([
    supabase.from("profiles").select("conference_preferences").eq("id", profile.id).maybeSingle(),
    supabase.from("companies").select("default_conference_preferences").eq("id", profile.company_id).maybeSingle(),
  ]);

  companyDefault = (companyRow as CompanyPrefsRow | null)?.default_conference_preferences ?? {};
  storedOverride = (profileRow as ProfilePrefsRow | null)?.conference_preferences ?? {};
  loaded = true;
  return recompute();
}

/** Salva só os campos alterados (mescla no override existente) — nunca grava o objeto inteiro resolvido, senão o usuário perderia a herança do padrão da empresa nos campos que nunca tocou. */
export async function saveMyConferencePreferences(patch: Partial<ConferencePreferences>): Promise<void> {
  const { profile } = getAuthState();
  if (!profile) return;
  storedOverride = { ...storedOverride, ...patch };
  recompute();
  const supabase = getSupabase();
  const { error } = await supabase.from("profiles").update({ conference_preferences: storedOverride }).eq("id", profile.id);
  if (error) throw error;
}

/** "Restaurar padrão" — volta a usar 100% o padrão da empresa (ou o padrão geral, se a empresa também não tiver definido nada). */
export async function resetMyConferencePreferences(): Promise<void> {
  const { profile } = getAuthState();
  if (!profile) return;
  storedOverride = {};
  recompute();
  const supabase = getSupabase();
  const { error } = await supabase.from("profiles").update({ conference_preferences: null }).eq("id", profile.id);
  if (error) throw error;
}
