"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

type ApiState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: DashboardPayload };

type SortKey = "date" | "generationKwh" | "economyBrl" | "deltaKwh";

type SolarDashboardData = {
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
};

type WeatherData = {
  location: string;
  current: {
    temperatureC: number;
    windKph: number;
    precipitationProbabilityPct: number;
    weatherLabel: string;
  };
  daily: Array<{
    date: string;
    label: string;
    tempMaxC: number;
    tempMinC: number;
    precipitationProbabilityMaxPct: number;
    weatherLabel: string;
  }>;
  updatedAt: string;
};

type DashboardPayload = {
  solar: SolarDashboardData;
  weather: WeatherData;
};

type ApiError = { error?: string; detail?: string };

type ComparisonRow = {
  date: string;
  label: string;
  generationKwh: number;
  economyBrl: number;
  deltaKwh: number;
};

const REFRESH_INTERVAL_MS = 60_000;

const numberFormatter = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 1,
});

const currencyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat("pt-BR", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function isApiError(payload: unknown): payload is ApiError {
  return Boolean(payload && typeof payload === "object" && ("error" in payload || "detail" in payload));
}

function formatKwh(value: number) {
  return `${numberFormatter.format(value)} kWh`;
}

function formatKw(value: number) {
  return `${numberFormatter.format(value)} kW`;
}

function formatCurrency(value: number) {
  return currencyFormatter.format(value);
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function getStatusTone(status: string) {
  const normalized = status.toLowerCase();

  if (
    normalized.includes("gera") ||
    normalized.includes("online") ||
    normalized.includes("normal") ||
    normalized.includes("running")
  ) {
    return "bg-emerald-100 text-emerald-900 ring-emerald-300";
  }

  if (normalized.includes("standby") || normalized.includes("espera")) {
    return "bg-amber-100 text-amber-900 ring-amber-300";
  }

  if (normalized.includes("offline") || normalized.includes("falha")) {
    return "bg-rose-100 text-rose-900 ring-rose-300";
  }

  return "bg-white/70 text-slate-800 ring-slate-200";
}

function getDeltaTone(value: number) {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

function formatDeltaKwh(value: number) {
  const signal = value > 0 ? "+" : "";
  return `${signal}${numberFormatter.format(value)} kWh`;
}

function getComparisonRows(history: SolarDashboardData["dailyHistory"]) {
  const last7 = [...history]
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 7);

  return last7.map((item, index) => {
    const previous = last7[index + 1];
    return {
      ...item,
      deltaKwh: previous ? item.generationKwh - previous.generationKwh : 0,
    };
  });
}

function sortComparisonRows(rows: ComparisonRow[], sortKey: SortKey, descending: boolean) {
  const direction = descending ? -1 : 1;

  return [...rows].sort((left, right) => {
    if (sortKey === "date") {
      return left.date.localeCompare(right.date) * direction;
    }

    return (left[sortKey] - right[sortKey]) * direction;
  });
}

function MetricCard({
  label,
  value,
  hint,
  accent = "from-[#fff6d8] to-white",
}: {
  label: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <article
      className={`rounded-[1.8rem] border border-[#f0d9a2] bg-gradient-to-br ${accent} p-5 shadow-[0_20px_60px_rgba(20,83,45,0.12)]`}
    >
      <p className="text-sm uppercase tracking-[0.18em] text-[#a86d00]">{label}</p>
      <p className="mt-3 text-3xl font-semibold text-[#0d5b3f]">{value}</p>
      {hint ? <p className="mt-2 text-sm text-[#355c4a]">{hint}</p> : null}
    </article>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[2rem] border border-[#d9e5d8] bg-white/92 p-6 shadow-[0_24px_80px_rgba(19,78,48,0.12)] backdrop-blur">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-[#0d5b3f]">{title}</h2>
        {subtitle ? <p className="text-sm text-[#557c69]">{subtitle}</p> : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function LineChart({ points }: { points: Array<{ label: string; value: number }> }) {
  if (!points.length) {
    return (
      <div className="rounded-2xl border border-dashed border-[#c7d8c5] px-4 py-10 text-center text-sm text-[#557c69]">
        Nao ha dados suficientes para montar este grafico ainda.
      </div>
    );
  }

  const width = 760;
  const height = 260;
  const maxValue = Math.max(...points.map((point) => point.value), 1);
  const stepX = points.length > 1 ? width / (points.length - 1) : width;

  const path = points
    .map((point, index) => {
      const x = index * stepX;
      const y = height - (point.value / maxValue) * (height - 20) - 10;
      return `${index === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-3xl border border-[#e6eddc] bg-[#fffdf5] p-4">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full">
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255, 181, 45, 0.35)" />
              <stop offset="100%" stopColor="rgba(255, 181, 45, 0)" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1="0"
              x2={width}
              y1={height - ratio * (height - 20)}
              y2={height - ratio * (height - 20)}
              stroke="rgba(19, 78, 48, 0.1)"
              strokeDasharray="4 8"
            />
          ))}
          <path d={`${path} L ${width} ${height} L 0 ${height} Z`} fill="url(#chart-fill)" />
          <path
            d={path}
            fill="none"
            stroke="#ff9d1c"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
          />
        </svg>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm text-[#355c4a] sm:grid-cols-4 lg:grid-cols-6">
        {points.map((point) => (
          <div
            key={point.label}
            className="rounded-2xl border border-[#ecf1e7] bg-[#fdf7df] px-3 py-3"
          >
            <p className="text-xs uppercase tracking-[0.12em] text-[#8b8e57]">{point.label}</p>
            <p className="mt-1 font-medium text-[#0d5b3f]">
              {numberFormatter.format(point.value)} kW
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function SortButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-3 py-2 text-xs font-medium transition ${
        active
          ? "bg-[#0d5b3f] text-white"
          : "bg-[#f8f3df] text-[#0d5b3f] hover:bg-[#efe5bf]"
      }`}
    >
      {label}
    </button>
  );
}

export function DashboardShell() {
  const [state, setState] = useState<ApiState>({ status: "loading" });
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [descending, setDescending] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      try {
        const [solarResponse, weatherResponse] = await Promise.all([
          fetch("/api/solar", { cache: "no-store" }),
          fetch("/api/weather", { cache: "no-store" }),
        ]);

        const solarPayload = (await solarResponse.json()) as SolarDashboardData | ApiError;
        const weatherPayload = (await weatherResponse.json()) as WeatherData | ApiError;

        if (!solarResponse.ok) {
          throw new Error(
            isApiError(solarPayload)
              ? solarPayload.detail || solarPayload.error || "Falha ao carregar dados."
              : "Falha ao carregar dados.",
          );
        }

        if (!weatherResponse.ok) {
          throw new Error(
            isApiError(weatherPayload)
              ? weatherPayload.detail || weatherPayload.error || "Falha ao carregar clima."
              : "Falha ao carregar clima.",
          );
        }

        if (!cancelled) {
          setState({
            status: "success",
            data: {
              solar: solarPayload as SolarDashboardData,
              weather: weatherPayload as WeatherData,
            },
          });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : "Nao foi possivel carregar o dashboard.",
          });
        }
      }
    }

    loadDashboard();
    const interval = window.setInterval(loadDashboard, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const comparisonRows =
    state.status === "success"
      ? sortComparisonRows(
          getComparisonRows(state.data.solar.dailyHistory),
          sortKey,
          descending,
        )
      : [];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(255,184,56,0.22),_transparent_22%),radial-gradient(circle_at_bottom_right,_rgba(26,112,76,0.18),_transparent_26%),linear-gradient(180deg,_#fff9eb_0%,_#f4fbf3_55%,_#eef8ef_100%)] px-5 py-8 text-[#103e2f] sm:px-8 lg:px-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="overflow-hidden rounded-[2.25rem] border border-[#f3dfa9] bg-[linear-gradient(135deg,_rgba(255,247,224,0.96)_0%,_rgba(255,234,183,0.92)_48%,_rgba(227,244,230,0.94)_100%)] p-6 shadow-[0_30px_120px_rgba(255,166,0,0.12)] sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-5">
              <div className="rounded-[2rem] bg-white/90 p-3 shadow-[0_10px_40px_rgba(16,62,47,0.12)]">
                <Image
                  src="/solee-logo.png"
                  alt="Logo Solee Energia Solar"
                  width={110}
                  height={110}
                  priority
                />
              </div>
              <div className="max-w-3xl">
                <p className="text-sm uppercase tracking-[0.26em] text-[#ff9d1c]">Dashboard</p>
                <h1 className="mt-3 text-4xl font-semibold tracking-tight text-[#0d5b3f] sm:text-5xl">
                  Dashboard de geracao de energia solar
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[#355c4a]">
                  Dashboard de geracao de energia solar.
                </p>
              </div>
            </div>
            <div className="rounded-3xl border border-white/70 bg-white/75 px-5 py-4 text-sm text-[#355c4a]">
              Atualizacao automatica a cada 60 segundos
            </div>
          </div>
        </header>

        {state.status === "loading" ? (
          <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-36 animate-pulse rounded-3xl border border-[#e4ead7] bg-white/80"
              />
            ))}
          </section>
        ) : null}

        {state.status === "error" ? (
          <SectionCard
            title="Falha ao carregar dados"
            subtitle="Confira credenciais, plant ID e disponibilidade dos servicos."
          >
            <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-700">
              {state.message}
            </p>
          </SectionCard>
        ) : null}

        {state.status === "success" ? (
          <>
            <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Geracao hoje"
                value={formatKwh(state.data.solar.summary.todayGenerationKwh)}
                hint={`Meta diaria: ${formatKwh(state.data.solar.summary.targetDailyKwh)}`}
                accent="from-[#fff6d8] to-[#fffdf5]"
              />
              <MetricCard
                label="Geracao mensal"
                value={formatKwh(state.data.solar.summary.monthlyGenerationKwh)}
                hint={`Total acumulado: ${compactNumberFormatter.format(state.data.solar.summary.totalGenerationKwh)} kWh`}
                accent="from-[#fef1c3] to-[#fffdf4]"
              />
              <MetricCard
                label="Venda hoje"
                value={formatCurrency(state.data.solar.summary.economyTodayBrl)}
                hint={`No mes: ${formatCurrency(state.data.solar.summary.economyMonthBrl)}`}
                accent="from-[#ffe7c0] to-[#fff7ea]"
              />
              <MetricCard
                label="Performance"
                value={`${numberFormatter.format(state.data.solar.summary.performancePct)}%`}
                hint={`Tarifa: ${formatCurrency(state.data.solar.summary.tariffKwhBrl)}/kWh`}
                accent="from-[#e8f6ea] to-[#f9fffb]"
              />
              <MetricCard
                label="Potencia atual"
                value={formatKw(state.data.solar.summary.currentPowerKw)}
                hint={state.data.solar.summary.plantName}
                accent="from-[#e8f6ea] to-[#f9fffb]"
              />
              <MetricCard
                label="Status da usina"
                value={state.data.solar.summary.statusLabel}
                hint={state.data.solar.summary.location || "Localizacao nao informada"}
                accent="from-[#f3f9e8] to-[#fbfff6]"
              />
              <MetricCard
                label="Venda total"
                value={formatCurrency(state.data.solar.summary.totalRevenueBrl)}
                hint={`Acumulado de ${compactNumberFormatter.format(state.data.solar.summary.totalGenerationKwh)} kWh`}
                accent="from-[#fff0ce] to-[#fffdf3]"
              />
              <MetricCard
                label="Ultima leitura"
                value={formatUpdatedAt(state.data.solar.summary.updatedAt)}
                hint="Horario da consulta ao backend"
                accent="from-[#f2f8ec] to-[#ffffff]"
              />
            </section>

            <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
              <SectionCard
                title="Resumo de venda de energia"
                subtitle="Quanto a usina gerou em reais com base na tarifa configurada."
              >
                <div className="grid gap-4 md:grid-cols-3">
                  <MetricCard
                    label="Venda hoje"
                    value={formatCurrency(state.data.solar.summary.economyTodayBrl)}
                    hint={`${formatKwh(state.data.solar.summary.todayGenerationKwh)} gerados hoje`}
                    accent="from-[#fff7de] to-[#fffef8]"
                  />
                  <MetricCard
                    label="Venda no mes"
                    value={formatCurrency(state.data.solar.summary.economyMonthBrl)}
                    hint={`${formatKwh(state.data.solar.summary.monthlyGenerationKwh)} acumulados no mes`}
                    accent="from-[#fff0d4] to-[#fffaf0]"
                  />
                  <MetricCard
                    label="Venda total"
                    value={formatCurrency(state.data.solar.summary.totalRevenueBrl)}
                    hint={`${formatKwh(state.data.solar.summary.totalGenerationKwh)} acumulados na usina`}
                    accent="from-[#edf7ef] to-[#fbfffc]"
                  />
                </div>
              </SectionCard>

              <SectionCard
                title="Previsao do tempo"
                subtitle={`Maravilha-AL | Atualizado em ${formatUpdatedAt(state.data.weather.updatedAt)}`}
              >
                <div className="grid gap-4">
                  <article className="rounded-[1.8rem] border border-[#f0dfae] bg-[linear-gradient(135deg,_#fff6d7,_#fffdf5)] p-5">
                    <p className="text-sm uppercase tracking-[0.18em] text-[#a86d00]">
                      Agora em {state.data.weather.location}
                    </p>
                    <div className="mt-3 flex items-end justify-between gap-4">
                      <div>
                        <p className="text-4xl font-semibold text-[#0d5b3f]">
                          {numberFormatter.format(state.data.weather.current.temperatureC)} C
                        </p>
                        <p className="mt-2 text-sm text-[#355c4a]">
                          {state.data.weather.current.weatherLabel}
                        </p>
                      </div>
                      <div className="text-right text-sm text-[#355c4a]">
                        <p>Chuva: {state.data.weather.current.precipitationProbabilityPct}%</p>
                        <p>Vento: {numberFormatter.format(state.data.weather.current.windKph)} km/h</p>
                      </div>
                    </div>
                  </article>
                  <div className="grid gap-3 md:grid-cols-3">
                    {state.data.weather.daily.map((day) => (
                      <article
                        key={day.date}
                        className="rounded-2xl border border-[#e7eddc] bg-[#fbfff8] px-4 py-4"
                      >
                        <p className="text-xs uppercase tracking-[0.14em] text-[#a86d00]">
                          {day.label}
                        </p>
                        <p className="mt-2 font-semibold text-[#0d5b3f]">{day.weatherLabel}</p>
                        <p className="mt-2 text-sm text-[#355c4a]">
                          Max {numberFormatter.format(day.tempMaxC)} C
                        </p>
                        <p className="text-sm text-[#355c4a]">
                          Min {numberFormatter.format(day.tempMinC)} C
                        </p>
                        <p className="mt-2 text-sm text-[#557c69]">
                          Chuva {day.precipitationProbabilityMaxPct}%
                        </p>
                      </article>
                    ))}
                  </div>
                </div>
              </SectionCard>
            </div>

            <div className="grid gap-6 xl:grid-cols-[1.35fr_0.95fr]">
              <SectionCard
                title="Geracao por hora"
                subtitle="Curva diaria de potencia retornada pela integracao do SEMS."
              >
                <LineChart
                  points={state.data.solar.hourlyChart.map((point) => ({
                    label: point.timeLabel,
                    value: point.powerKw,
                  }))}
                />
              </SectionCard>

              <SectionCard
                title="Status dos inversores"
                subtitle="Resumo por equipamento para operacao e acompanhamento."
              >
                <div className="space-y-3">
                  {state.data.solar.inverters.map((inverter) => (
                    <article
                      key={inverter.id}
                      className="rounded-3xl border border-[#e4ead7] bg-[#fcfff8] p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <h3 className="text-base font-semibold text-[#0d5b3f]">{inverter.name}</h3>
                          <p className="mt-1 text-sm text-[#557c69]">
                            {inverter.serialNumber || "SN nao informado"}
                          </p>
                        </div>
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ring-1 ${getStatusTone(inverter.status)}`}
                        >
                          {inverter.status}
                        </span>
                      </div>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl bg-[#fff8e8] px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-[#a86d00]">
                            Potencia
                          </p>
                          <p className="mt-1 font-medium text-[#0d5b3f]">
                            {formatKw(inverter.powerKw)}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-[#f4fbf2] px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-[#557c69]">
                            Hoje
                          </p>
                          <p className="mt-1 font-medium text-[#0d5b3f]">
                            {formatKwh(inverter.dayGenerationKwh)}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-[#f9fbf7] px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-[#557c69]">
                            Acumulado
                          </p>
                          <p className="mt-1 font-medium text-[#0d5b3f]">
                            {compactNumberFormatter.format(inverter.totalGenerationKwh)} kWh
                          </p>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </SectionCard>
            </div>

            <SectionCard
              title="Comparacao diaria dos ultimos 7 dias"
              subtitle="Tabela dinamica para acompanhar producao, venda estimada e variacao frente ao dia anterior."
            >
              <div className="mb-4 flex flex-wrap gap-2">
                <SortButton
                  active={sortKey === "date"}
                  label="Ordenar por data"
                  onClick={() => {
                    setSortKey("date");
                    setDescending(true);
                  }}
                />
                <SortButton
                  active={sortKey === "generationKwh"}
                  label="Ordenar por geracao"
                  onClick={() => {
                    setSortKey("generationKwh");
                    setDescending(true);
                  }}
                />
                <SortButton
                  active={sortKey === "economyBrl"}
                  label="Ordenar por receita"
                  onClick={() => {
                    setSortKey("economyBrl");
                    setDescending(true);
                  }}
                />
                <SortButton
                  active={sortKey === "deltaKwh"}
                  label="Ordenar por variacao"
                  onClick={() => {
                    setSortKey("deltaKwh");
                    setDescending(true);
                  }}
                />
                <SortButton
                  active={!descending}
                  label="Crescente"
                  onClick={() => setDescending(false)}
                />
                <SortButton
                  active={descending}
                  label="Decrescente"
                  onClick={() => setDescending(true)}
                />
              </div>

              <div className="overflow-hidden rounded-3xl border border-[#e4ead7]">
                <table className="min-w-full divide-y divide-[#e8edde] text-left text-sm">
                  <thead className="bg-[#fff6df] text-[#0d5b3f]">
                    <tr>
                      <th className="px-4 py-3 font-medium">Dia</th>
                      <th className="px-4 py-3 font-medium">Geracao</th>
                      <th className="px-4 py-3 font-medium">Receita</th>
                      <th className="px-4 py-3 font-medium">Variacao</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#edf1e8] bg-white text-[#103e2f]">
                    {comparisonRows.map((item) => (
                      <tr key={item.date}>
                        <td className="px-4 py-3">{item.label}</td>
                        <td className="px-4 py-3">{formatKwh(item.generationKwh)}</td>
                        <td className="px-4 py-3">{formatCurrency(item.economyBrl)}</td>
                        <td className={`px-4 py-3 font-medium ${getDeltaTone(item.deltaKwh)}`}>
                          {formatDeltaKwh(item.deltaKwh)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </>
        ) : null}
      </div>
    </main>
  );
}
