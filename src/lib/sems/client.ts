import { getEnv } from "@/lib/env";
import type {
  SemsDailyPoint,
  SemsHourlyPoint,
  SemsInverter,
  SemsPlant,
  SemsPlantSnapshot,
} from "@/lib/sems/types";

const SEMS_BASE_URL = "https://www.semsportal.com/api";
const SEMS_APP_VERSION = "v2.1.0";
const SEMS_LANGUAGE = "en";
const SEMS_CLIENT = "ios";

type LoginSession = {
  uid: string;
  timestamp: number;
  token: string;
};

function parseNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.replace(",", ".").match(/-?\d+(\.\d+)?/);
    return normalized ? Number(normalized[0]) : 0;
  }

  return 0;
}

function parseString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function unwrapEnvelope<T>(payload: unknown): T {
  if (
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    (payload as { data?: unknown }).data !== undefined
  ) {
    return (payload as { data: T }).data;
  }

  return payload as T;
}

function collectObjects(input: unknown, results: Array<Record<string, unknown>> = []) {
  if (Array.isArray(input)) {
    input.forEach((item) => collectObjects(item, results));
    return results;
  }

  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    results.push(record);
    Object.values(record).forEach((value) => collectObjects(value, results));
  }

  return results;
}

function resolveStatusLabel(status: unknown): string {
  if (typeof status === "number") {
    if (status === 1) return "Gerando";
    if (status === 0) return "Standby";
    if (status === -1) return "Offline";
    if (status === 2) return "Falha";
    return `Status ${status}`;
  }

  return parseString(status, "Indefinido");
}

function toIsoDate(input: string) {
  const parsed = new Date(input);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return input;
}

