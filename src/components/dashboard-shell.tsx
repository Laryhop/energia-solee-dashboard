"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

// --- Tipagens ---
type ApiState = { status: "loading" } | { status: "error"; message: string } | { status: "success"; data: any };

// --- Formatadores de Dados ---
const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const cf = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const cp = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

// --- Componente de Card de Métrica ---
function MetricCard({ label, value, hint }: any) {
  return (
    <article className="rounded-[1.5rem] border p-5 shadow-sm bg-white dark:bg-[#12241a] border-slate-200 dark:border-emerald-800/30 transition-all">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#7c4a03] dark:text-[#f8b93c]">{label}</p>
      <p className="mt-2 text-2xl font-black text-[#052e16] dark:text-white">{value}</p>
      {hint && <p className="mt-1 text-xs font-bold text-slate-500 dark:text-emerald-300/40">{hint}</p>}
    </article>
  );
}

export function DashboardShell() {
  const [state, setState] = useState<ApiState>({ status: "loading" });
  const [isDark, setIsDark] = useState(false);
  const [hoverData, setHoverData] = useState<{label: string, value: number, x: number, y: number} | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("theme") === "dark";
    setIsDark(saved);
    if (saved) document.documentElement.classList.add("dark");
    
    async function loadData() {
      try {
        const [s, w] = await Promise.all([fetch("/api/solar"), fetch("/api/weather")]);
        const sData = await s.json();
        const wData = await w.json();
        setState({ status: "success", data: { solar: sData, weather: wData } });
      } catch (e) { 
        setState({ status: "error", message: "Erro ao carregar dados da API" }); 
      }
    }
    loadData();
  }, []);

  if (state.status === "loading") return <div className="flex min-h-screen items-center justify-center dark:bg-[#09120d] dark:text-white font-black animate-pulse text-2xl">CARREGANDO USINA...</div>;
  if (state.status === "error") return <div className="p-20 text-center text-red-500 font-black">{state.message}</div>;

  const { solar, weather } = state.data;

  // --- Lógica do Gráfico SVG ---
  const points = solar.hourlyChart.map((p: any) => ({ label: p.timeLabel, value: p.powerKw }));
  const width = 1000;
  const height = 300;
  const maxValue = Math.max(...points.map((p: any) => p.value), 1);
  const stepX = width / (points.length - 1);
  const svgPoints = points.map((p: any, i: number) => ({
    x: i * stepX,
    y: height - (p.value / maxValue) * (height - 80) - 40,
    ...p
  }));
  const d = svgPoints.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  return (
    <main className="min-h-screen bg-[#f8fafc] p-4 transition-colors duration-300 dark:bg-[#060d09] sm:p-8">
      <div className="mx-auto max-w-7xl space-y-8">
        
        {/* HEADER */}
        <header className="flex flex-col items-center justify-between gap-6 rounded-[2.5rem] bg-[#0d2a1d] p-8 shadow-2xl md:flex-row border border-emerald-900/50">
          <div className="flex items-center gap-5">
            <div className="rounded-2xl bg-white p-3 shadow-lg"><Image src="/solee-logo.png" alt="Logo" width={60} height={60} /></div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.3em] text-emerald-400/80">Dashboard</p>
              <h1 className="text-2xl font-black text-white sm:text-3xl">Geração de Energia Solar</h1>
              <p className="text-xs text-emerald-100/40 font-medium">Monitoramento em tempo real da Usina</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
             <button onClick={() => {
                const next = !isDark;
                setIsDark(next);
                document.documentElement.classList.toggle("dark");
                localStorage.setItem("theme", next ? "dark" : "light");
              }} className="rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 transition-all px-8 py-3 text-[10px] font-black text-white uppercase tracking-widest shadow-inner">
                {isDark ? "Modo Claro ☀️" : "Modo Escuro 🌙"}
              </button>
              <div className="hidden lg:block text-right border-l border-white/10 pl-4">
                <p className="text-[9px] font-bold text-emerald-400 uppercase">Atualização</p>
                <p className="text-[10px] text-white/60">Automática a cada 60s</p>
              </div>
          </div>
        </header>

        {/* MÉTRICAS PRINCIPAIS */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Geração Hoje" value={nf.format(solar.summary.todayGenerationKwh) + " kWh"} hint={`Meta: ${nf.format(solar.summary.targetDailyKwh)} kWh`} />
          <MetricCard label="Geração Mensal" value={nf.format(solar.summary.monthlyGenerationKwh) + " kWh"} hint={`Acumulado: ${nf.format(solar.summary.monthlyGenerationKwh)}`} />
          <MetricCard label="Venda Hoje" value={cf.format(solar.summary.economyTodayBrl)} hint={`No mês: ${cf.format(solar.summary.economyMonthBrl)}`} />
          <MetricCard label="Performance" value={solar.summary.performancePct + "%"} hint={`Tarifa: ${cf.format(solar.summary.tariffKwhBrl)}/kWh`} />
        </section>

        {/* GRÁFICO DE GERAÇÃO POR HORA */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 shadow-sm border border-slate-200 dark:border-emerald-900/30 relative">
          <div className="mb-8 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-black text-[#052e16] dark:text-white">Geração por hora</h2>
              <p className="text-xs text-slate-500 dark:text-emerald-400/50 font-bold">Passe o mouse para ver detalhes</p>
            </div>
          </div>
          <div className="relative h-[350px] w-full">
            <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill="url(#sun-grad)" className="opacity-40" />
              <path d={d} fill="none" stroke="#f8b93c" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
              <defs>
                <linearGradient id="sun-grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f8b93c" />
                  <stop offset="100%" stopColor="#f8b93c" stopOpacity="0" />
                </linearGradient>
              </defs>
              {svgPoints.map((p: any, i: number) => (
                <g key={i} onMouseEnter={() => setHoverData(p)} onMouseLeave={() => setHoverData(null)} className="cursor-pointer">
                  <circle cx={p.x} cy={p.y} r="6" fill="#f8b93c" className="opacity-0 hover:opacity-100 transition-opacity" />
                  <rect x={p.x - stepX/2} y="0" width={stepX} height={height} fill="transparent" />
                </g>
              ))}
            </svg>
            
            {/* TOOLTIP INTERATIVO */}
            {hoverData && (
              <div className="absolute z-20 p-4 rounded-2xl bg-[#0d1a12] border-2 border-amber-500 text-white shadow-2xl pointer-events-none transition-all duration-75"
                   style={{ left: `${(hoverData.x / width) * 100}%`, top: `${(hoverData.y / height) * 100 - 30}%`, transform: 'translateX(-50%)' }}>
                <p className="text-[10px] font-black text-amber-400 uppercase mb-1">{hoverData.label}</p>
                <p className="text-2xl font-black leading-none">{nf.format(hoverData.value)} kW</p>
                <p className="text-[9px] mt-1 font-bold text-emerald-400 opacity-80">Geração estimada nesta hora</p>
              </div>
            )}
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* VALOR ESTIMADO DA ENERGIA */}
          <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 border border-slate-200 dark:border-emerald-900/30">
            <h2 className="text-xl font-black mb-6 dark:text-white">Valor estimado da energia gerada</h2>
            <div className="mb-6 rounded-2xl bg-emerald-50 dark:bg-[#09120d] p-5 border border-emerald-100 dark:border-emerald-900/50">
               <p className="text-[10px] font-black uppercase text-emerald-800 dark:text-emerald-400 mb-1">Tarifa Configurada</p>
               <p className="text-lg font-black text-emerald-900 dark:text-white">R$ 0,70/kWh</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-3xl bg-amber-50 dark:bg-amber-900/10 p-5">
                <p className="text-[9px] font-black uppercase text-amber-700">Hoje</p>
                <p className="text-lg font-black">{cf.format(solar.summary.economyTodayBrl)}</p>
              </div>
              <div className="rounded-3xl bg-emerald-50 dark:bg-emerald-900/10 p-5">
                <p className="text-[9px] font-black uppercase text-emerald-700">No Mês</p>
                <p className="text-lg font-black">{cf.format(solar.summary.economyMonthBrl)}</p>
              </div>
              <div className="rounded-3xl bg-blue-50 dark:bg-blue-900/10 p-5">
                <p className="text-[9px] font-black uppercase text-blue-700">Total</p>
                <p className="text-lg font-black">{cf.format(solar.summary.totalRevenueBrl)}</p>
              </div>
            </div>
          </section>

          {/* PREVISÃO DO TEMPO - MARAVILHA-AL */}
          <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 border border-slate-200 dark:border-emerald-900/30">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-xl font-black dark:text-white">Previsão do tempo</h2>
              <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-tighter">Maravilha-AL | {weather.current.time}</p>
            </div>
            <div className="rounded-3xl bg-[#09120d] p-6 text-white border border-emerald-900/50">
               <div className="flex items-center justify-between">
                 <div>
                   <p className="text-[10px] font-black uppercase text-emerald-400">AGORA EM MARAVILHA, AL</p>
                   <p className="text-5xl font-black my-2">{weather.current.temp} C</p>
                   <p className="text-xs font-bold opacity-60 uppercase">{weather.current.condition}</p>
                 </div>
                 <div className="text-right">
                    <p className="text-[10px] font-bold opacity-60">Chuva: {weather.current.rainProb}</p>
                    <p className="text-[10px] font-bold opacity-60">Vento: {weather.current.windSpeed}</p>
                 </div>
               </div>
               <div className="mt-6 grid grid-cols-3 gap-3 border-t border-emerald-900/50 pt-6">
                 {weather.forecast.map((f: any, idx: number) => (
                   <div key={idx} className="text-center">
                     <p className="text-[9px] font-black uppercase text-emerald-400 mb-1">{f.day}</p>
                     <p className="text-[11px] font-black">{f.condition}</p>
                     <p className="text-[9px] opacity-60">Máx {f.max} | Min {f.min}</p>
                   </div>
                 ))}
               </div>
            </div>
          </section>
        </div>

        {/* STATUS DOS INVERSORES (GW1, GW2, ETC) */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 border border-slate-200 dark:border-emerald-900/30">
          <h2 className="text-xl font-black mb-8 dark:text-white">Status dos inversores</h2>
          <div className="grid gap-6 md:grid-cols-2">
            {solar.inverters.map((inv: any) => (
              <div key={inv.id} className="rounded-[2rem] bg-slate-50 dark:bg-[#0d1a12] p-6 border border-slate-100 dark:border-emerald-900/20 transition-all">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <p className="text-lg font-black text-emerald-900 dark:text-white">{inv.name}</p>
                    <p className="text-[9px] font-mono opacity-50">{inv.serial}</p>
                  </div>
                  <span className={`px-4 py-1 rounded-full text-[10px] font-black uppercase ${inv.status === 'Online' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>
                    {inv.status}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-2xl bg-amber-50 dark:bg-amber-900/10 border border-amber-100/50">
                    <p className="text-[8px] font-black uppercase text-amber-700">Potência</p>
                    <p className="text-sm font-black">{inv.powerKw} kW</p>
                  </div>
                  <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100/50">
                    <p className="text-[8px] font-black uppercase text-emerald-700">Hoje</p>
                    <p className="text-sm font-black">{nf.format(inv.dayGenerationKwh)} kWh</p>
                  </div>
                  <div className="p-3 rounded-2xl bg-blue-50 dark:bg-blue-900/10 border border-blue-100/50">
                    <p className="text-[8px] font-black uppercase text-blue-700">Total</p>
                    <p className="text-sm font-black">{cp.format(inv.totalGenerationKwh)} kWh</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FOOTER */}
        <footer className="text-center pb-12">
          <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Última leitura: {solar.summary.lastUpdate}</p>
          <p className="text-[9px] text-slate-400/60 mt-1">Dados via API Sems Portal | Localização: Maravilha, AL</p>
        </footer>
      </div>
    </main>
  );
}
