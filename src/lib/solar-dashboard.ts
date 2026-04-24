import { ZodError } from "zod";

import { getEnv } from "@/lib/env";
import { getSemsPlantSnapshot } from "@/lib/sems/client";

export class SolarDashboardConfigError extends Error {}
export class SolarDashboardUpstreamError extends Error {}

type CachedValue = {
  expiresAt: number;
  data: SolarDashboardData;
};

export type SolarDashboardData = {
  summary: {
    plantName: string;
    location: string | null;
    todayGenerationKwh: number;
    monthlyGenerationKwh: number;
    currentPowerKw: number;
    totalGenerationKwh: number;
    economyTodayBrl: number;
    economyMonthBrl: number;
    totalRevenueBrl: number;
    performancePct: number;
    targetDailyKwh: number;
    statusLabel: string;
    updatedAt: string;
    tariffKwhBrl: number;
  };
  inverters: Array<{
    id: string;
    name: string;
    serialNumber: string | null;
    status: string;
    powerKw: number;
    dayGenerationKwh: number;
    totalGenerationKwh: number;
  }>;
  hourlyChart: Array<{
    timeLabel: string;
    powerKw: number;
  }>;
  dailyHistory: Array<{
    date: string;
    label: string;
    generationKwh: number;
    economyBrl: number;
  }>;
  errorLog?: string;
};

let cache: CachedValue | null = null;

function toFixedNumber(value: number, fractionDigits = 1) {
  return Number(value.toFixed(fractionDigits));
}

function formatDayLabel(date: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
  }).format(new Date(date));
}

function formatHourLabel(date: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

function getMonthKey(date: string) {
  const current = new Date(date);
  const year = current.getUTCFullYear();
  const month = String(current.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export async function getSolarDashboardData(): Promise<SolarDashboardData> {
  const env = getEnv();

  if (cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  try {
    const snapshot = await getSemsPlantSnapshot();
    const currentMonthKey = getMonthKey(new Date().toISOString());
    const monthlyPoint = snapshot.monthlyHistory.findLast(
      (item) => getMonthKey(item.date) === currentMonthKey,
    );
    const dailyHistoryGeneration = snapshot.dailyHistory.reduce(
      (total, item) => total + item.generationKwh,
      0,
    );
    const monthlyGenerationKwh =
      snapshot.monthGenerationKwh ||
      monthlyPoint?.generationKwh ||
      dailyHistoryGeneration ||
      snapshot.todayGenerationKwh;
    const economyTodayBrl = snapshot.todayGenerationKwh * env.TARIFA_KWH;
    const economyMonthBrl = monthlyGenerationKwh * env.TARIFA_KWH;
    const totalRevenueBrl = snapshot.totalGenerationKwh * env.TARIFA_KWH;
    const performancePct =
      env.META_DIARIA > 0 ? (snapshot.todayGenerationKwh / env.META_DIARIA) * 100 : 0;

    const data: SolarDashboardData = {
      summary: {
        plantName: snapshot.plantName,
        location: snapshot.location,
        todayGenerationKwh: toFixedNumber(snapshot.todayGenerationKwh),
        monthlyGenerationKwh: toFixedNumber(monthlyGenerationKwh),
        currentPowerKw: toFixedNumber(snapshot.currentPowerKw),
        totalGenerationKwh: toFixedNumber(snapshot.totalGenerationKwh),
        economyTodayBrl: toFixedNumber(economyTodayBrl, 2),
        economyMonthBrl: toFixedNumber(economyMonthBrl, 2),
        totalRevenueBrl: toFixedNumber(totalRevenueBrl, 2),
        performancePct: toFixedNumber(performancePct),
        targetDailyKwh: env.META_DIARIA,
        statusLabel: snapshot.status,
        updatedAt: new Date().toISOString(),
        tariffKwhBrl: env.TARIFA_KWH,
      },
      inverters: snapshot.inverters,
      hourlyChart: snapshot.hourlyChart.map((item) => ({
        timeLabel: formatHourLabel(item.timestamp),
        powerKw: toFixedNumber(item.powerKw),
      })),
      dailyHistory: snapshot.dailyHistory.map((item) => ({
        date: item.date,
        label: formatDayLabel(item.date),
        generationKwh: toFixedNumber(item.generationKwh),
        economyBrl: toFixedNumber(item.generationKwh * env.TARIFA_KWH, 2),
      })),
      errorLog: snapshot.errorLog,
    };

    cache = {
      expiresAt: Date.now() + env.SEMS_CACHE_TTL_MS,
      data,
    };

    return data;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new SolarDashboardConfigError(error.issues.map((issue) => issue.message).join(" "));
    }

    throw new SolarDashboardUpstreamError(
      error instanceof Error ? error.message : "Falha desconhecida ao consultar SEMS.",
    );
  }
}