async function semsRequest<T>(
  path: string,
  session: LoginSession,
  payload: Record<string, unknown>,
) {
  const tokenHeader = JSON.stringify({
    uid: session.uid,
    timestamp: session.timestamp,
    token: session.token,
    client: SEMS_CLIENT,
    version: SEMS_APP_VERSION,
    language: SEMS_LANGUAGE,
  });

  const response = await fetch(`${SEMS_BASE_URL}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: tokenHeader,
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`SEMS respondeu com ${response.status} em ${path}.`);
  }

  return (await response.json()) as T;
}

async function login(): Promise<LoginSession> {
  const env = getEnv();
  const response = await fetch(`${SEMS_BASE_URL}/v2/Common/CrossLogin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: JSON.stringify({
        client: SEMS_CLIENT,
        version: SEMS_APP_VERSION,
        language: SEMS_LANGUAGE,
      }),
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({
      account: env.SEMS_USER,
      pwd: env.SEMS_PASS,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Falha no login do SEMS (${response.status}).`);
  }

  const payload = unwrapEnvelope<Record<string, unknown>>(await response.json());
  const uid = parseString(payload.uid);
  const token = parseString(payload.token);
  const timestamp = parseNumber(payload.timestamp);

  if (!uid || !token || !timestamp) {
    throw new Error("Nao foi possivel obter sessao valida no SEMS.");
  }

  return { uid, token, timestamp };
}

function extractPlants(payload: unknown): SemsPlant[] {
  const candidates = collectObjects(payload)
    .map((item) => {
      const id =
        parseString(item.powerstation_id) ||
        parseString(item.powerStationId) ||
        parseString(item.id);
      const name =
        parseString(item.stationname) ||
        parseString(item.stationName) ||
        parseString(item.name);

      if (!id || !name) {
        return null;
      }

      return { id, name };
    })
    .filter((item): item is SemsPlant => Boolean(item));

  return candidates.filter(
    (plant, index, list) => list.findIndex((entry) => entry.id === plant.id) === index,
  );
}

async function listPlants(session: LoginSession): Promise<SemsPlant[]> {
  const attempts = [
    { path: "PowerStationMonitor/QueryPowerStationMonitorForAppNew", payload: {} },
    { path: "PowerStationMonitor/QueryPowerStationMonitorForApp", payload: {} },
    { path: "OpenApi/GetUserPowerStation", payload: {} },
  ];

  for (const attempt of attempts) {
    try {
      const result = await semsRequest<unknown>(attempt.path, session, attempt.payload);
      const plants = extractPlants(unwrapEnvelope(result));

      if (plants.length) {
        return plants;
      }
    } catch {
      // tenta a proxima rota conhecida
    }
  }

  throw new Error(
    "Nao foi possivel descobrir a usina automaticamente. Defina SEMS_PLANT_ID no ambiente.",
  );
}

function mapInverters(payload: unknown): SemsInverter[] {
  const unwrapped = unwrapEnvelope<Record<string, unknown>>(payload);
  const rawInverters = Array.isArray(unwrapped.inverter) ? unwrapped.inverter : [];

  return rawInverters.map((item, index) => {
    const record = item as Record<string, unknown>;
    const details =
      record.invert_full && typeof record.invert_full === "object"
        ? (record.invert_full as Record<string, unknown>)
        : {};

    return {
      id:
        parseString(record.id) ||
        parseString(record.powerstation_id) ||
        parseString(details.sn) ||
        `inverter-${index + 1}`,
      name:
        parseString(record.name) ||
        parseString(record.inverter_name) ||
        parseString(details.sn, `Inversor ${index + 1}`),
      serialNumber: parseString(details.sn) || null,
      status: resolveStatusLabel(record.status),
      powerKw: parseNumber(record.power || details.pac || details.ppv) / 1000,
      dayGenerationKwh: parseNumber(record.day_generation || details.eday || record.etoday),
      totalGenerationKwh: parseNumber(
        record.total_generation || details.etotal || record.etotal,
      ),
    };
  });
}

function getMonthGenerationFromDetail(
  kpi: Record<string, unknown>,
  inverters: SemsInverter[],
  rawInverters: unknown[],
) {
  const fromKpi =
    parseNumber(kpi.month_power) ||
    parseNumber(kpi.month_generation) ||
    parseNumber(kpi.monthPower) ||
    parseNumber(kpi.monthGeneration);

  if (fromKpi > 0) {
    return fromKpi;
  }

  const fromRawInverters = rawInverters.reduce<number>((total, item) => {
    const record = item as Record<string, unknown>;
    const details =
      record.invert_full && typeof record.invert_full === "object"
        ? (record.invert_full as Record<string, unknown>)
        : {};

    return (
      total +
      parseNumber(
        record.month_generation ||
          record.monthGeneration ||
          details.emonth ||
          details.month_generation,
      )
    );
  }, 0);

  if (fromRawInverters > 0) {
    return fromRawInverters;
  }

  return inverters.reduce((total, inverter) => total + inverter.dayGenerationKwh, 0);
}

function mapHourlyChart(payload: unknown): SemsHourlyPoint[] {
  const data = unwrapEnvelope<Record<string, unknown>>(payload);
  const pacs = Array.isArray(data.pacs) ? data.pacs : [];

  return pacs
    .map((item) => {
      const record = item as Record<string, unknown>;
      const timestamp = parseString(record.date);
      return {
        timestamp: toIsoDate(timestamp),
        powerKw: parseNumber(record.pac) / 1000,
      };
    })
    .filter((point) => point.timestamp)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function mapDailyHistory(payload: unknown): SemsDailyPoint[] {
  const data = unwrapEnvelope<unknown>(payload);
  const directRows = Array.isArray(data)
    ? data
    : Array.isArray((data as { list?: unknown[] })?.list)
      ? ((data as { list: unknown[] }).list ?? [])
      : [];
  const rows =
    directRows.length > 0
      ? directRows
      : collectObjects(data).filter((item) => {
          const hasDateLikeField = Boolean(
            parseString(item.date) || parseString(item.day) || parseString(item.month),
          );
          const hasPowerLikeField = [
            item.p,
            item.power,
            item.value,
            item.generation,
            item.generationKwh,
          ].some((value) => parseNumber(value) > 0);

          return hasDateLikeField && hasPowerLikeField;
        });

  return rows
    .map((item) => {
      const record = item as Record<string, unknown>;
      const rawDate =
        parseString(record.date) || parseString(record.day) || parseString(record.month);

      return {
        date: rawDate ? toIsoDate(rawDate) : rawDate,
        generationKwh: parseNumber(
          record.p ||
            record.power ||
            record.value ||
            record.generation ||
            record.generationKwh,
        ),
      };
    })
    .filter((item) => item.date)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function fetchPlantDetail(session: LoginSession, plantId: string) {
  return semsRequest<unknown>("v2/PowerStation/GetMonitorDetailByPowerstationId", session, {
    powerStationId: plantId,
  });
}

async function fetchPlantPowerByDay(session: LoginSession, plantId: string, count: number) {
  return semsRequest<unknown>("PowerStationMonitor/GetPowerStationPowerAndIncomeByDay", session, {
    powerstation_id: plantId,
    date: formatDateInput(new Date()),
    count,
    id: plantId,
  });
}

async function fetchPlantPowerByMonth(session: LoginSession, plantId: string, count: number) {
  return semsRequest<unknown>("PowerStationMonitor/GetPowerStationPowerAndIncomeByMonth", session, {
    powerstation_id: plantId,
    date: formatDateInput(new Date()),
    count,
    id: plantId,
  });
}

async function fetchPlantHourlyPower(session: LoginSession, plantId: string) {
  return semsRequest<unknown>("PowerStationMonitor/GetPowerStationPacByDayForApp", session, {
    id: plantId,
    date: formatDateInput(new Date()),
  });
}

export async function getSemsPlantSnapshot(): Promise<SemsPlantSnapshot> {
  const env = getEnv();
  const session = await login();
  const plantId = env.SEMS_PLANT_ID || (await listPlants(session))[0]?.id;

  if (!plantId) {
    throw new Error("Nenhuma usina encontrada para a conta informada.");
  }

  const [detailPayload, hourlyPayload, dailyPayload, monthlyPayload] = await Promise.all([
    fetchPlantDetail(session, plantId),
    fetchPlantHourlyPower(session, plantId).catch(() => ({ pacs: [] })),
    fetchPlantPowerByDay(session, plantId, 60).catch(() => []),
    fetchPlantPowerByMonth(session, plantId, 12).catch(() => []),
  ]);

  const detail = unwrapEnvelope<Record<string, unknown>>(detailPayload);
  const location = parseString(
    (detail.info as Record<string, unknown> | undefined)?.address ||
      (detail.info as Record<string, unknown> | undefined)?.location ||
      (detail.info as Record<string, unknown> | undefined)?.city,
  );
  const kpi =
    detail.kpi && typeof detail.kpi === "object"
      ? (detail.kpi as Record<string, unknown>)
      : {};
  const inverters = mapInverters(detail);
  const rawInverters = Array.isArray(detail.inverter) ? detail.inverter : [];
  const dailyHistory = mapDailyHistory(dailyPayload);
  const monthlyHistory = mapDailyHistory(monthlyPayload);
  const todayGenerationKwh = parseNumber(kpi.power);
  const monthGenerationKwh = getMonthGenerationFromDetail(kpi, inverters, rawInverters);
  const hydratedDailyHistory =
    dailyHistory.length > 0
      ? dailyHistory
      : todayGenerationKwh > 0
        ? [
            {
              date: new Date().toISOString(),
              generationKwh: todayGenerationKwh,
            },
          ]
        : [];

  return {
    plantId,
    plantName:
      parseString(
        (detail.info as Record<string, unknown> | undefined)?.stationname ||
          (detail.info as Record<string, unknown> | undefined)?.name,
      ) || "Usina Solar",
    location: location || null,
    totalGenerationKwh: parseNumber(kpi.total_power),
    todayGenerationKwh,
    monthGenerationKwh,
    currentPowerKw: parseNumber(kpi.pac || detail.power) / 1000,
    status:
      resolveStatusLabel(
        parseString((detail.info as Record<string, unknown> | undefined)?.status) ||
          (detail.inverter as Array<Record<string, unknown>> | undefined)?.[0]?.status,
    ) || "Indefinido",
    inverters,
    hourlyChart: mapHourlyChart(hourlyPayload),
    dailyHistory: hydratedDailyHistory,
    monthlyHistory,
  };
}
