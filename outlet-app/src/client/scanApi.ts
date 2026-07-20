// Modo Scan — Parte 4: chama o serviço real de reconhecimento (Parte 3).
// Tipos espelham src/server/scanRecognize.ts (cliente e servidor não
// compartilham módulos — cada lado importa só o que roda no seu ambiente).
import { authedPost } from "./backendAuthClient.ts";

export type ConfidenceLevel = "high" | "medium" | "low" | "none";

export interface RecognizeCandidate {
  product_id: string;
  variant_id: string | null;
  sku_outlet: string;
  nome: string;
  imagem: string | null;
  storage_path: string | null;
  capacity_ml: number | null;
  visual_family_key: string | null;
  variant_key: string | null;
  score: number;
  confidence_level: ConfidenceLevel;
  from_family_expansion: boolean;
}

export interface RecognizeResult {
  recognition_id: string;
  status: "matched" | "ambiguous" | "no_result";
  confidence_level: ConfidenceLevel;
  candidates: RecognizeCandidate[];
  visual_family: string | null;
  variant: string | null;
  requires_capacity_selection: boolean;
  processing_time_ms: number;
  used_pgvector: boolean;
}

export function recognizeFrame(conferenceId: string, imageBase64: string): Promise<RecognizeResult> {
  return authedPost<RecognizeResult>("/api/scan/recognize", { conference_id: conferenceId, image_base64: imageBase64 });
}
