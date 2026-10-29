/*
 * Rateio dos creditos da usina entre as unidades consumidoras (UCs).
 *
 * Cada planilha enviada vira uma "versao" do rateio, valida a partir de um mes
 * de referencia (geracao daquele mes em diante), ate a proxima versao.
 * Os creditos de cada UC num mes = geracao da usina no mes x % da UC.
 *
 * Fica so no banco do painel (protegido pela senha); nunca no repositorio,
 * porque a lista tem CPF/CNPJ dos titulares.
 */

import { getEnv } from "@/lib/env";
import { getSemsProductionHistory, getStationToday } from "@/lib/sems/client";
import { hashToObject, isStorageConfigured, parseJson, redis } from "@/lib/storage";

const KEY_VERSIONS = "solee:rateio:versions";
const KEY_NAMES = "solee:rateio:names";

export type RateioEntry = { uc: string; doc: string; pct: number | null; order: number };

export type RateioVersion = {
  id: string;
  /** Mes de referencia da geracao a partir do qual vale (AAAA-MM). */
  effectiveMonth: string;
  requestDate: string | null;
  ugUc: string | null;
  enquadramento: string | null;
  forma: string | null;
  fileName: string | null;
  uploadedAt: string;
  totalPct: number;
  entries: RateioEntry[];
};

export type RateioData = {
  configured: boolean;
  tariff: number;
  today: string;
  versions: RateioVersion[];
  /** Apelido de cada UC (chave = so os digitos da UC). */
  names: Record<string, string>;
  /** Geracao total da usina por mes, desde a primeira vigencia (e o mes anterior a ela). */
  months: Array<{ month: string; kwh: number; partial: boolean }>;
};

export const ucKey = (uc: string) => uc.replace(/\D/g, "");

function addMonths(month: string, count: number) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + count, 1)).toISOString().slice(0, 7);
}

export async function getRateioData(): Promise<RateioData> {
  const tariff = getEnv().TARIFA_KWH;
  const today = getStationToday();
  if (!isStorageConfigured()) {
    return { configured: false, tariff, today, versions: [], names: {}, months: [] };
  }

  const [rawVersions, rawNames] = await redis([
    ["HGETALL", KEY_VERSIONS],
    ["HGETALL", KEY_NAMES],
  ]);
  const versions = Object.values(hashToObject(rawVersions))
    .map((json) => parseJson<RateioVersion>(json))
    .filter((version): version is RateioVersion => version !== null)
    .sort((a, b) => a.effectiveMonth.localeCompare(b.effectiveMonth) || a.uploadedAt.localeCompare(b.uploadedAt));

  const currentMonth = today.slice(0, 7);
  let months: RateioData["months"] = [];
  const firstMonth = versions[0]?.effectiveMonth;
  // Geracao desde o mes anterior a primeira vigencia (base da estimativa) ate hoje.
  const start = addMonths(firstMonth && firstMonth < currentMonth ? firstMonth : currentMonth, -1);
  try {
    const rows = await getSemsProductionHistory("month", `${start}-01`, today);
    months = rows.map((row) => ({
      month: row.date.slice(0, 7),
      kwh: Number(row.generationKwh.toFixed(1)),
      partial: row.date.slice(0, 7) === currentMonth,
    }));
  } catch (error) {
    console.error("Rateio: falha ao ler a geracao mensal", error);
  }

  return { configured: true, tariff, today, versions, names: hashToObject(rawNames), months };
}

function sanitizeText(value: unknown, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : null;
}

