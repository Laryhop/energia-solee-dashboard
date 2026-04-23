"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

// --- Tipagens ---
type ApiState = 
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: any };

// --- Formatadores ---
const numberFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const compactNumberFormatter = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

function formatKwh(value: number) { return `${numberFormatter.format(value)} kWh`; }
function formatKw(value: number) { return `${numberFormatter.format(value)} kW`; }
function formatCurrency(value: number) { return currencyFormatter.format(value); }

// --- Sub-componentes de UI ---
function MetricCard({ label, value, hint, accent = "from-[#fff6d8] to-white" }: any) {
  return (
    <article className={`rounded-[1.8rem] border p-5 shadow-sm transition-all border-[#f0d9a2] bg-gradient-to-br ${accent} dark:border-[#2f4938] dark:from-[#14271b] dark:to-[#0d1a12]`}>
      <p className="text-[10px] font-black uppercase tracking-[0.15em] text-[#78350f] dark:text-[#f8b93c]">{label}</p>
      <p className="mt-2 text-2xl font-black text-[#064e3b] dark:text-[#f0fdf4]">{value}</p>
      {hint && <p className="mt-1 text-xs font-bold text-[#374151] dark:text-[#a8c1af] opacity-80">{hint}</p>}
    </article>
  );
}

function OriginalLineChart({ points, isDark }: { points: any[], isDark: boolean }) {
  if (!points || points.length === 0) return null;
  const width = 800;
  const height = 180;
  const maxValue = Math.max(...points.map(p => p.value), 0.1);
  const stepX = width / (points.length - 1);
  const pts = points.map((p, i) => ({
    x: i * stepX,
    y: height - (p.value / maxValue) * (height - 40) - 20
  }));
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <div className="w-full overflow-hidden rounded-2xl bg-[#fffdf5] p-4 dark:bg-[#0d1a12] border border-[#e6eddc] dark:border-[#1e3326]">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-40">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff9d1c" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#ff9d1c" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill="url(#grad)" />
        <path d={d} fill="none" stroke="#ff9d1c" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function DashboardShell() {
  const [state, setState] = useState<ApiState>({ status: "loading" });
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("theme") === "dark";
    setIsDark(saved);
    if (saved) document.documentElement.classList.add("dark");
    
    async function loadData() {
      try {
        const [s, w] = await Promise.all([fetch("/api/solar"), fetch("/api/weather")]);
        setState({ status: "success", data: { solar: await s.json(), weather: await w.json() } });
      } catch (e) {
        setState({ status: "error", message: "Erro ao carregar dados da API." });
      }
    }
    loadData();
  }, []);

  const toggleTheme = () => {
    const newTheme = !isDark;
    setIsDark(newTheme);
    if (newTheme) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  };

  if (state.status === "loading") return <div className="p-20 text-center dark:bg-[#09120d] dark:text-white">Carregando...</div>;
  if (state.status === "error") return <div className="p-20 text-rose-500">{state.message}</div>;

  const { solar, weather } = state.data;

  return (
    <main className="min-h-screen bg-[#f8faf8] p-4 transition-colors duration-300 dark:bg-[#09120d] sm:p-8">
      <div className="mx-auto max-w-7xl space-y-8">
        
        {/* HEADER */}
        <header className="flex flex-col items-center justify-between gap-6 rounded-[2.25rem] bg-[#0d2a1d] p-6 shadow-xl md:flex-row border border-emerald-900">
          <div className="flex items-center gap-4">
            <div className="rounded-2xl bg-white p-2">
              <Image src="/solee-logo.png" alt="Logo" width={50} height={50} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase text-[#f8b93c] tracking-widest">Dashboard</p>
              <h1 className="text-xl font-bold text-white">Dashboard de geração de energia solar</h1>
            </div>
          </div>
          <button onClick={toggleTheme} className="rounded-xl border border-white/20 bg-white/10 px-6 py-2 text-xs font-bold text-white hover:bg-white/20">
            {isDark ? "MODO CLARO ☀️" : "MODO ESCURO 🌙"}
          </button>
        </header>

        {/* MÉTRICAS (8 CARDS) */}
        <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Geração Hoje" value={formatKwh(solar.summary.todayGenerationKwh)} hint={`Meta: ${solar.summary.targetDailyKwh} kWh`} />
          <MetricCard label="Geração Mensal" value={formatKwh(solar.summary.monthlyGenerationKwh)} hint={`Total: ${compactNumberFormatter.format(solar.summary.totalGenerationKwh)}`} accent="from-[#fef1c3] to-white" />
          <MetricCard label="Venda Hoje" value={formatCurrency(solar.summary.economyTodayBrl)} hint="Venda estimada" accent="from-[#ffe7c0] to-white" />
          <MetricCard label="Performance" value={`${solar.summary.performancePct}%`} hint={`Tarifa: ${formatCurrency(solar.summary.tariffKwhBrl)}`} accent="from-[#e8f6ea] to-white" />
          <MetricCard label="Potência Atual" value={formatKw(solar.summary.currentPowerKw)} hint={solar.summary.plantName} accent="from-[#e8f6ea] to-white" />
          <MetricCard label="Status Usina" value={solar.summary.statusLabel} hint={solar.summary.location} accent="from-[#f3f9e8] to-white" />
          <MetricCard label="Venda Total" value={formatCurrency(solar.summary.totalRevenueBrl)} hint="Acumulado histórico" accent="from-[#fff0ce] to-white" />
          <MetricCard label="Última Leitura" value={new Date(solar.summary.updatedAt).toLocaleTimeString()} hint="Horário do servidor" accent="from-[#f2f8ec] to-white" />
        </section>

        {/* GRÁFICO */}
        <section className="rounded-[2rem] bg-white p-6 shadow-sm dark:bg-[#102418] border border-gray-100 dark:border-emerald-900/30">
          <h2 className="mb-4 text-lg font-bold text-[#064e3b] dark:text-emerald-400">Geração por hora</h2>
          <OriginalLineChart isDark={isDark} points={solar.hourlyChart.map((p: any) => ({ label: p.timeLabel, value: p.powerKw }))} />
        </section>

        {/* SEÇÃO DUPLA */}
        <div className="grid gap-8 lg:grid-cols-2">
          <section className="rounded-[2rem] bg-white p-6 shadow-sm dark:bg-[#102418] border border-gray-100 dark:border-emerald-900/30">
            <h2 className="mb-4 text-lg font-bold text-[#064e3b] dark:text-emerald-400">Status dos Inversores</h2>
            <div className="space-y-3">
              {solar.inverters.map((inv: any) => (
                <div key={inv.id} className="flex justify-between p-4 rounded-xl border dark:border-[#31483a] dark:bg-[#16271c]">
                  <span className="font-bold dark:text-white">{inv.name}</span>
                  <span className="font-bold text-emerald-600">{formatKw(inv.powerKw)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[2rem] bg-gradient-to-br from-[#0d2a1d] to-[#1a4d36] p-6 text-white">
            <h2 className="mb-4 text-lg font-bold text-[#f8b93c]">Previsão do Tempo</h2>
            <div className="flex justify-between items-end">
              <div>
                <p className="text-4xl font-black">{weather.current.temperatureC}°C</p>
                <p className="opacity-80">{weather.current.weatherLabel}</p>
              </div>
              <div className="text-right text-xs opacity-70">
                <p>Chuva: {weather.current.precipitationProbabilityPct}%</p>
                <p>Vento: {weather.current.windKph} km/h</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
