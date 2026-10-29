import { createHash } from "node:crypto";

import { getEnv } from "@/lib/env";
import { hashToObject, isStorageConfigured, redis } from "@/lib/storage";
import type {
  SemsDailyPoint,
  SemsHourlyPoint,
  SemsInverter,
  SemsPlantSnapshot,
} from "@/lib/sems/types";

/*
 * Cliente do GoodWe SEMS+.
 *
 * Em setembro de 2026 a GoodWe migrou o SEMS Portal para o SEMS+. As rotas
 * antigas (`www.semsportal.com/api/...`, `PowerStationMonitor/...`,
 * `v2/PowerStation/GetMonitorDetailByPowerstationId`) passaram a responder
 * HTTP 200 com `data` vazio ou erro, e o dashboard ficou com zeros/dados
 * antigos. Este cliente usa a API Web do SEMS+ (a mesma usada por
 * semsplus.goodwe.com), com base na integracao comunitaria do Home Assistant:
 * https://github.com/TimSoethout/goodwe-sems-home-assistant
 */

const LOGIN_URL = "https://semsplus.goodwe.com/web/sems/sems-user/api/v1/auth/cross-login";
const FALLBACK_API_BASE = "https://eu-gateway.semsportal.com/web/sems";
const SUCCESS_CODES = new Set(["0", "00000"]);
const AUTH_EXPIRED_CODES = new Set(["100002", "C0602"]);
const RATE_LIMIT_CODE = "GY0429";
const REQUEST_TIMEOUT_MS = 8_000;
const TOKEN_TTL_MS = 30 * 60_000;
const STATION_TIMEZONE = "America/Maceio";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

type WebToken = Record<string, unknown> & { api: string; uid?: unknown; token?: unknown };

type SemsEnvelope<T> = {
  code?: unknown;
  msg?: unknown;
  description?: unknown;
  api?: unknown;
  data?: T;
};

class SemsApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let cachedToken: { token: WebToken; expiresAt: number } | null = null;

// ---------- utilitarios ----------

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const match = value.replace(",", ".").match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }
  return 0;
}

