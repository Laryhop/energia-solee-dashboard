/*
 * Monitoramento de paradas dos inversores.
 *
 * A cada verificacao (agendada a cada 5 min pelo GitHub Actions e tambem a
 * cada minuto enquanto o painel esta aberto) le o status e a potencia de cada
 * inversor e abre/atualiza/fecha registros de parada no Redis.
 *
 * Energia perdida:
 *  - com outros inversores gerando: potencia deles x (potencia nominal do
 *    inversor parado / potencia nominal dos que geram). Reflete o sol/nuvens reais.
 *  - com a usina toda parada: geracao tipica diaria (mediana de 30 dias) x
 *    curva solar padrao (05:30-17:30).
 *  - ao voltar no mesmo dia, desconta o que o contador diario do inversor
 *    registrou durante a parada (quando era so falha de comunicacao com o
 *    portal, o inversor continuou gerando e nada foi perdido).
 */

import { getEnv } from "@/lib/env";
import { getSemsLiveStatus, getSemsProductionHistory } from "@/lib/sems/client";
import type { SemsInverter } from "@/lib/sems/types";
import { hashToObject, isStorageConfigured, parseJson, redis } from "@/lib/storage";

const PREFIX = "solee";
const KEY_OPEN = `${PREFIX}:outage:open`;
const KEY_LAST = `${PREFIX}:monitor:last`;
const KEY_SINCE = `${PREFIX}:monitor:since`;
const KEY_LOCK = `${PREFIX}:monitor:lock`;
const KEY_TYPICAL = `${PREFIX}:monitor:typical`;
const monthKey = (month: string) => `${PREFIX}:outages:${month}`;
const checksKey = (month: string) => `${PREFIX}:checks:${month}`;

/** Intervalo minimo entre verificacoes (o painel aberto chama a cada 60 s). */
const MIN_INTERVAL_MS = 55_000;
/** Lacuna maxima para integrar pela potencia medida; acima disso usa a curva solar. */
const MAX_TRAPEZOID_GAP_H = 20 / 60;
/** Paradas mais curtas que isso sao descartadas (oscilacao de leitura). */
const MIN_OUTAGE_MS = 2 * 60_000;
const SUN_START = 5.5;
const SUN_END = 17.5;
const KEEP_SECONDS = 5 * 365 * 86_400;

// Alagoas usa UTC-3 o ano todo (sem horario de verao).
const UTC_OFFSET_MS = -3 * 3_600_000;

export type OutageReason = "Offline" | "Falha" | "Sem potência" | "Usina parada" | "Geração abaixo do esperado";

export type Outage = {
  id: string;
  sn: string;
  name: string;
  start: string;
  end: string | null;
  lastCheck: string;
  lastExpectedKw: number;
  /** Energia que o inversor deveria ter gerado durante a parada (kWh). */
  expectedKwh: number;
  /** Minutos da parada dentro do horario de sol (05:30-17:30). */
  daylightMinutes: number;
  dayKwhAtStart: number;
  startDay: string;
  reason: OutageReason;
  method: "comparacao" | "curva";
  checks: number;
  /** Energia que o contador registrou durante a parada (so quando volta no mesmo dia). */
  actualKwh: number | null;
  lostKwh: number;
  lostBrl: number;
  tariff: number;
  /** "comunicacao" = portal sem dados, mas o inversor seguiu gerando. */
  /** "historico" = reconstruida a partir da geracao diaria (antes do monitoramento). */
  kind: "parada" | "comunicacao" | "historico" | null;
  note?: string;
  ignored?: boolean;
  /** Quantos inversores a parada envolve (registros historicos valem para a usina inteira). */
  inverterCount?: number;
  /** Dia sem nenhum registro de geracao no SEMS+ (so registros historicos). */
  missingRecord?: boolean;
};

export type MonitorInverterState = {
  sn: string;
  name: string;
  status: string;
  powerKw: number;
  state: "gerando" | "parado" | "indefinido" | "sem leitura";
};

