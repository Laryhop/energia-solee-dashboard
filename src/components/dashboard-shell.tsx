"use client";

import { useEffect, useState } from "react";

type ApiState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: SolarDashboardData };

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

function isApiError(
  payload: SolarDashboardData | { error?: string; detail?: string },
): payload is { error?: string; detail?: string } {
  return "error" in payload || "detail" in payload;
}

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
    return "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30";
  }

  if (normalized.includes("standby") || normalized.includes("espera")) {
    return "bg-amber-500/20 text-amber-100 ring-amber-400/30";
  }

  if (normalized.includes("offline") || normalized.includes("falha")) {
    return "bg-rose-500/20 text-rose-100 ring-rose-400/30";
  }

  return "bg-slate-500/20 text-slate-100 ring-slate-400/30";
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <article className="rounded-3xl border border-white/10 bg-white/6 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.28)] backdrop-blur">
      <p className="text-sm uppercase tracking-[0.18em] text-slate-300/70">
        {label}
      </p>
      <p className="mt-3 text-3xl font-semibold text-white">{value}</p>
      {hint ? <p className="mt-2 text-sm text-slate-300/80">{hint}</p> : null}
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
    <section className="rounded-[2rem] border border-white/10 bg-slate-950/55 p-6 shadow-[0_30px_120px_rgba(3,7,18,0.55)]">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        {subtitle ? <p className="text-sm text-slate-300/70">{subtitle}</p> : null}
      </div>
      <div className="mt-6">{children}</div>
    </section>
  );
}