function parseString(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function resolveStatusLabel(status: unknown): string {
  const numeric = typeof status === "string" && /^-?\d+$/.test(status) ? Number(status) : status;
  if (typeof numeric === "number") {
    // Codigos do SEMS (portal antigo e SEMS+): 1 e 5 = normal, 0 e 3 = aguardando.
    if (numeric === 1 || numeric === 5) return "Gerando";
    if (numeric === 0 || numeric === 3) return "Standby";
    if (numeric === -1) return "Offline";
    if (numeric === 2) return "Falha";
    return `Status ${numeric}`;
  }
  return parseString(status, "Indefinido");
}

/** Data/hora no fuso da usina, no formato aceito pelo SEMS+ ("YYYY-MM-DD HH:mm:ss"). */
function localDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: STATION_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(dateStr: string, days: number) {
  const date = new Date(`${dateStr}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function md5Base64(password: string) {
  const hex = createHash("md5").update(password, "utf8").digest("hex");
  return Buffer.from(hex, "utf8").toString("base64");
}

function signature(token: Record<string, unknown>) {
  const epochMs = Date.now();
  const digest = createHash("sha256")
    .update(`${epochMs}@${parseString(token.uid)}@${parseString(token.token)}`)
    .digest("hex");
  return Buffer.from(`${digest}@${epochMs}`, "utf8").toString("base64");
}

async function fetchJson<T>(url: string, init: RequestInit): Promise<SemsEnvelope<T>> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status === 429) {
    throw new SemsApiError("SEMS+ limitou as requisicoes (HTTP 429). Tente novamente em alguns minutos.", RATE_LIMIT_CODE);
  }
  if (!response.ok) {
    throw new SemsApiError(`SEMS+ respondeu HTTP ${response.status} em ${new URL(url).pathname}.`);
  }

  return (await response.json()) as SemsEnvelope<T>;
}

function assertSuccess(payload: SemsEnvelope<unknown>, operation: string) {
  const code = parseString(payload.code);
  if (SUCCESS_CODES.has(code)) return;

  const message = parseString(payload.msg) || parseString(payload.description) || "erro desconhecido";
  if (code === RATE_LIMIT_CODE) {
    throw new SemsApiError(`SEMS+ limitou as requisicoes em ${operation}. Tente novamente em alguns minutos.`, code);
  }
  throw new SemsApiError(`${operation} falhou (codigo ${code || "?"}: ${message}).`, code);
}

// ---------- autenticacao ----------

async function login(): Promise<WebToken> {
  const env = getEnv();
  const payload = await fetchJson<Record<string, unknown>>(LOGIN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Origin: "https://semsplus.goodwe.com",
      Referer: "https://semsplus.goodwe.com/",
      Token: '{"uid":"","timestamp":0,"token":"","client":"semsPlusWeb","version":"","language":"en"}',
      "X-Signature": signature({}),
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      account: env.SEMS_USER,
      pwd: md5Base64(env.SEMS_PASS),
      agreement: 1,
      isChinese: false,
      isLocal: false,
    }),
  });

  try {
    assertSuccess(payload, "Login no SEMS+");
  } catch (error) {
    throw new SemsApiError(
      `${(error as Error).message} Confira SEMS_USER/SEMS_PASS e se a conta entra em https://semsplus.goodwe.com (aceite os termos la uma vez).`,
      (error as SemsApiError).code,
    );
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  if (!parseString(data.token)) {
    throw new SemsApiError("Login no SEMS+ nao retornou token.");
  }

  const api = parseString(payload.api) || parseString(data.api) || FALLBACK_API_BASE;
  return { ...data, api: api.replace(/\/+$/, "") };
}

async function getToken(forceRefresh = false) {
  if (!forceRefresh && cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  const token = await login();
  cachedToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

async function webRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; operation: string },
  retried = false,
): Promise<T> {
  const token = await getToken(retried);
  const payload = await fetchJson<T>(`${token.api}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      token: JSON.stringify(token),
      "X-Signature": signature(token),
      "User-Agent": USER_AGENT,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const code = parseString(payload.code);
  if (AUTH_EXPIRED_CODES.has(code) && !retried) {
    cachedToken = null;
    return webRequest<T>(path, options, true);
  }

  assertSuccess(payload, options.operation);
  return payload.data as T;
}

// ---------- endpoints ----------

type StationRow = Record<string, unknown>;

async function listStations(): Promise<StationRow[]> {
  const data = await webRequest<{ dataList?: StationRow[] }>("/sems-plant/api/portal/stations/page", {
    method: "POST",
    body: { current: 1, size: 100 },
    operation: "Lista de usinas",
  });
  return Array.isArray(data?.dataList) ? data.dataList : [];
}

async function getStationFlow(stationId: string) {
  return webRequest<Record<string, unknown>>(
    `/sems-plant/api/stations/flow?stationId=${encodeURIComponent(stationId)}`,
    { operation: "Fluxo de potencia" },
  );
}

type DeviceInfo = { sn: string; name: string; status: unknown; deviceType: string };

async function getInverterDevices(stationId: string): Promise<DeviceInfo[]> {
  const data = await webRequest<{ deviceDetailList?: Array<Record<string, unknown>> }>(
    `/sems-plant/api/stations/device/all-status?stationId=${encodeURIComponent(stationId)}`,
    { operation: "Lista de inversores" },
  );

  const devices: DeviceInfo[] = [];
  for (const group of data?.deviceDetailList ?? []) {
    const deviceType = parseString(group.deviceType);
    if (deviceType !== "INVERTER" && deviceType !== "ENERGY_STORAGE_INTEGRATED_CABINET") continue;

    const statusGroups = Array.isArray(group.statusDetailList) ? group.statusDetailList : [];
    for (const statusGroup of statusGroups as Array<Record<string, unknown>>) {
      const detailMap = (statusGroup.detailMap ?? {}) as Record<string, Record<string, unknown>>;
      const snList = Array.isArray(statusGroup.snList) ? statusGroup.snList : [];
      for (const sn of snList) {
        if (typeof sn !== "string") continue;
        const detail = detailMap[sn] ?? {};
        devices.push({
          sn,
          name: parseString(detail.name, sn),
          status: statusGroup.status ?? detail.status,
          deviceType,
        });
      }
    }
  }
  return devices;
}

/** Achata os grupos de "factors" do SEMS+ em { codigo: valor }. */
function flattenFactors(data: unknown) {
  const factors: Record<string, unknown> = {};
  for (const group of Array.isArray(data) ? data : []) {
    const list = (group as { factors?: unknown }).factors;
    for (const factor of Array.isArray(list) ? list : []) {
      const record = factor as Record<string, unknown>;
      const code = parseString(record.code);
      if (code && !(code in factors)) factors[code] = record.data;
    }
  }
  return factors;
}

async function getInverterCounters(stationId: string, device: DeviceInfo): Promise<SemsInverter> {
  const data = await webRequest<unknown>(
    `/sems-plant/api/equipments/${encodeURIComponent(device.sn)}/telecounting?deviceType=${device.deviceType}&pwId=${encodeURIComponent(stationId)}`,
    { operation: `Contadores do inversor ${device.sn}` },
  );
  const factors = flattenFactors(data);

  return {
    id: device.sn,
    name: device.name,
    serialNumber: device.sn,
    status: resolveStatusLabel(device.status),
    powerKw: parseNumber(factors.pAc),
    dayGenerationKwh: parseNumber(factors.proPvStatsToday),
    monthGenerationKwh: parseNumber(factors.proPvStatsMonth),
    totalGenerationKwh: parseNumber(factors.proPvStatsTotal),
    ratedPowerKw: parseNumber(factors.ratedPower) || undefined,
  };
}

/**
 * Producao por dia ("day") ou por mes ("month") entre duas datas.
 * Retorna a serie `proSystemTotalStats` (geracao da usina em kWh).
 */
async function getProductionSeries(
  stationId: string,
  dimension: "day" | "month",
  startDate: string,
  endDate: string,
): Promise<SemsDailyPoint[]> {
  const data = await webRequest<{ dataList?: Array<Record<string, unknown>> }>(
    "/sems-plant/api/stations/statistics",
    {
      method: "POST",
      body: {
        stationId,
        isReport: false,
        items: ["proSystemTotalStats"],
        dimension,
        startTime: `${startDate} 00:00:00`,
        endTime: `${endDate} 23:59:59`,
      },
      operation: `Historico por ${dimension === "day" ? "dia" : "mes"}`,
    },
  );

  const series = (data?.dataList ?? []).find((item) => item.item === "proSystemTotalStats");
  const rows = Array.isArray(series?.statisticsList) ? series.statisticsList : [];

  return (rows as Array<Record<string, unknown>>)
    .map((row) => {
      const date = parseString(row.date);
      // "2026-09-24" ou "2026-09" -> ISO ao meio-dia para nao "voltar" um dia por causa do fuso.
      const iso = /^\d{4}-\d{2}$/.test(date) ? `${date}-01T12:00:00.000Z` : `${date.slice(0, 10)}T12:00:00.000Z`;
      return { date: date ? iso : "", generationKwh: parseNumber(row.val) };
    })
    .filter((row) => row.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- curva de potencia do dia ----------

/*
 * O SEMS+ ainda nao tem rota publica conhecida para a curva de potencia do dia.
 * Por isso a curva e montada a partir das leituras de potencia que o proprio
 * dashboard faz (a cada atualizacao). Ela recomeca a cada dia e enquanto o
 * servidor estiver ativo; numa hospedagem serverless pode ter lacunas.
 */
const powerReadings = new Map<string, SemsHourlyPoint[]>();

function recordPowerReading(stationId: string, powerKw: number, at: Date) {
  const day = localDate(at);
  const key = `${stationId}:${day}`;
  for (const existing of powerReadings.keys()) {
    if (existing.startsWith(`${stationId}:`) && existing !== key) powerReadings.delete(existing);
  }
  const points = powerReadings.get(key) ?? [];
  const last = points.at(-1);
  if (!last || at.getTime() - new Date(last.timestamp).getTime() >= 60_000) {
    points.push({ timestamp: at.toISOString(), powerKw });
  }
  powerReadings.set(key, points.slice(-1_440));
  return [...points];
}

// ---------- snapshot ----------

function todayFromLive(station: StationRow | undefined, inverters: SemsInverter[]) {
  return (
    parseNumber(station?.productionToday) ||
    inverters.reduce((total, inv) => total + inv.dayGenerationKwh, 0)
  );
}

async function optional<T>(promise: Promise<T>, fallback: T, label: string, errors: string[]) {
  try {
    return await promise;
  } catch (error) {
    errors.push(`[${label}: ${error instanceof Error ? error.message : String(error)}]`);
    return fallback;
  }
}

let stationCache: { expiresAt: number; id: string; row: StationRow | undefined; warning?: string } | null = null;

/** Descobre a usina (SEMS_PLANT_ID ou a primeira da conta), com cache de 10 minutos. */
async function resolveStation(forceRefresh = false) {
  if (!forceRefresh && stationCache && Date.now() < stationCache.expiresAt) return stationCache;

  const env = getEnv();
  const stations = await listStations();
  const row = env.SEMS_PLANT_ID
    ? stations.find((item) => parseString(item.id) === env.SEMS_PLANT_ID)
    : stations[0];
  const id = env.SEMS_PLANT_ID || parseString(row?.id);

  if (!id) {
    throw new SemsApiError("Nenhuma usina encontrada na conta SEMS+.");
  }

  stationCache = {
    expiresAt: Date.now() + 10 * 60_000,
    id,
    row,
    warning:
      env.SEMS_PLANT_ID && !row
        ? `[A usina ${env.SEMS_PLANT_ID} nao apareceu na lista da conta; confira SEMS_PLANT_ID.]`
        : undefined,
  };
  return stationCache;
}

// ---------- historico por periodo ----------

/** Quebra o intervalo em blocos: mes a mes (dimensao dia) ou ano a ano (dimensao mes). */
function splitRange(dimension: "day" | "month", start: string, end: string) {
  const chunks: Array<[string, string]> = [];
  let cursor = start;
  while (cursor <= end) {
    const [year, month] = cursor.split("-").map(Number);
    const chunkEnd =
      dimension === "day"
        ? new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
        : `${year}-12-31`;
    const last = chunkEnd < end ? chunkEnd : end;
    chunks.push([cursor, last]);
    cursor = addDays(last, 1);
  }
  return chunks;
}

const historyCache = new Map<string, { expiresAt: number; data: SemsDailyPoint[] }>();

/**
 * Producao da usina entre duas datas (YYYY-MM-DD), por dia ou por mes.
 * Periodos fechados ficam 6h em cache; periodos que incluem hoje, 5 minutos.
 */
async function fetchProductionFromApi(
  dimension: "day" | "month",
  start: string,
  end: string,
): Promise<SemsDailyPoint[]> {
  const { id } = await resolveStation();
  const today = localDate(new Date());
  const cappedEnd = end > today ? today : end;
  const key = `${id}:${dimension}:${start}:${cappedEnd}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const chunks = splitRange(dimension, start, cappedEnd);
  const results: SemsDailyPoint[][] = [];
  // No maximo 3 requisicoes simultaneas para nao ser bloqueado pelo SEMS+.
  for (let index = 0; index < chunks.length; index += 3) {
    const batch = chunks.slice(index, index + 3);
    results.push(
      ...(await Promise.all(
        batch.map(([chunkStart, chunkEnd]) => getProductionSeries(id, dimension, chunkStart, chunkEnd)),
      )),
    );
  }

  const seen = new Set<string>();
  const data = results
    .flat()
    .filter((row) => {
      const dayKey = row.date.slice(0, dimension === "day" ? 10 : 7);
      if (seen.has(dayKey)) return false;
      seen.add(dayKey);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  if (historyCache.size > 200) historyCache.clear();
  historyCache.set(key, {
    expiresAt: Date.now() + (cappedEnd < today ? 6 * 3_600_000 : 5 * 60_000),
    data,
  });
  return data;
}

export type SemsLiveStatus = {
  stationId: string;
  checkedAt: string;
  inverters: SemsInverter[];
  /** Inversores cujos contadores nao puderam ser lidos (estado desconhecido, nao conta como parada). */
  unreadable: string[];
};

/**
 * Leitura leve para o monitoramento: so status e contadores dos inversores,
 * sem historico (usada a cada 5 minutos pelo agendamento).
 */
export async function getSemsLiveStatus(): Promise<SemsLiveStatus> {
  const { id: stationId } = await resolveStation();
  const devices = await getInverterDevices(stationId);
  const unreadable: string[] = [];
  const inverters = (
    await Promise.all(
      devices.map((device) =>
        getInverterCounters(stationId, device).catch(() => {
          unreadable.push(device.sn);
          return null;
        }),
      ),
    )
  ).filter((inv): inv is SemsInverter => inv !== null);

  return { stationId, checkedAt: new Date().toISOString(), inverters, unreadable };
}

// ---------- historico salvo no banco do painel ----------

/*
 * A geracao de cada dia fechado fica salva no Redis (solee:daily:<usina>:<ano>,
 * campo AAAA-MM-DD -> kWh, ou "-" quando o SEMS+ nao tem registro do dia).
 * Dias antigos sao lidos so do banco; a API do SEMS+ e usada apenas para os
 * dias recentes (o portal ainda pode corrigir os ultimos dias quando o
 * datalogger reenvia dados atrasados) e para preencher o que faltar no banco.
 */
const FINAL_AFTER_DAYS = 3;
const NO_RECORD = "-";
const dailyKey = (stationId: string, year: string) => `solee:daily:${stationId}:${year}`;

function daysBetween(start: string, end: string) {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) days.push(day);
  return days;
}

/** Agrupa dias em intervalos seguidos [inicio, fim]. */
function toRanges(days: string[]) {
  const ranges: Array<[string, string]> = [];
  for (const day of days) {
    const last = ranges.at(-1);
    if (last && addDays(last[1], 1) === day) last[1] = day;
    else ranges.push([day, day]);
  }
  return ranges;
}

export type ProductionSyncResult = {
  storedDays: number;
  fetchedDays: number;
  recentDays: number;
  firstDay: string | null;
  lastStoredDay: string | null;
};

/**
 * Le a geracao diaria entre duas datas usando o banco; busca na API so o que
 * nao esta salvo (e os ultimos dias). Grava no banco os dias fechados buscados.
 */
async function getDailyWithStore(start: string, end: string): Promise<{ rows: Map<string, number>; sync: ProductionSyncResult }> {
  const today = localDate(new Date());
  const cappedEnd = end > today ? today : end;
  const lastFinal = addDays(today, -FINAL_AFTER_DAYS);
  const { id } = await resolveStation();
  const rows = new Map<string, number>();
  const sync: ProductionSyncResult = { storedDays: 0, fetchedDays: 0, recentDays: 0, firstDay: null, lastStoredDay: null };
  if (start > cappedEnd) return { rows, sync };

  // 1. o que ja esta salvo
  const years = [...new Set(daysBetween(start, cappedEnd).map((day) => day.slice(0, 4)))];
  const stored = (await redis(years.map((year) => ["HGETALL", dailyKey(id, year)]))).map(hashToObject);
  const storedDays = new Map<string, string>();
  stored.forEach((hash) => Object.entries(hash).forEach(([day, value]) => storedDays.set(day, value)));

  const finalEnd = cappedEnd < lastFinal ? cappedEnd : lastFinal;
  const missing = start <= finalEnd ? daysBetween(start, finalEnd).filter((day) => !storedDays.has(day)) : [];

  // 2. busca na API so os dias fechados que faltam e grava
  for (const [rangeStart, rangeEnd] of toRanges(missing)) {
    const fetched = await fetchProductionFromApi("day", rangeStart, rangeEnd);
    const values = new Map(fetched.map((row) => [row.date.slice(0, 10), row.generationKwh]));
    const commands: Array<Array<string | number>> = [];
    for (const day of daysBetween(rangeStart, rangeEnd)) {
      const value = values.has(day) ? String(values.get(day)) : NO_RECORD;
      storedDays.set(day, value);
      commands.push(["HSET", dailyKey(id, day.slice(0, 4)), day, value]);
    }
    if (commands.length) await redis(commands);
    sync.fetchedDays += commands.length;
  }

  for (const [day, value] of storedDays) {
    if (day < start || day > finalEnd) continue;
    sync.storedDays += 1;
    if (value !== NO_RECORD) {
      rows.set(day, Number(value));
      if (!sync.firstDay || day < sync.firstDay) sync.firstDay = day;
      if (!sync.lastStoredDay || day > sync.lastStoredDay) sync.lastStoredDay = day;
    }
  }

  // 3. dias atuais sempre da API
  const recentStart = start > lastFinal ? start : addDays(lastFinal, 1);
  if (recentStart <= cappedEnd) {
    const recent = await fetchProductionFromApi("day", recentStart, cappedEnd);
    for (const row of recent) rows.set(row.date.slice(0, 10), row.generationKwh);
    sync.recentDays = daysBetween(recentStart, cappedEnd).length;
  }

  return { rows, sync };
}

/**
 * Producao da usina entre duas datas (AAAA-MM-DD), por dia ou por mes.
 * Com o banco configurado, dias antigos vem do banco e so os atuais da API.
 * Os totais mensais sao a soma dos dias.
 */
export async function getSemsProductionHistory(
  dimension: "day" | "month",
  start: string,
  end: string,
): Promise<SemsDailyPoint[]> {
  if (!isStorageConfigured()) return fetchProductionFromApi(dimension, start, end);

  const dailyStart = dimension === "month" ? `${start.slice(0, 7)}-01` : start;
  let rows: Map<string, number>;
  try {
    ({ rows } = await getDailyWithStore(dailyStart, end));
  } catch (error) {
    console.error("Banco indisponivel, usando a API do SEMS+:", error);
    return fetchProductionFromApi(dimension, start, end);
  }

  const days = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (dimension === "day") {
    return days.map(([day, kwh]) => ({ date: `${day}T12:00:00.000Z`, generationKwh: kwh }));
  }
  const months = new Map<string, number>();
  for (const [day, kwh] of days) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + kwh);
  return [...months.entries()].map(([month, kwh]) => ({
    date: `${month}-01T12:00:00.000Z`,
    generationKwh: Number(kwh.toFixed(2)),
  }));
}

/** Garante que o banco tem todos os dias fechados do periodo (usado pelo agendamento). */
export async function syncProductionStore(start: string, end: string): Promise<ProductionSyncResult> {
  return (await getDailyWithStore(start, end)).sync;
}

export function getStationToday() {
  return localDate(new Date());
}

export async function getSemsPlantSnapshot(): Promise<SemsPlantSnapshot> {
  const errors: string[] = [];
  const { id: stationId, row: station, warning } = await resolveStation();
  if (warning) errors.push(warning);

  const today = localDate(new Date());
  const historyStart = addDays(today, -59);
  // Desde 1º de janeiro do ano passado, para comparar o ano atual com o anterior.
  const yearAgo = `${Number(today.slice(0, 4)) - 1}-01-01`;

  const [flow, devices, dailyHistory, monthlyHistory] = await Promise.all([
    optional(getStationFlow(stationId), {} as Record<string, unknown>, "Fluxo", errors),
    optional(getInverterDevices(stationId), [] as DeviceInfo[], "Inversores", errors),
    optional(getSemsProductionHistory("day", historyStart, today), [], "Historico diario", errors),
    optional(getSemsProductionHistory("month", yearAgo, today), [], "Historico mensal", errors),
  ]);

  const unreadable: string[] = [];
  const inverters = await Promise.all(
    devices.map((device) =>
      optional(
        getInverterCounters(stationId, device).catch((error) => {
          unreadable.push(device.sn);
          throw error;
        }),
        {
          id: device.sn,
          name: device.name,
          serialNumber: device.sn,
          status: resolveStatusLabel(device.status),
          powerKw: 0,
          dayGenerationKwh: 0,
          monthGenerationKwh: 0,
          totalGenerationKwh: 0,
        },
        `Inversor ${device.sn}`,
        errors,
      ),
    ),
  );

  const sum = (pick: (inv: SemsInverter) => number) => inverters.reduce((total, inv) => total + pick(inv), 0);
  const todayFromHistory = dailyHistory.find((row) => row.date.startsWith(today))?.generationKwh ?? 0;
  const currentMonth = today.slice(0, 7);
  const monthFromHistory = dailyHistory
    .filter((row) => row.date.startsWith(currentMonth))
    .reduce((total, row) => total + row.generationKwh, 0);
  const monthFromMonthly = monthlyHistory.find((row) => row.date.startsWith(currentMonth))?.generationKwh ?? 0;

  const currentPowerKw =
    parseNumber(flow.pSystem) || parseNumber(flow.pAc) || parseNumber(station?.pSystem) || sum((inv) => inv.powerKw);
  const todayGenerationKwh =
    parseNumber(station?.productionToday) || sum((inv) => inv.dayGenerationKwh) || todayFromHistory;
  // A estatistica mensal costuma nao incluir o dia de hoje; usa a maior das fontes.
  const todayInHistory = dailyHistory.some((row) => row.date.startsWith(today));
  const monthGenerationKwh = Math.max(
    monthFromMonthly + (todayInHistory ? 0 : todayFromLive(station, inverters)),
    sum((inv) => inv.monthGenerationKwh ?? 0),
    monthFromHistory + (todayInHistory ? 0 : todayFromLive(station, inverters)),
  );
  const totalGenerationKwh = parseNumber(station?.productionTotal) || sum((inv) => inv.totalGenerationKwh);

  // Garante que o dia de hoje aparece no historico mesmo antes da estatistica fechar.
  const history = [...dailyHistory];
  if (todayGenerationKwh > 0 && !history.some((row) => row.date.startsWith(today))) {
    history.push({ date: `${today}T12:00:00.000Z`, generationKwh: todayGenerationKwh });
  }

  return {
    plantId: stationId,
    plantName: parseString(station?.name) || parseString(flow.name) || "Usina Solar",
    location: parseString(station?.googleAddress) || null,
    capacityKwp: parseNumber(station?.installedPower) || parseNumber(station?.pvInstallP) || null,
    totalGenerationKwh,
    todayGenerationKwh,
    monthGenerationKwh,
    currentPowerKw,
    status: resolveStatusLabel(flow.status ?? station?.status),
    inverters,
    hourlyChart: recordPowerReading(stationId, currentPowerKw, new Date()),
    dailyHistory: history,
    monthlyHistory,
    unreadableInverters: unreadable,
    errorLog: errors.join(" ") || undefined,
  };
}