/** Valida e salva uma nova versao do rateio (vinda da planilha). */
export async function saveRateioVersion(input: unknown): Promise<RateioVersion> {
  const body = (input ?? {}) as Record<string, unknown>;
  const effectiveMonth = sanitizeText(body.effectiveMonth, 7);
  if (!effectiveMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)) {
    throw new Error("Informe o mês de vigência (AAAA-MM).");
  }
  if (!Array.isArray(body.entries) || !body.entries.length || body.entries.length > 5_000) {
    throw new Error("A lista de UCs está vazia ou é grande demais.");
  }

  const seen = new Set<string>();
  const entries: RateioEntry[] = [];
  for (const [index, raw] of body.entries.entries()) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const uc = sanitizeText(item.uc, 40);
    if (!uc || !ucKey(uc)) throw new Error(`UC inválida na linha ${index + 1}.`);
    if (seen.has(ucKey(uc))) continue;
    seen.add(ucKey(uc));
    const pct = item.pct === null || item.pct === undefined ? null : Number(item.pct);
    if (pct !== null && (!Number.isFinite(pct) || pct < 0 || pct > 1)) {
      throw new Error(`Percentual inválido para a UC ${uc}.`);
    }
    entries.push({ uc, doc: sanitizeText(item.doc, 30) ?? "", pct, order: Number(item.order) || index + 1 });
  }

  const now = new Date();
  const version: RateioVersion = {
    id: `${effectiveMonth}-${now.getTime()}`,
    effectiveMonth,
    requestDate: sanitizeText(body.requestDate, 10),
    ugUc: sanitizeText(body.ugUc, 40),
    enquadramento: sanitizeText(body.enquadramento),
    forma: sanitizeText(body.forma),
    fileName: sanitizeText(body.fileName, 200),
    uploadedAt: now.toISOString(),
    totalPct: Number(entries.reduce((sum, entry) => sum + (entry.pct ?? 0), 0).toFixed(6)),
    entries,
  };

  // Nomes dos clientes vindos da planilha (substituem os apelidos dessas UCs).
  const commands: Array<Array<string | number>> = [["HSET", KEY_VERSIONS, version.id, JSON.stringify(version)]];
  if (body.names && typeof body.names === "object") {
    for (const [uc, name] of Object.entries(body.names as Record<string, unknown>)) {
      const clean = sanitizeText(name, 80);
      if (clean && seen.has(ucKey(uc))) commands.push(["HSET", KEY_NAMES, ucKey(uc), clean]);
    }
  }
  await redis(commands);
  return version;
}

export async function deleteRateioVersion(id: string) {
  if (!/^\d{4}-\d{2}-\d{13}$/.test(id)) throw new Error("Versão inválida.");
  await redis([["HDEL", KEY_VERSIONS, id]]);
}

/** Muda o mes de vigencia de uma versao ja salva. */
export async function updateRateioVersionMonth(id: string, effectiveMonth: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(effectiveMonth)) throw new Error("Mês inválido.");
  const [raw] = await redis([["HGET", KEY_VERSIONS, id]]);
  const version = parseJson<RateioVersion>(raw);
  if (!version) throw new Error("Versão não encontrada.");
  version.effectiveMonth = effectiveMonth;
  await redis([["HSET", KEY_VERSIONS, id, JSON.stringify(version)]]);
  return version;
}

/** Salva os nomes de varios clientes de uma vez (vindos de uma planilha). */
export async function setUcNames(names: Record<string, unknown>) {
  const commands: Array<Array<string | number>> = [];
  for (const [uc, name] of Object.entries(names).slice(0, 5_000)) {
    const clean = sanitizeText(name, 80);
    if (clean && ucKey(uc)) commands.push(["HSET", KEY_NAMES, ucKey(uc), clean]);
  }
  if (commands.length) await redis(commands);
  return { saved: commands.length };
}

/** Salva (ou apaga, se vazio) o apelido de uma UC. */
export async function setUcName(uc: string, name: string) {
  const key = ucKey(uc);
  if (!key) throw new Error("UC inválida.");
  const clean = name.trim().slice(0, 80);
  await redis([clean ? ["HSET", KEY_NAMES, key, clean] : ["HDEL", KEY_NAMES, key]]);
  return { uc: key, name: clean };
}
