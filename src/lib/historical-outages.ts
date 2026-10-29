/*
 * Reconstrucao de paradas passadas (antes do monitoramento ao vivo) a partir
 * da geracao diaria da usina guardada no SEMS+.
 *
 * Para cada dia calcula quanto a usina DEVERIA ter gerado:
 *  - com clima: radiacao solar do dia (Open-Meteo, dados historicos) x
 *    rendimento tipico da usina (kWh gerados por MJ/m2, mediana de +-30 dias
 *    sem os dias com problema). Assim um dia chuvoso nao vira "parada".
 *  - sem clima disponivel: mediana da geracao dos dias normais em +-30 dias
 *    (nesse caso so marca dias com a usina praticamente parada).
 *
 * Dias com geracao < 10% do esperado viram "Usina parada"; dias com menos de
 * 70% (so com clima) viram "Geracao abaixo do esperado" (inversor parado, string
 * aberta etc.). A perda e esperado - gerado.
 *
 * O SEMS+ so guarda o total da usina por dia, entao estes registros valem para
 * a usina inteira e nao tem horario exato de inicio/fim.
 */

import { getEnv } from "@/lib/env";
import { localDay, type Outage } from "@/lib/monitor";
import { getSemsProductionHistory } from "@/lib/sems/client";
import { hashToObject, isStorageConfigured, parseJson, redis } from "@/lib/storage";

const LOCATION = { latitude: -9.22305, longitude: -37.37936 };
const KEY_OVERRIDES = "solee:hist:overrides";
const cacheKey = (year: string, skip: string) => `solee:hist:${year}:${skip}`;
const CACHE_SECONDS = 6 * 3600;
const SUN_MINUTES = 12 * 60;
const DOWN_RATIO = 0.1;
const LOW_RATIO = 0.7;
const WINDOW_DAYS = 30;

export type HistoricalAnalysis = {
  outages: Outage[];
  /** Dias analisados (com dado de geracao no SEMS+). */
  analyzedDays: string[];
  method: "clima" | "mediana" | null;
  error?: string;
};

function addDays(day: string, days: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

/** Radiacao solar diaria (MJ/m2) do local da usina, direto da Open-Meteo. */
async function fetchRadiationFromApi(start: string, end: string) {
  const params = `latitude=${LOCATION.latitude}&longitude=${LOCATION.longitude}&daily=shortwave_radiation_sum&timezone=America%2FMaceio`;
  const result = new Map<string, number>();
  const read = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!response.ok) throw new Error(`Open-Meteo respondeu HTTP ${response.status}.`);
    const data = (await response.json()) as { daily?: { time?: string[]; shortwave_radiation_sum?: Array<number | null> } };
    data.daily?.time?.forEach((day, index) => {
      const value = data.daily?.shortwave_radiation_sum?.[index];
      if (typeof value === "number" && value > 0 && day >= start && day <= end) result.set(day, value);
    });
  };

  // O arquivo historico atrasa alguns dias (e recusa datas alem disso); os ultimos
  // 92 dias vem da API de previsao, que aceita dias passados.
  const today = localDay(Date.now());
  const archiveEnd = addDays(today, -8) < end ? addDays(today, -8) : end;
  const recentStart = addDays(today, -90);
  if (start <= archiveEnd && start < recentStart) {
    await read(`https://archive-api.open-meteo.com/v1/archive?${params}&start_date=${start}&end_date=${archiveEnd}`);
  }
  if (end >= recentStart) {
    await read(`https://api.open-meteo.com/v1/forecast?${params}&past_days=92&forecast_days=1`);
  }
  return result;
}

/**
 * Radiacao com banco: dias com mais de 10 dias (ja consolidados no arquivo) ficam
 * salvos em solee:radiation:<ano>; so os recentes e os que faltam vao na API.
 */