function LineChart({
  points,
  colorClassName,
  suffix,
}: {
  points: Array<{ label: string; value: number }>;
  colorClassName: string;
  suffix: string;
}) {
  if (!points.length) {
    return (
      <div className="rounded-2xl border border-dashed border-white/10 px-4 py-10 text-center text-sm text-slate-300/70">
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
      <div className="overflow-hidden rounded-3xl border border-white/8 bg-slate-900/70 p-4">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-64 w-full">
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(251, 191, 36, 0.45)" />
              <stop offset="100%" stopColor="rgba(251, 191, 36, 0)" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1="0"
              x2={width}
              y1={height - ratio * (height - 20)}
              y2={height - ratio * (height - 20)}
              stroke="rgba(148, 163, 184, 0.14)"
              strokeDasharray="4 8"
            />
          ))}
          <path d={`${path} L ${width} ${height} L 0 ${height} Z`} fill="url(#chart-fill)" />
          <path
            d={path}
            fill="none"
            stroke="rgba(251, 191, 36, 0.95)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
          />
        </svg>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm text-slate-300/80 sm:grid-cols-4 lg:grid-cols-6">
        {points.map((point) => (
          <div
            key={point.label}
            className={`rounded-2xl border border-white/8 px-3 py-3 ${colorClassName}`}
          >
            <p className="text-xs uppercase tracking-[0.12em] text-slate-300/60">
              {point.label}
            </p>
            <p className="mt-1 font-medium text-white">
              {numberFormatter.format(point.value)}
              {suffix}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DashboardShell() {
  const [state, setState] = useState<ApiState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function loadDashboard() {
      try {
        const response = await fetch("/api/solar", {
          cache: "no-store",
        });

        const payload = (await response.json()) as
          | SolarDashboardData
          | { error?: string; detail?: string };

        if (!response.ok) {
          throw new Error(
            isApiError(payload)
              ? payload.detail || payload.error || "Falha ao carregar dados."
              : "Falha ao carregar dados.",
          );
        }

        if (!cancelled) {
          setState({ status: "success", data: payload as SolarDashboardData });
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

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(250,204,21,0.16),_transparent_30%),radial-gradient(circle_at_top_right,_rgba(14,165,233,0.18),_transparent_28%),linear-gradient(160deg,_#08111f_0%,_#0f172a_45%,_#111827_100%)] px-5 py-8 text-slate-100 sm:px-8 lg:px-12">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="overflow-hidden rounded-[2rem] border border-white/10 bg-white/7 p-6 shadow-[0_40px_140px_rgba(15,23,42,0.45)] backdrop-blur sm:p-8">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm uppercase tracking-[0.24em] text-amber-200/70">
                Next.js + Vercel
              </p>
              <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Dashboard da usina solar
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-slate-200/80">
                Monitoramento de geracao, economia, performance e status dos inversores
                com atualizacao automatica e integracao com o SEMS Portal.
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-slate-950/40 px-5 py-4 text-sm text-slate-300">
              Atualizacao automatica a cada 60 segundos
            </div>
          </div>
        </header>

        {state.status === "loading" ? (
          <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                key={index}
                className="h-36 animate-pulse rounded-3xl border border-white/8 bg-white/6"
              />
            ))}
          </section>
        ) : null}

        {state.status === "error" ? (
          <SectionCard
            title="Falha ao carregar dados"
            subtitle="Confira credenciais, plant ID e disponibilidade do SEMS Portal."
          >
            <p className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-4 text-sm text-rose-100">
              {state.message}
            </p>
          </SectionCard>
        ) : null}

        {state.status === "success" ? (
          <>
            <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                label="Geracao hoje"
                value={formatKwh(state.data.summary.todayGenerationKwh)}
                hint={`Meta diaria: ${formatKwh(state.data.summary.targetDailyKwh)}`}
              />
              <MetricCard
                label="Geracao mensal"
                value={formatKwh(state.data.summary.monthlyGenerationKwh)}
                hint={`Total acumulado: ${compactNumberFormatter.format(state.data.summary.totalGenerationKwh)} kWh`}
              />
              <MetricCard
                label="Economia"
                value={formatCurrency(state.data.summary.economyTodayBrl)}
                hint={`No mes: ${formatCurrency(state.data.summary.economyMonthBrl)}`}
              />
              <MetricCard
                label="Performance"
                value={`${numberFormatter.format(state.data.summary.performancePct)}%`}
                hint={`Tarifa: ${formatCurrency(state.data.summary.tariffKwhBrl)}/kWh`}
              />
              <MetricCard
                label="Potencia atual"
                value={formatKw(state.data.summary.currentPowerKw)}
                hint={state.data.summary.plantName}
              />
              <MetricCard
                label="Status da usina"
                value={state.data.summary.statusLabel}
                hint={state.data.summary.location || "Localizacao nao informada"}
              />
              <MetricCard
                label="Historico"
                value={`${state.data.dailyHistory.length} dias`}
                hint="Base para tendencia recente"
              />
              <MetricCard
                label="Ultima leitura"
                value={formatUpdatedAt(state.data.summary.updatedAt)}
                hint="Horário da consulta ao backend"
              />
            </section>

            <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
              <SectionCard
                title="Geracao por hora"
                subtitle="Curva diaria de potencia retornada pela integracao do SEMS."
              >
                <LineChart
                  points={state.data.hourlyChart.map((point) => ({
                    label: point.timeLabel,
                    value: point.powerKw,
                  }))}
                  colorClassName="bg-slate-900/70"
                  suffix=" kW"
                />
              </SectionCard>

              <SectionCard
                title="Status dos inversores"
                subtitle="Resumo por equipamento para operacao e suporte."
              >
                <div className="space-y-3">
                  {state.data.inverters.map((inverter) => (
                    <article
                      key={inverter.id}
                      className="rounded-3xl border border-white/10 bg-white/5 p-4"
                    >
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <h3 className="text-base font-semibold text-white">{inverter.name}</h3>
                          <p className="mt-1 text-sm text-slate-300/70">
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
                        <div className="rounded-2xl bg-slate-900/70 px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-slate-400">
                            Potencia
                          </p>
                          <p className="mt-1 font-medium text-white">
                            {formatKw(inverter.powerKw)}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-slate-900/70 px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-slate-400">
                            Hoje
                          </p>
                          <p className="mt-1 font-medium text-white">
                            {formatKwh(inverter.dayGenerationKwh)}
                          </p>
                        </div>
                        <div className="rounded-2xl bg-slate-900/70 px-3 py-3">
                          <p className="text-xs uppercase tracking-[0.12em] text-slate-400">
                            Acumulado
                          </p>
                          <p className="mt-1 font-medium text-white">
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
              title="Historico diario"
              subtitle="Ultimos dias de geracao e impacto financeiro estimado."
            >
              <div className="overflow-hidden rounded-3xl border border-white/10">
                <table className="min-w-full divide-y divide-white/10 text-left text-sm">
                  <thead className="bg-white/5 text-slate-300">
                    <tr>
                      <th className="px-4 py-3 font-medium">Dia</th>
                      <th className="px-4 py-3 font-medium">Geracao</th>
                      <th className="px-4 py-3 font-medium">Economia</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/8 bg-slate-950/40 text-slate-100">
                    {state.data.dailyHistory.map((item) => (
                      <tr key={item.date}>
                        <td className="px-4 py-3">{item.label}</td>
                        <td className="px-4 py-3">{formatKwh(item.generationKwh)}</td>
                        <td className="px-4 py-3">{formatCurrency(item.economyBrl)}</td>
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