export type MonitorLast = {
  at: string;
  inverters: MonitorInverterState[];
  error?: string;
};

export type MonitorInput = {
  inverters: SemsInverter[];
  unreadable?: string[];
  typicalDailyKwh?: number;
};

export type MonitorResult =
  | { ok: true; skipped?: "recent"; checkedAt?: string; opened?: number; closed?: number; open?: number }
  | { ok: false; skipped: "storage" };

// ---------- tempo e curva solar ----------

function localHour(ms: number) {
  const local = new Date(ms + UTC_OFFSET_MS);
  return local.getUTCHours() + local.getUTCMinutes() / 60 + local.getUTCSeconds() / 3600;
}

export function localDay(ms: number) {
  return new Date(ms + UTC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Fracao da geracao diaria produzida por hora no horario h (integra 1 no dia). */
function sunShapePerHour(hour: number) {
  if (hour <= SUN_START || hour >= SUN_END) return 0;
  const span = SUN_END - SUN_START;
  return (Math.PI / (2 * span)) * Math.sin((Math.PI * (hour - SUN_START)) / span);
}

/** Fracao da geracao diaria entre dois instantes, e os minutos de sol nesse intervalo. */
function sunBetween(startMs: number, endMs: number) {
  const capped = Math.min(endMs, startMs + 10 * 86_400_000);
  const stepMs = 60_000;
  let fraction = 0;
  let daylightMinutes = 0;
  for (let t = startMs; t < capped; t += stepMs) {
    const slice = Math.min(stepMs, capped - t);
    const hour = localHour(t + slice / 2);
    fraction += sunShapePerHour(hour) * (slice / 3_600_000);
    if (hour > SUN_START && hour < SUN_END) daylightMinutes += slice / 60_000;
  }
  return { fraction, daylightMinutes };
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

// ---------- geracao tipica ----------

async function getTypicalDailyKwh(hint?: number) {
  if (hint && hint > 0) {
    await redis([["SET", KEY_TYPICAL, JSON.stringify({ value: hint, at: Date.now() })]]);
    return hint;
  }
  const [raw] = await redis([["GET", KEY_TYPICAL]]);
  const cached = parseJson<{ value: number; at: number }>(raw);
  if (cached && Date.now() - cached.at < 12 * 3_600_000) return cached.value;

  try {
    const today = localDay(Date.now());
    const start = localDay(Date.now() - 30 * 86_400_000);
    const rows = await getSemsProductionHistory("day", start, today);
    const value = median(rows.filter((row) => !row.date.startsWith(today) && row.generationKwh > 0).map((row) => row.generationKwh));
    if (value > 0) {
      await redis([["SET", KEY_TYPICAL, JSON.stringify({ value, at: Date.now() })]]);
      return value;
    }
  } catch {
    // usa o valor antigo, se houver
  }
  return cached?.value ?? 0;
}

// ---------- verificacao ----------

export async function runMonitor(input?: MonitorInput): Promise<MonitorResult> {
  if (!isStorageConfigured()) return { ok: false, skipped: "storage" };

  const [lock] = await redis([["SET", KEY_LOCK, String(Date.now()), "NX", "PX", MIN_INTERVAL_MS]]);
  if (lock !== "OK") return { ok: true, skipped: "recent" };

  const now = Date.now();
  let live: MonitorInput;
  try {
    live = input ?? (await getSemsLiveStatus());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const [rawLast] = await redis([["GET", KEY_LAST]]);
    const previous = parseJson<MonitorLast>(rawLast);
    await redis([["SET", KEY_LAST, JSON.stringify({ ...(previous ?? { inverters: [] }), at: new Date(now).toISOString(), error: message })]]);
    throw error;
  }

  const env = getEnv();
  const tariff = env.TARIFA_KWH;
  const typicalDaily = await getTypicalDailyKwh(live.typicalDailyKwh);
  const unreadable = new Set(live.unreadable ?? []);
  const inverters = live.inverters.filter((inv) => !unreadable.has(inv.id));

  // Pesos pela potencia nominal (ou iguais, se o SEMS+ nao informar).
  const knownRated = inverters.map((inv) => inv.ratedPowerKw ?? 0).filter((value) => value > 0);
  const defaultRated = knownRated.length ? knownRated.reduce((a, b) => a + b, 0) / knownRated.length : 1;
  const rated = (inv: SemsInverter) => (inv.ratedPowerKw && inv.ratedPowerKw > 0 ? inv.ratedPowerKw : defaultRated);
  const totalRated = inverters.reduce((sum, inv) => sum + rated(inv), 0) || 1;

  const isProducing = (inv: SemsInverter) => inv.powerKw > Math.max(0.05, 0.005 * rated(inv));
  const producing = inverters.filter(isProducing);
  const hour = localHour(now);
  const today = localDay(now);

  function expectedNow(inv: SemsInverter): { kw: number; method: Outage["method"] } {
    const peers = producing.filter((peer) => peer.id !== inv.id);
    if (peers.length) {
      const peerPower = peers.reduce((sum, peer) => sum + peer.powerKw, 0);
      const peerRated = peers.reduce((sum, peer) => sum + rated(peer), 0) || 1;
      return { kw: (peerPower * rated(inv)) / peerRated, method: "comparacao" };
    }
    return { kw: typicalDaily * (rated(inv) / totalRated) * sunShapePerHour(hour), method: "curva" };
  }

  function classify(inv: SemsInverter): { state: "up" | "down" | "unknown"; reason?: OutageReason } {
    if (isProducing(inv)) return { state: "up" };
    const peers = producing.filter((peer) => peer.id !== inv.id);
    const peerYield =
      peers.reduce((sum, peer) => sum + peer.powerKw, 0) / (peers.reduce((sum, peer) => sum + rated(peer), 0) || 1);
    const statusReason: OutageReason | null =
      inv.status === "Offline" ? "Offline" : inv.status === "Falha" ? "Falha" : null;

    if (peers.length && peerYield >= 0.03) return { state: "down", reason: statusReason ?? "Sem potência" };
    if (!producing.length && hour >= 8 && hour < 16) return { state: "down", reason: statusReason === "Falha" ? "Falha" : "Usina parada" };
    if (statusReason && hour >= 7 && hour < 17) return { state: "down", reason: statusReason };
    return { state: "unknown" };
  }

  const [rawOpen, rawPrevious] = await redis([["HGETALL", KEY_OPEN], ["GET", KEY_LAST]]);
  const previousCheckMs = Date.parse(parseJson<MonitorLast>(rawPrevious)?.at ?? "");
  // A parada comeca no meio do intervalo entre a ultima leitura normal e esta (igual ao fim).
  const startMs =
    Number.isFinite(previousCheckMs) && now - previousCheckMs <= MAX_TRAPEZOID_GAP_H * 3_600_000
      ? Math.round(previousCheckMs + (now - previousCheckMs) / 2)
      : now;
  const leadIn = sunBetween(startMs, now);
  const open = new Map(
    Object.entries(hashToObject(rawOpen))
      .map(([sn, json]) => [sn, parseJson<Outage>(json)] as const)
      .filter((entry): entry is readonly [string, Outage] => entry[1] !== null),
  );

  const commands: Array<Array<string | number>> = [];
  const states: MonitorInverterState[] = [];
  let opened = 0;
  let closed = 0;

  const integrate = (outage: Outage, untilMs: number, kwAtEnd: number, inv: SemsInverter) => {
    const lastMs = Date.parse(outage.lastCheck);
    const gapH = Math.max(0, (untilMs - lastMs) / 3_600_000);
    const sun = sunBetween(lastMs, untilMs);
    const energy =
      gapH <= MAX_TRAPEZOID_GAP_H
        ? ((outage.lastExpectedKw + kwAtEnd) / 2) * gapH
        : typicalDaily * (rated(inv) / totalRated) * sun.fraction;
    outage.expectedKwh = round(outage.expectedKwh + energy, 3);
    outage.daylightMinutes = round(outage.daylightMinutes + sun.daylightMinutes, 1);
  };

  for (const inv of live.inverters) {
    if (unreadable.has(inv.id)) {
      states.push({ sn: inv.id, name: inv.name, status: inv.status, powerKw: inv.powerKw, state: "sem leitura" });
      continue;
    }

    const { state, reason } = classify(inv);
    const expected = expectedNow(inv);
    const current = open.get(inv.id);
    states.push({
      sn: inv.id,
      name: inv.name,
      status: inv.status,
      powerKw: inv.powerKw,
      state: state === "up" ? "gerando" : state === "down" ? "parado" : "indefinido",
    });

    if (state === "down" && !current) {
      const outage: Outage = {
        id: `${inv.id}-${startMs}`,
        sn: inv.id,
        name: inv.name,
        start: new Date(startMs).toISOString(),
        end: null,
        lastCheck: new Date(now).toISOString(),
        lastExpectedKw: round(expected.kw, 3),
        expectedKwh: round((expected.kw * (now - startMs)) / 3_600_000, 3),
        daylightMinutes: round(leadIn.daylightMinutes, 1),
        dayKwhAtStart: inv.dayGenerationKwh,
        startDay: localDay(startMs),
        reason: reason ?? "Sem potência",
        method: expected.method,
        checks: 1,
        actualKwh: null,
        lostKwh: 0,
        lostBrl: 0,
        tariff,
        kind: null,
      };
      commands.push(["HSET", KEY_OPEN, inv.id, JSON.stringify(outage)]);
      opened += 1;
      continue;
    }

    if (!current) continue;

    if (state === "down" || state === "unknown") {
      integrate(current, now, expected.kw, inv);
      current.lastCheck = new Date(now).toISOString();
      current.lastExpectedKw = round(expected.kw, 3);
      current.checks += 1;
      current.name = inv.name;
      if (state === "down") {
        // Se em algum momento os outros inversores estavam gerando, a estimativa e por comparacao.
        if (expected.method === "comparacao") current.method = "comparacao";
        if (reason === "Falha") current.reason = "Falha";
      }
      current.lostKwh = round(current.expectedKwh, 2);
      current.lostBrl = round(current.lostKwh * tariff, 2);
      commands.push(["HSET", KEY_OPEN, inv.id, JSON.stringify(current)]);
      continue;
    }

    // Voltou a gerar: fecha a parada no meio do intervalo entre a ultima leitura parada e agora.
    const lastMs = Date.parse(current.lastCheck);
    const endMs = Math.round(lastMs + (now - lastMs) / 2);
    integrate(current, endMs, expected.kw / 2 + current.lastExpectedKw / 2, inv);
    current.end = new Date(endMs).toISOString();
    current.checks += 1;

    const sameDay = current.startDay === today;
    const afterEndKwh = (inv.powerKw * (now - endMs)) / 3_600_000;
    current.actualKwh = sameDay ? round(Math.max(0, inv.dayGenerationKwh - current.dayKwhAtStart - afterEndKwh), 2) : null;
    // Se o contador registrou ~toda a energia esperada, o inversor so ficou sem comunicacao:
    // a diferenca que sobra e erro de medicao, nao perda.
    const producedAlmostAll = current.actualKwh !== null && current.actualKwh >= 0.9 * current.expectedKwh;
    const lost = producedAlmostAll ? 0 : Math.max(0, current.expectedKwh - (current.actualKwh ?? 0));
    current.kind =
      current.actualKwh !== null && current.expectedKwh > 0.2 && current.actualKwh >= 0.6 * current.expectedKwh
        ? "comunicacao"
        : "parada";
    current.lostKwh = round(lost, 2);
    current.tariff = tariff;
    current.lostBrl = round(lost * tariff, 2);

    commands.push(["HDEL", KEY_OPEN, inv.id]);
    if (endMs - Date.parse(current.start) >= MIN_OUTAGE_MS) {
      const month = current.startDay.slice(0, 7);
      commands.push(["HSET", monthKey(month), current.id, JSON.stringify(current)]);
      commands.push(["EXPIRE", monthKey(month), KEEP_SECONDS]);
      closed += 1;
    }
  }

  const month = today.slice(0, 7);
  const last: MonitorLast = { at: new Date(now).toISOString(), inverters: states };
  commands.push(
    ["SET", KEY_LAST, JSON.stringify(last)],
    ["SET", KEY_SINCE, new Date(now).toISOString(), "NX"],
    ["HINCRBY", checksKey(month), today, 1],
    ["EXPIRE", checksKey(month), KEEP_SECONDS],
  );
  await redis(commands);

  const stillOpen = [...open.keys()].filter((sn) => !commands.some((cmd) => cmd[0] === "HDEL" && cmd[2] === sn)).length + opened;
  return { ok: true, checkedAt: last.at, opened, closed, open: stillOpen };
}

// ---------- consulta ----------

export type OutageHistory = {
  configured: boolean;
  year: string;
  tariff: number;
  since: string | null;
  last: MonitorLast | null;
  open: Outage[];
  closed: Outage[];
  /** Verificacoes feitas por dia (AAAA-MM-DD -> quantidade). */
  checksByDay: Record<string, number>;
};

export async function getOutageHistory(year: string): Promise<OutageHistory> {
  const tariff = getEnv().TARIFA_KWH;
  if (!isStorageConfigured()) {
    return { configured: false, year, tariff, since: null, last: null, open: [], closed: [], checksByDay: {} };
  }

  const months = Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`);
  const results = await redis([
    ["GET", KEY_SINCE],
    ["GET", KEY_LAST],
    ["HGETALL", KEY_OPEN],
    ...months.map((month) => ["HGETALL", monthKey(month)]),
    ...months.map((month) => ["HGETALL", checksKey(month)]),
  ]);

  const [since, rawLast, rawOpen] = results;
  const closed = results
    .slice(3, 15)
    .flatMap((raw) => Object.values(hashToObject(raw)).map((json) => parseJson<Outage>(json)))
    .filter((item): item is Outage => item !== null)
    .sort((a, b) => b.start.localeCompare(a.start));

  const checksByDay: Record<string, number> = {};
  for (const raw of results.slice(15)) {
    for (const [day, count] of Object.entries(hashToObject(raw))) checksByDay[day] = Number(count);
  }

  const open = Object.values(hashToObject(rawOpen))
    .map((json) => parseJson<Outage>(json))
    .filter((item): item is Outage => item !== null)
    .map((item) => ({ ...item, lostBrl: round(item.expectedKwh * tariff, 2), tariff }))
    .sort((a, b) => b.start.localeCompare(a.start));

  return {
    configured: true,
    year,
    tariff,
    since: typeof since === "string" ? since : null,
    last: parseJson<MonitorLast>(rawLast),
    open,
    closed,
    checksByDay,
  };
}

/** Adiciona uma observacao ou marca/desmarca uma parada como ignorada. */
export async function updateOutage(id: string, changes: { note?: string; ignored?: boolean }) {
  const match = id.match(/-(\d{13})$/);
  if (!match) throw new Error("Registro invalido.");
  const month = localDay(Number(match[1])).slice(0, 7);
  const [raw] = await redis([["HGET", monthKey(month), id]]);
  const outage = parseJson<Outage>(raw);
  if (!outage) throw new Error("Registro nao encontrado.");

  if (changes.note !== undefined) outage.note = changes.note.slice(0, 500);
  if (changes.ignored !== undefined) outage.ignored = changes.ignored;
  await redis([["HSET", monthKey(month), id, JSON.stringify(outage)]]);
  return outage;
}