async function fetchRadiation(start: string, end: string) {
  if (!isStorageConfigured()) return fetchRadiationFromApi(start, end);

  const finalLimit = addDays(localDay(Date.now()), -10);
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  const years = [...new Set(days.map((day) => day.slice(0, 4)))];
  const stored = (await redis(years.map((year) => ["HGETALL", `solee:radiation:${year}`]))).map(hashToObject);
  const result = new Map<string, number>();
  stored.forEach((hash) => Object.entries(hash).forEach(([day, value]) => result.set(day, Number(value))));

  const missing = days.filter((day) => !result.has(day));
  if (!missing.length) return result;

  const fetched = await fetchRadiationFromApi(missing[0], missing.at(-1) as string);
  const commands: Array<Array<string | number>> = [];
  for (const [day, value] of fetched) {
    if (result.has(day)) continue;
    result.set(day, value);
    if (day <= finalLimit) commands.push(["HSET", `solee:radiation:${day.slice(0, 4)}`, day, value]);
  }
  if (commands.length) await redis(commands);
  return result;
}

async function analyze(year: string, skipDays: Set<string>, inverterCount: number, tariff: number): Promise<HistoricalAnalysis> {
  const today = localDay(Date.now());
  const yesterday = addDays(today, -1);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31` < yesterday ? `${year}-12-31` : yesterday;
  if (yearEnd < yearStart) return { outages: [], analyzedDays: [], method: null };

  const fetchStart = addDays(yearStart, -WINDOW_DAYS);
  const fetchEnd = addDays(yearEnd, WINDOW_DAYS) < yesterday ? addDays(yearEnd, WINDOW_DAYS) : yesterday;

  const rows = await getSemsProductionHistory("day", fetchStart, fetchEnd);
  const generation = new Map(rows.map((row) => [row.date.slice(0, 10), row.generationKwh]));
  const firstDay = rows.find((row) => row.generationKwh > 0)?.date.slice(0, 10);
  if (!firstDay) return { outages: [], analyzedDays: [], method: null };

  let radiation: Map<string, number> | null = null;
  let error: string | undefined;
  try {
    radiation = await fetchRadiation(fetchStart, fetchEnd);
    if (radiation.size < 30) radiation = null;
  } catch (err) {
    error = `Clima historico indisponivel (${err instanceof Error ? err.message : "erro"}); usando so a mediana da geracao.`;
  }

  const allDays: string[] = [];
  for (let day = firstDay > fetchStart ? firstDay : fetchStart; day <= fetchEnd; day = addDays(day, 1)) allDays.push(day);

  // Rendimento (kWh por MJ/m2) e geracao "normal" em janelas de +-30 dias.
  const ratioOf = (day: string) => {
    const gen = generation.get(day) ?? 0;
    const rad = radiation?.get(day) ?? 0;
    return gen > 0 && rad > 0 ? gen / rad : null;
  };
  const windowDays = (day: string) => allDays.filter((other) => Math.abs(Date.parse(other) - Date.parse(day)) <= WINDOW_DAYS * 86_400_000);

  function expectedFor(day: string): number {
    const window = windowDays(day);
    if (radiation?.has(day)) {
      const ratios = window.map(ratioOf).filter((value): value is number => value !== null);
      const center = median(ratios);
      // ignora dias com problema (rendimento muito abaixo do normal) para nao puxar o esperado para baixo
      const healthy = ratios.filter((value) => value >= 0.75 * center);
      const ratio = median(healthy.length >= 5 ? healthy : ratios);
      if (ratio > 0) return ratio * (radiation.get(day) ?? 0);
    }
    const gens = window.map((other) => generation.get(other) ?? 0).filter((value) => value > 0);
    const center = median(gens);
    return median(gens.filter((value) => value >= 0.6 * center));
  }

  const method: HistoricalAnalysis["method"] = radiation ? "clima" : "mediana";
  const typical = median(allDays.map((day) => generation.get(day) ?? 0).filter((value) => value > 0));
  const outages: Outage[] = [];
  const analyzedDays: string[] = [];
  const start = firstDay > yearStart ? firstDay : yearStart;

  for (let day = start; day <= yearEnd; day = addDays(day, 1)) {
    analyzedDays.push(day);
    if (skipDays.has(day)) continue;

    const expected = expectedFor(day);
    if (expected <= 0) continue;
    const hasRecord = generation.has(day);
    const actual = generation.get(day) ?? 0;
    const lost = expected - actual;
    const down = actual < DOWN_RATIO * expected;
    const low = method === "clima" && actual < LOW_RATIO * expected && lost > 0.08 * typical;
    if (!down && !low) continue;

    const lostFraction = Math.min(1, lost / expected);
    const startMs = Date.parse(`${day}T05:30:00-03:00`);
    const minutes = Math.round(lostFraction * SUN_MINUTES);
    outages.push({
      id: `hist-${day}`,
      sn: "usina",
      name: "Usina inteira",
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + minutes * 60_000).toISOString(),
      lastCheck: new Date(startMs + minutes * 60_000).toISOString(),
      lastExpectedKw: 0,
      expectedKwh: round(expected, 1),
      daylightMinutes: minutes,
      dayKwhAtStart: 0,
      startDay: day,
      reason: down ? "Usina parada" : "Geração abaixo do esperado",
      method: "curva",
      checks: 0,
      actualKwh: round(actual, 1),
      lostKwh: round(lost, 1),
      lostBrl: round(lost * tariff, 2),
      tariff,
      kind: "historico",
      inverterCount,
      missingRecord: !hasRecord || undefined,
    });
  }

  return { outages, analyzedDays, method, error };
}

/**
 * Paradas reconstruidas de um ano. `skipDays` sao dias ja cobertos pelo
 * monitoramento ao vivo (nao sao reanalisados para nao contar em dobro).
 */
export async function getHistoricalOutages(
  year: string,
  skipDays: Set<string>,
  inverterCount: number,
): Promise<HistoricalAnalysis> {
  const tariff = getEnv().TARIFA_KWH;
  const storage = isStorageConfigured();
  const skipKey = `${inverterCount}:${[...skipDays].filter((day) => day.startsWith(year)).length}:${localDay(Date.now())}`;

  let analysis: HistoricalAnalysis | null = null;
  if (storage) {
    const [cached] = await redis([["GET", cacheKey(year, skipKey)]]);
    analysis = parseJson<HistoricalAnalysis>(cached);
  }
  if (!analysis) {
    analysis = await analyze(year, skipDays, inverterCount, tariff);
    if (storage && analysis.method) {
      await redis([["SET", cacheKey(year, skipKey), JSON.stringify(analysis), "EX", CACHE_SECONDS]]);
    }
  }

  // Observacoes e "ignorar" feitos pelo usuario.
  if (storage && analysis.outages.length) {
    const [raw] = await redis([["HGETALL", KEY_OVERRIDES]]);
    const overrides = hashToObject(raw);
    analysis.outages = analysis.outages.map((outage) => {
      const override = parseJson<{ note?: string; ignored?: boolean }>(overrides[outage.id]);
      return override ? { ...outage, ...override } : outage;
    });
  }
  return analysis;
}

export async function updateHistoricalOutage(id: string, changes: { note?: string; ignored?: boolean }) {
  if (!/^hist-\d{4}-\d{2}-\d{2}$/.test(id)) throw new Error("Registro invalido.");
  const [raw] = await redis([["HGET", KEY_OVERRIDES, id]]);
  const current = parseJson<{ note?: string; ignored?: boolean }>(raw) ?? {};
  if (changes.note !== undefined) current.note = changes.note.slice(0, 500);
  if (changes.ignored !== undefined) current.ignored = changes.ignored;
  await redis([["HSET", KEY_OVERRIDES, id, JSON.stringify(current)]]);
  return { id, ...current };
}
