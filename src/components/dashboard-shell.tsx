"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { OutageHistory } from "@/components/outage-history";
import { PeriodAnalysis } from "@/components/period-analysis";
import { PlantHealth } from "@/components/plant-health";
import { cf, cp, nf } from "@/lib/format";

// --- Tipagens ---
type ApiState = { status: "loading" } | { status: "error"; message: string } | { status: "success"; data: any };

type WeatherDay = {
  date: string;
  label: string;
  tempMaxC: number;
  tempMinC: number;
  precipitationProbabilityMaxPct: number;
  weatherLabel: string;
};

function MetricCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "bad" }) {
  return (
    <article className="rounded-[1.5rem] border p-5 shadow-sm bg-white dark:bg-[#12241a] border-slate-200 dark:border-emerald-800/30 transition-all hover:scale-[1.01]">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#7c4a03] dark:text-[#f8b93c]">{label}</p>
      <p
        className={`mt-2 text-2xl font-black ${
          tone === "bad" ? "text-rose-600 dark:text-rose-400" : tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-[#052e16] dark:text-white"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs font-bold text-slate-500 dark:text-emerald-300/40">{hint}</p>}
    </article>
  );
}

function statusBadge(status: string) {
  if (status === "Gerando") return "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
  if (status === "Standby") return "bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-300";
  return "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400";
}

export function DashboardShell() {
  const [state, setState] = useState<ApiState>({ status: "loading" });
  const [isDark, setIsDark] = useState(false);
  const [hoverData, setHoverData] = useState<any>(null);
  const [staleSince, setStaleSince] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("theme") === "dark";
    setIsDark(saved);
    if (saved) document.documentElement.classList.add("dark");

    let hasData = false;

    async function loadData() {
      try {
        const [s, w] = await Promise.all([
          fetch("/api/solar", { cache: "no-store" }),
          fetch("/api/weather"),
        ]);
        if (s.status === 401 || w.status === 401) {
          window.location.reload();
          return;
        }
        const sData = await s.json();
        const wData = await w.json();

        if (!s.ok || sData?.error) {
          const message = `${sData?.error || "Falha ao consultar a usina."}${sData?.detail ? ` ${sData.detail}` : ""}`;
          // Se ja ha dados na tela, mantem os ultimos e avisa que estao desatualizados.
          if (hasData) {
            setStaleSince((current) => current ?? new Date().toISOString());
            return;
          }
          setState({ status: "error", message });
          return;
        }

        hasData = true;
        setStaleSince(null);
        setState({ status: "success", data: { solar: sData, weather: wData?.error ? null : wData } });
      } catch {
        if (!hasData) setState({ status: "error", message: "Erro ao carregar dados da API." });
        else setStaleSince((current) => current ?? new Date().toISOString());
      }
    }

    loadData();
    const interval = window.setInterval(loadData, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  if (state.status === "loading") return <div className="flex min-h-screen items-center justify-center dark:bg-[#060d09] dark:text-white font-black animate-pulse uppercase">Sincronizando Usina Solar...</div>;
  if (state.status === "error") return <div className="flex min-h-screen items-center justify-center px-6 text-center text-red-500 font-black">{state.message}</div>;

  const { solar, weather } = state.data;

  // --- Dados base ---
  const summary = solar?.summary || {};
  const hourlyData = solar?.hourlyChart || [];
  const inverters = solar?.inverters || [];
  const dailyHistory = solar?.dailyHistory || [];
  const monthlyHistory = solar?.monthlyHistory || [];
  const tariff = summary.tariffKwhBrl || 0;
  const today: string = summary.stationToday || new Date().toISOString().slice(0, 10);
  const dailyTargetKwh = summary.targetDailyKwh || 0;
  const todayKwh = summary.todayGenerationKwh || 0;
  const capacityKwp: number | null = summary.capacityKwp || null;
  const weatherDays: WeatherDay[] = weather?.daily || [];
  const generatingCount = inverters.filter((inv: any) => inv.status === "Gerando" || inv.powerKw > 0).length;

  // --- Gráfico de linha (curva de hoje) ---
  const widthLine = 1000;
  const heightLine = 300;
  let pointsLine = hourlyData.map((p: any) => ({ label: p.timeLabel, value: p.powerKw }));

  if (pointsLine.length === 0) {
    pointsLine = [
      { label: "00:00", value: 0 },
      { label: "06:00", value: 0 },
      { label: "12:00", value: 0 },
      { label: "18:00", value: 0 },
      { label: "23:59", value: 0 },
    ];
  } else {
    if (pointsLine[0].label > "00:00") pointsLine.unshift({ label: "00:00", value: 0 });
    const lastPoint = pointsLine[pointsLine.length - 1];
    if (lastPoint.label < "23:59") pointsLine.push({ label: "23:59", value: 0 });
  }

  const maxLineVal = Math.max(...pointsLine.map((p: any) => p.value), 1);
  const stepXLine = widthLine / (pointsLine.length > 1 ? pointsLine.length - 1 : 1);
  const svgPointsLine = pointsLine.map((p: any, i: number) => ({
    x: i * stepXLine,
    y: heightLine - (p.value / maxLineVal) * (heightLine - 80) - 40,
    ...p,
  }));
  const pathD = svgPointsLine.map((p: any, i: number) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");

  return (
    <main className="min-h-screen bg-[#f8fafc] p-4 transition-colors duration-300 dark:bg-[#060d09] sm:p-8">
      <div className="mx-auto max-w-7xl space-y-8">

        {/* HEADER */}
        <header className="flex flex-col items-center justify-between gap-6 rounded-[2.5rem] bg-[#0d2a1d] p-8 shadow-2xl md:flex-row border border-emerald-900/50">
          <div className="flex items-center gap-5">
            <div className="rounded-2xl bg-white p-3 shadow-lg"><Image src="/solee-logo.png" alt="Logo" width={60} height={60} priority /></div>
            <div>
              <h1 className="text-2xl font-black text-white sm:text-3xl">Geração de Energia Solar</h1>
              <p className="text-xs text-emerald-100/40 font-medium uppercase tracking-widest mt-1">
                {summary.plantName || "Usina Maravilha-AL"} | {inverters.length} inversores
                {capacityKwp ? ` · ${nf.format(capacityKwp)} kWp` : ""}
                <br className="sm:hidden" />
                <span className="hidden sm:inline"> • </span>
                Última leitura: {summary.updatedAt ? new Date(summary.updatedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "--"}
              </p>
              {staleSince && (
                <p className="mt-2 inline-block rounded-full bg-amber-500/20 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-amber-300">
                  Sem conexão com o SEMS+ desde {new Date(staleSince).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · mostrando os últimos dados
                </p>
              )}
            </div>
          </div>
          <button onClick={() => {
            const next = !isDark;
            setIsDark(next);
            document.documentElement.classList.toggle("dark");
            localStorage.setItem("theme", next ? "dark" : "light");
          }} className="rounded-2xl border border-white/10 bg-white/5 px-8 py-3 text-[10px] font-black text-white uppercase tracking-widest hover:bg-white/10 transition-colors">
            {isDark ? "MODO CLARO ☀️" : "MODO ESCURO 🌙"}
          </button>
        </header>

        {/* CARDS DE MÉTRICAS */}
        <section className="grid gap-4 grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Geração Hoje" value={nf.format(todayKwh) + " kWh"} hint={`Meta diária: ${nf.format(dailyTargetKwh)} kWh`} />
          <MetricCard label="Geração no Mês" value={nf.format(summary.monthlyGenerationKwh || 0) + " kWh"} hint={cf.format(summary.economyMonthBrl || 0) + " em venda estimada"} />
          <MetricCard label="Venda Hoje" value={cf.format(summary.economyTodayBrl || 0)} hint={`Tarifa: ${cf.format(tariff)}/kWh`} />
          <MetricCard
            label="Meta de Hoje"
            value={nf.format(summary.performancePct || 0) + "%"}
            tone={(summary.performancePct || 0) >= 100 ? "ok" : undefined}
            hint={capacityKwp ? `${nf.format(todayKwh / capacityKwp)} kWh/kWp hoje` : "da meta diária"}
          />
          <MetricCard label="Potência Atual" value={nf.format(summary.currentPowerKw || 0) + " kW"} hint={capacityKwp ? `${nf.format(((summary.currentPowerKw || 0) / capacityKwp) * 100)}% da capacidade` : "Soma de todos inversores"} />
          <MetricCard
            label="Status da Usina"
            value={summary.statusLabel || "--"}
            tone={summary.statusLabel === "Gerando" ? "ok" : summary.statusLabel === "Offline" || summary.statusLabel === "Falha" ? "bad" : undefined}
            hint={`${generatingCount} de ${inverters.length} inversores gerando`}
          />
          <MetricCard label="Venda Total" value={cf.format(summary.totalRevenueBrl || 0)} hint="Acumulado histórico" />
          <MetricCard label="Geração Total" value={nf.format(summary.totalGenerationKwh || 0) + " kWh"} hint="Acumulado histórico" />
        </section>

        {/* ALERTAS E META */}
        <PlantHealth
          today={today}
          todayKwh={todayKwh}
          monthKwh={summary.monthlyGenerationKwh || 0}
          tariff={tariff}
          targetDailyKwh={dailyTargetKwh}
          dailyHistory={dailyHistory}
          monthlyHistory={monthlyHistory}
          inverters={inverters}
          plantStatus={summary.statusLabel || ""}
          errorLog={solar?.errorLog}
          tomorrow={weatherDays[1] ?? null}
        />

        {/* HISTÓRICO DE PARADAS */}
        <OutageHistory
          today={today}
          inverters={inverters.map((inv: any) => ({ id: inv.id, name: inv.name }))}
        />

        {/* ANÁLISE POR PERÍODO */}
        <PeriodAnalysis
          today={today}
          tariff={tariff}
          targetDailyKwh={dailyTargetKwh}
          capacityKwp={capacityKwp}
          liveTodayKwh={todayKwh}
          liveMonthKwh={summary.monthlyGenerationKwh || 0}
        />

        {/* CURVA DE HOJE */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-5 sm:p-8 shadow-sm border border-slate-200 dark:border-emerald-900/30 relative">
          <div className="mb-8">
            <h2 className="text-xl font-black text-[#052e16] dark:text-white">Potência ao longo de hoje</h2>
            <p className="text-xs text-slate-500 dark:text-emerald-400/50 font-bold">
              Montada com as leituras feitas pelo painel a cada minuto enquanto ele está aberto.
            </p>
          </div>
          <div className="relative h-[300px] w-full">
            <svg viewBox={`0 0 ${widthLine} ${heightLine}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <path d={`${pathD} L ${widthLine} ${heightLine} L 0 ${heightLine} Z`} fill="url(#sun-grad)" className="opacity-40" />
              <path d={pathD} fill="none" stroke="#f8b93c" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
              <defs>
                <linearGradient id="sun-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f8b93c" /><stop offset="100%" stopColor="#f8b93c" stopOpacity="0" />
                </linearGradient>
              </defs>
              {svgPointsLine.map((p: any, i: number) => (
                <rect key={i} x={p.x - 15} y="0" width="30" height={heightLine} fill="transparent" className="cursor-pointer"
                  onMouseEnter={() => setHoverData(p)} onMouseLeave={() => setHoverData(null)} />
              ))}
            </svg>
            {hoverData && (
              <div className="absolute z-20 p-4 rounded-2xl bg-[#0d1a12] border-2 border-amber-500 text-white shadow-2xl pointer-events-none"
                style={{ left: `${(hoverData.x / widthLine) * 100}%`, top: `${(hoverData.y / heightLine) * 100 - 40}%`, transform: "translateX(-50%)" }}>
                <p className="text-[10px] font-black text-amber-400 uppercase">{hoverData.label}</p>
                <p className="text-2xl font-black">{nf.format(hoverData.value)} kW</p>
                <p className="text-[9px] opacity-60 font-bold">Produção total combinada</p>
              </div>
            )}
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* VALOR ESTIMADO */}
          <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-5 sm:p-8 border border-slate-200 dark:border-emerald-900/30 text-center flex flex-col justify-center">
            <h2 className="text-xl font-black mb-2 dark:text-white">Valor estimado da usina</h2>
            <p className="text-xs font-bold text-slate-500 dark:text-emerald-400/50 mb-6">Calculado com a tarifa de {cf.format(tariff)}/kWh</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="p-4 rounded-3xl bg-amber-50 dark:bg-amber-900/10 border border-amber-100/50 dark:border-amber-900/30">
                <p className="text-[9px] font-black uppercase text-amber-700">Hoje</p>
                <p className="text-lg font-black dark:text-white">{cf.format(summary.economyTodayBrl || 0)}</p>
              </div>
              <div className="p-4 rounded-3xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100/50 dark:border-emerald-900/30">
                <p className="text-[9px] font-black uppercase text-emerald-700">No Mês</p>
                <p className="text-lg font-black dark:text-white">{cf.format(summary.economyMonthBrl || 0)}</p>
              </div>
              <div className="p-4 rounded-3xl bg-blue-50 dark:bg-blue-900/10 border border-blue-100/50 dark:border-blue-900/30">
                <p className="text-[9px] font-black uppercase text-blue-700">Total</p>
                <p className="text-lg font-black dark:text-white">{cf.format(summary.totalRevenueBrl || 0)}</p>
              </div>
            </div>
          </section>

          {/* PREVISÃO DO TEMPO */}
          <section className="rounded-[2.5rem] p-5 sm:p-8 shadow-sm border transition-all duration-300 bg-white dark:bg-[#09120d] border-slate-200 dark:border-emerald-900/50">
            <div className="flex items-center justify-between mb-8">
              <p className="text-[10px] font-black uppercase text-emerald-600 dark:text-emerald-400 tracking-[0.2em]">Clima em {weather?.location || "Maravilha, AL"}</p>
              <p className="text-[10px] font-bold text-slate-400 dark:text-white/40">
                {weather?.current ? `Agora: ${nf.format(weather.current.temperatureC)}° · vento ${nf.format(weather.current.windKph)} km/h` : "Previsão indisponível"}
              </p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              {(weatherDays.length ? weatherDays : [null, null, null]).slice(0, 3).map((day, index) => (
                <div key={day?.date ?? index} className="p-4 rounded-2xl border transition-all bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10">
                  <p className="text-[9px] font-black text-amber-600 dark:text-amber-400 uppercase mb-2">{day?.label ?? ["Hoje", "Amanhã", "Depois"][index]}</p>
                  <p className="text-3xl font-black text-[#052e16] dark:text-white">{day ? `${Math.round(day.tempMaxC)}°` : "--"}</p>
                  <p className="text-[10px] font-bold mt-1 text-slate-600 dark:text-white/80 uppercase">{day?.weatherLabel ?? "--"}</p>
                  <div className="mt-3 space-y-1">
                    <p className="text-[9px] font-bold text-blue-500 uppercase">Chuva: {day ? `${day.precipitationProbabilityMaxPct}%` : "--"}</p>
                    <p className="text-[9px] font-medium text-slate-400 dark:text-white/40 uppercase">Mín: {day ? `${Math.round(day.tempMinC)}°` : "--"}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* STATUS DOS INVERSORES */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-5 sm:p-8 border border-slate-200 dark:border-emerald-900/30">
          <div className="flex flex-wrap justify-between items-end gap-2 mb-8">
            <h2 className="text-xl font-black dark:text-white">Status dos inversores</h2>
            <span className="text-[10px] font-black uppercase text-slate-500 dark:text-emerald-300/60">{generatingCount} de {inverters.length} gerando</span>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            {inverters.map((inv: any) => {
              const share = todayKwh > 0 ? (inv.dayGenerationKwh / todayKwh) * 100 : 0;
              return (
                <div key={inv.id} className="rounded-[2rem] bg-slate-50 dark:bg-[#0d1a12] p-6 border border-slate-100 dark:border-emerald-900/20 hover:border-emerald-500/30 transition-colors">
                  <div className="flex justify-between items-center gap-3 mb-6">
                    <div className="min-w-0">
                      <p className="truncate text-lg font-black dark:text-white uppercase tracking-tight">{inv.name}</p>
                      <p className="text-[9px] font-mono opacity-40 dark:text-white">{inv.serialNumber || "--"}</p>
                    </div>
                    <span className={`shrink-0 px-4 py-1 rounded-full text-[10px] font-black uppercase ${statusBadge(inv.status)}`}>{inv.status}</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center text-[9px] font-black">
                    <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                      <p className="uppercase text-slate-400 mb-1">Potência</p>
                      <p className="text-sm dark:text-white">{nf.format(inv.powerKw)} kW</p>
                    </div>
                    <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                      <p className="uppercase text-slate-400 mb-1">Hoje</p>
                      <p className="text-sm dark:text-white">{nf.format(inv.dayGenerationKwh)} kWh</p>
                    </div>
                    <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                      <p className="uppercase text-slate-400 mb-1">No mês</p>
                      <p className="text-sm dark:text-white">{cp.format(inv.monthGenerationKwh || 0)} kWh</p>
                    </div>
                    <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                      <p className="uppercase text-slate-400 mb-1">Total</p>
                      <p className="text-sm dark:text-white">{cp.format(inv.totalGenerationKwh)} kWh</p>
                    </div>
                  </div>
                  {inverters.length > 1 && (
                    <div className="mt-4">
                      <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-white/5">
                        <div className="h-full rounded-full bg-amber-400" style={{ width: `${Math.min(100, share)}%` }} />
                      </div>
                      <p className="mt-1 text-[10px] font-bold text-slate-400">
                        {nf.format(share)}% da geração de hoje (esperado ~{nf.format(100 / inverters.length)}% se forem iguais)
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </main>
  );
}
