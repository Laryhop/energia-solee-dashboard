"use client";

import Image from "next/image";
import { useEffect, useState, useRef } from "react";

// --- Tipagens e Formatadores ---
type ApiState = { status: "loading" } | { status: "error"; message: string } | { status: "success"; data: any };
const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
const cf = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const cp = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

const formatDateOnly = (isoString?: string) => {
  if (!isoString) return "--/--/----";
  const d = new Date(isoString);
  return d.toLocaleDateString("pt-BR", { day: '2-digit', month: '2-digit', year: 'numeric' });
};

function MetricCard({ label, value, hint }: any) {
  return (
    <article className="rounded-[1.5rem] border p-5 shadow-sm bg-white dark:bg-[#12241a] border-slate-200 dark:border-emerald-800/30 transition-all hover:scale-[1.01]">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#7c4a03] dark:text-[#f8b93c]">{label}</p>
      <p className="mt-2 text-2xl font-black text-[#052e16] dark:text-white">{value}</p>
      {hint && <p className="mt-1 text-xs font-bold text-slate-500 dark:text-emerald-300/40">{hint}</p>}
    </article>
  );
}

export function DashboardShell() {
  const [state, setState] = useState<ApiState>({ status: "loading" });
  const [isDark, setIsDark] = useState(false);
  const [hoverData, setHoverData] = useState<any>(null);
  const [hoverBar, setHoverBar] = useState<any>(null);
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.status === "success" && scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [state.status]);

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
        setState({ status: "error", message: "Erro ao carregar dados da API." }); 
      }
    }
    loadData();
  }, []);

  if (state.status === "loading") return <div className="flex min-h-screen items-center justify-center dark:bg-[#060d09] dark:text-white font-black animate-pulse uppercase">Sincronizando Usina Solar...</div>;
  if (state.status === "error") return <div className="flex min-h-screen items-center justify-center text-red-500 font-black">{state.message}</div>;

  const { solar, weather } = state.data;
  
  // --- Dados Base ---
  const summary = solar?.summary || {};
  const hourlyData = solar?.hourlyChart || [];
  const inverters = solar?.inverters || [];
  const dailyHistory = solar?.dailyHistory || solar?.history || [];

  // --- Processar Últimos 60 Dias ---
  const historyDays = 60;
  const lastDaysData = [];
  const todayObj = new Date();
  const todayStr = todayObj.toISOString().split('T')[0];

  for (let i = historyDays - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(todayObj.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    
    const found = dailyHistory.find((item: any) => item.date && item.date.startsWith(dateStr));
    const gen = found ? (found.kwh || found.generationKwh || 0) : 0;
    
    lastDaysData.push({
      date: dateStr,
      label: d.toISOString(),
      generationKwh: gen,
      economyBrl: found ? (found.economyBrl || (gen * (summary.tariffKwhBrl || 0.7))) : 0,
    });
  }

  const selectedDayInfo = selectedDateStr 
    ? lastDaysData.find(d => d.date === selectedDateStr)
    : null;

  const isHistorical = selectedDateStr && selectedDateStr !== todayStr;
  const displayGeneration = isHistorical && selectedDayInfo ? selectedDayInfo.generationKwh : (summary.todayGenerationKwh || 0);
  const displayEconomy = isHistorical && selectedDayInfo ? selectedDayInfo.economyBrl : ((summary.todayGenerationKwh || 0) * (summary.tariffKwhBrl || 0.7));
  const displayLabel = isHistorical && selectedDayInfo ? `Geração ${formatDateOnly(selectedDayInfo.label).slice(0, 5)}` : "Geração Hoje";
  const displayVendaLabel = isHistorical && selectedDayInfo ? `Venda ${formatDateOnly(selectedDayInfo.label).slice(0, 5)}` : "Venda Hoje";

  // --- Lógica do Gráfico de Barras ---
  const dailyTargetKwh = summary.targetDailyKwh || 2000; 
  const monthlyTargetKwh = dailyTargetKwh * 30;
  
  const barChartData = lastDaysData.map((d: any) => ({
    label: d.label,
    date: d.date,
    value: d.generationKwh
  }));
  
  const chartTotalWidth = Math.max(1000, barChartData.length * 45); 
  const maxBarVal = Math.max(...barChartData.map((d:any) => d.value), dailyTargetKwh * 1.2, 2500);
  const gridLines = [0, maxBarVal * 0.25, maxBarVal * 0.5, maxBarVal * 0.75, maxBarVal];
  const stepXBar = chartTotalWidth / (barChartData.length > 0 ? barChartData.length : 1);
  const barW = Math.min(stepXBar * 0.5, 40);

  // --- Lógica do Gráfico Linha (Com preenchimento para as horas vazias) ---
  const widthLine = 1000;
  const heightLine = 300;
  let pointsLine = hourlyData.map((p: any) => ({ label: p.timeLabel, value: p.powerKw }));

  // TRUQUE: Preencher as horas vazias para o gráfico não sumir de noite
  if (pointsLine.length === 0) {
    // Se a API retornar vazio, cria uma linha reta no ZERO
    pointsLine = [
      { label: "00:00", value: 0 },
      { label: "06:00", value: 0 },
      { label: "12:00", value: 0 },
      { label: "18:00", value: 0 },
      { label: "23:59", value: 0 }
    ];
  } else {
    // Garante que o dia sempre comece à meia-noite
    if (pointsLine[0].label > "00:00") {
      pointsLine.unshift({ label: "00:00", value: 0 });
    }
    // Garante que o dia sempre termine à meia-noite, derrubando a linha pro ZERO nas horas sem geração
    const lastPoint = pointsLine[pointsLine.length - 1];
    if (lastPoint.label < "23:59") {
      pointsLine.push({ label: "Noite", value: 0 });
      pointsLine.push({ label: "23:59", value: 0 });
    }
  }

  const maxLineVal = Math.max(...pointsLine.map((p: any) => p.value), 1);
  const stepXLine = widthLine / (pointsLine.length > 1 ? pointsLine.length - 1 : 1);
  const svgPointsLine = pointsLine.map((p: any, i: number) => ({
    x: i * stepXLine,
    y: heightLine - (p.value / maxLineVal) * (heightLine - 80) - 40,
    ...p
  }));
  const pathD = svgPointsLine.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

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
                Usina Maravilha-AL | Total de {inverters.length} Inversores
                <br className="sm:hidden" />
                <span className="hidden sm:inline"> • </span>
                Última leitura: {summary.updatedAt ? new Date(summary.updatedAt).toLocaleString("pt-BR", { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : "--"}
              </p>
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

        {/* 8 CARDS DE MÉTRICAS */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MetricCard label={displayLabel} value={nf.format(displayGeneration) + " kWh"} hint={`Meta Diária: ${nf.format(dailyTargetKwh)} kWh`} />
          <MetricCard label="Geração Mensal" value={nf.format(summary.monthlyGenerationKwh || 0) + " kWh"} hint={`Meta Mensal: ${nf.format(monthlyTargetKwh)} kWh`} />
          <MetricCard label={displayVendaLabel} value={cf.format(displayEconomy)} hint={isHistorical ? "Venda estimada no dia" : "Venda estimada hoje"} />
          <MetricCard label="Performance" value={(summary.performancePct || 0) + "%"} hint="Eficiência Combinada" />
          <MetricCard label="Potência Atual" value={isHistorical ? "--" : (nf.format(summary.currentPowerKw || 0) + " kW")} hint={isHistorical ? "Apenas tempo real" : "Soma de todos inversores"} />
          <MetricCard label="Status da Usina" value={summary.statusLabel || "Online"} hint={summary.location || "Maravilha, AL"} />
          <MetricCard label="Venda Total" value={cf.format(summary.totalRevenueBrl || 0)} hint="Acumulado Histórico" />
          <MetricCard label="Geração Total" value={nf.format(summary.totalGenerationKwh || 0) + " kWh"} hint="Acumulado Histórico" />
        </section>

        {/* GRÁFICO DE BARRAS */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 shadow-sm border border-slate-200 dark:border-emerald-900/30 relative">
          <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <h2 className="text-xl font-black text-[#052e16] dark:text-white">Histórico de Geração (Últimos 60 dias)</h2>
              <p className="text-xs text-slate-500 dark:text-emerald-400/50 font-bold">Clique em uma barra para ver os detalhes do dia. Meta diária: {nf.format(dailyTargetKwh)} kWh.</p>
            </div>
            {selectedDateStr && (
              <button onClick={() => setSelectedDateStr(null)} className="text-xs font-black bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 px-4 py-2 rounded-full hover:bg-amber-200 transition-colors">
                Limpar Seleção (Ver Hoje)
              </button>
            )}
          </div>
          {hoverBar && (
            <div className="absolute z-20 p-4 rounded-2xl bg-[#0d1a12] border-2 border-amber-500 text-white shadow-2xl pointer-events-none text-center"
                 style={{ left: `50%`, top: `80px`, transform: 'translateX(-50%)' }}>
              <p className="text-[10px] font-black text-amber-400 uppercase">{formatDateOnly(hoverBar.label)}</p>
              <p className="text-2xl font-black">{nf.format(hoverBar.value)} kWh</p>
              <p className="text-[9px] opacity-60 font-bold">Produção do dia (Clique para selecionar)</p>
            </div>
          )}
          <div ref={scrollRef} className="relative h-[350px] w-full overflow-x-auto overflow-y-hidden custom-scrollbar pb-4 scroll-smooth">
            <div style={{ width: `${chartTotalWidth}px` }} className="h-full relative pr-8">
              <svg viewBox={`0 0 ${chartTotalWidth} 350`} className="w-full h-full overflow-visible">
                {gridLines.map((val, i) => (
                  <g key={`grid-${i}`}>
                    <line x1="60" y1={300 - (val / maxBarVal) * 260} x2={chartTotalWidth} y2={300 - (val / maxBarVal) * 260} stroke="currentColor" className="opacity-10 dark:opacity-20" strokeWidth="1" />
                    <text x="50" y={300 - (val / maxBarVal) * 260 + 4} fontSize="10" textAnchor="end" fill="currentColor" className="opacity-40 font-black dark:text-white">{cp.format(val)}</text>
                  </g>
                ))}
                <line x1="60" y1={300 - (dailyTargetKwh / maxBarVal) * 260} x2={chartTotalWidth} y2={300 - (dailyTargetKwh / maxBarVal) * 260} stroke="#ef4444" strokeWidth="2" strokeDasharray="4 4" />
                <text x={chartTotalWidth} y={300 - (dailyTargetKwh / maxBarVal) * 260 - 8} fontSize="10" textAnchor="end" fill="#ef4444" className="font-black">META: {nf.format(dailyTargetKwh)}</text>
                {barChartData.map((d: any, i: number) => {
                  const barH = (d.value / maxBarVal) * 260;
                  const x = 60 + i * stepXBar + (stepXBar - barW) / 2;
                  const y = 300 - barH;
                  const isSelected = selectedDateStr === d.date;
                  return (
                    <g key={`bar-${i}`} 
                       onClick={() => setSelectedDateStr(isSelected ? null : d.date)}
                       onMouseEnter={() => setHoverBar(d)} 
                       onMouseLeave={() => setHoverBar(null)} 
                       className="cursor-pointer group">
                      <rect x={x} y={y} width={barW} height={barH} 
                            fill={isSelected ? "#f59e0b" : "#fef08a"} 
                            stroke="#f59e0b" strokeWidth={isSelected ? "2" : "1.5"} 
                            className="group-hover:fill-[#fde047] transition-all" />
                      <text x={x + barW/2} y={320} fontSize="10" textAnchor="end" transform={`rotate(-35 ${x + barW/2} 320)`} fill="currentColor" className={`font-bold ${isSelected ? 'opacity-100 text-amber-600 dark:text-amber-400' : 'opacity-60 dark:text-emerald-100'}`}>
                        {formatDateOnly(d.label).slice(0, 5)}
                      </text>
                    </g>
                  )
                })}
              </svg>
            </div>
          </div>
        </section>

        {/* GRÁFICO SOMA TOTAL POR HORA (AGORA COBRE 24H) */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 shadow-sm border border-slate-200 dark:border-emerald-900/30 relative">
          <div className="mb-8">
            <h2 className="text-xl font-black text-[#052e16] dark:text-white">Geração total por hora (Curva de Hoje)</h2>
            <p className="text-xs text-slate-500 dark:text-emerald-400/50 font-bold">A curva reflete as últimas leituras. Em momentos sem geração, a linha é zerada.</p>
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
                   style={{ left: `${(hoverData.x / widthLine) * 100}%`, top: `${(hoverData.y / heightLine) * 100 - 40}%`, transform: 'translateX(-50%)' }}>
                <p className="text-[10px] font-black text-amber-400 uppercase">{hoverData.label}</p>
                <p className="text-2xl font-black">{nf.format(hoverData.value)} kW</p>
                <p className="text-[9px] opacity-60 font-bold">Produção Total Combinada</p>
              </div>
            )}
          </div>
        </section>

        {/* TABELA DE COMPARAÇÃO */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 border border-slate-200 dark:border-emerald-900/30 overflow-hidden">
          <h2 className="text-xl font-black mb-6 dark:text-white">Comparação diária (Últimos dias)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-slate-100 dark:border-emerald-900/30 text-[10px] font-black uppercase text-slate-400">
                  <th className="pb-4">Data</th>
                  <th className="pb-4">Produção Total</th>
                  <th className="pb-4">Venda Estimada</th>
                  <th className="pb-4">Variação</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                {[...dailyHistory].reverse().slice(0, 10).map((day: any, i: number, arr: any[]) => {
                  const val = day.kwh || day.generationKwh || 0;
                  const prevVal = arr[i+1]?.kwh || arr[i+1]?.generationKwh || val;
                  const variation = prevVal !== 0 ? ((val - prevVal) / prevVal) * 100 : 0;
                  return (
                    <tr key={i} className="dark:text-white hover:bg-slate-50/50 dark:hover:bg-emerald-900/5 transition-colors">
                      <td className="py-4 text-sm font-bold">{formatDateOnly(day.date || day.label)}</td>
                      <td className="py-4 text-sm font-black">{nf.format(val)} kWh</td>
                      <td className="py-4 text-sm font-black text-emerald-600 dark:text-emerald-400">{cf.format(val * 0.7)}</td>
                      <td className={`py-4 text-xs font-black ${variation >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                        {variation > 0 ? '▲' : '▼'} {Math.abs(variation).toFixed(1)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid gap-8 lg:grid-cols-2">
          {/* VALOR ESTIMADO */}
          <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 border border-slate-200 dark:border-emerald-900/30 text-center flex flex-col justify-center">
            <h2 className="text-xl font-black mb-6 dark:text-white">Valor estimado da Usina</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="p-4 rounded-3xl bg-amber-50 dark:bg-amber-900/10 border border-amber-100/50 dark:border-amber-900/30">
                <p className="text-[9px] font-black uppercase text-amber-700">Hoje</p>
                <p className="text-lg font-black dark:text-white">{cf.format((summary.todayGenerationKwh || 0) * 0.7)}</p>
              </div>
              <div className="p-4 rounded-3xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100/50 dark:border-emerald-900/30">
                <p className="text-[9px] font-black uppercase text-emerald-700">No Mês</p>
                <p className="text-lg font-black dark:text-white">{cf.format((summary.monthlyGenerationKwh || 0) * 0.7)}</p>
              </div>
              <div className="p-4 rounded-3xl bg-blue-50 dark:bg-blue-900/10 border border-blue-100/50 dark:border-blue-900/30">
                <p className="text-[9px] font-black uppercase text-blue-700">Total</p>
                <p className="text-lg font-black dark:text-white">{cf.format(summary.totalRevenueBrl || 0)}</p>
              </div>
            </div>
          </section>

          {/* PREVISÃO DO TEMPO */}
          <section className="rounded-[2.5rem] p-8 shadow-sm border transition-all duration-300 bg-white dark:bg-[#09120d] border-slate-200 dark:border-emerald-900/50">
            <div className="flex items-center justify-between mb-8">
              <p className="text-[10px] font-black uppercase text-emerald-600 dark:text-emerald-400 tracking-[0.2em]">Clima em Maravilha, AL</p>
              <p className="text-[10px] font-bold text-slate-400 dark:text-white/40">Atualizado {formatDateOnly(new Date().toISOString())}</p>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-2xl border transition-all bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10">
                <p className="text-[9px] font-black text-amber-600 dark:text-amber-400 uppercase mb-2">Hoje</p>
                <p className="text-3xl font-black text-[#052e16] dark:text-white">{weather?.current?.temp || "24"}°</p>
                <p className="text-[10px] font-bold mt-1 text-slate-600 dark:text-white/80 uppercase">{weather?.current?.condition || "Limpo"}</p>
                <div className="mt-3 space-y-1">
                  <p className="text-[8px] font-bold text-blue-500 uppercase">Chuva: {weather?.current?.rainProb || "0%"}</p>
                  <p className="text-[8px] font-medium text-slate-400 dark:text-white/40 uppercase">Vento: {weather?.current?.windSpeed}</p>
                </div>
              </div>
              <div className="p-4 rounded-2xl border transition-all bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10">
                <p className="text-[9px] font-black text-emerald-600 dark:text-emerald-400 uppercase mb-2">Amanhã</p>
                <p className="text-3xl font-black text-[#052e16] dark:text-white">{weather?.forecast?.[0]?.max || "26"}°</p>
                <p className="text-[10px] font-bold mt-1 text-slate-600 dark:text-white/80 uppercase">{weather?.forecast?.[0]?.condition || "Parcial"}</p>
                <div className="mt-3 space-y-1">
                  <p className="text-[8px] font-bold text-blue-500 uppercase">Chuva: {weather?.forecast?.[0]?.rainProb || "10%"}</p>
                  <p className="text-[8px] font-medium text-slate-400 dark:text-white/40 uppercase">Min: {weather?.forecast?.[0]?.min}°</p>
                </div>
              </div>
              <div className="p-4 rounded-2xl border transition-all bg-slate-50 dark:bg-white/5 border-slate-100 dark:border-white/10">
                <p className="text-[9px] font-black text-emerald-600 dark:text-emerald-400 uppercase mb-2">Próximo</p>
                <p className="text-3xl font-black text-[#052e16] dark:text-white">{weather?.forecast?.[1]?.max || "27"}°</p>
                <p className="text-[10px] font-bold mt-1 text-slate-600 dark:text-white/80 uppercase">{weather?.forecast?.[1]?.condition || "Sol"}</p>
                <div className="mt-3 space-y-1">
                  <p className="text-[8px] font-bold text-blue-500 uppercase">Chuva: {weather?.forecast?.[1]?.rainProb || "5%"}</p>
                  <p className="text-[8px] font-medium text-slate-400 dark:text-white/40 uppercase">Min: {weather?.forecast?.[1]?.min}°</p>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* STATUS DOS INVERSORES INDIVIDUAIS */}
        <section className="rounded-[2.5rem] bg-white dark:bg-[#0f1d15] p-8 border border-slate-200 dark:border-emerald-900/30">
          <div className="flex justify-between items-end mb-8">
            <h2 className="text-xl font-black dark:text-white">Status dos inversores individuais</h2>
            {isHistorical && <span className="text-[10px] font-black uppercase text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-3 py-1 rounded-full">Exibindo dados atuais</span>}
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            {inverters.map((inv: any) => (
              <div key={inv.id} className="rounded-[2rem] bg-slate-50 dark:bg-[#0d1a12] p-6 border border-slate-100 dark:border-emerald-900/20 hover:border-emerald-500/30 transition-colors">
                <div className="flex justify-between items-center mb-6">
                  <div>
                    <p className="text-lg font-black dark:text-white uppercase tracking-tight">{inv.name}</p>
                    <p className="text-[9px] font-mono opacity-40">{inv.serial || "SN-USINA-001"}</p>
                  </div>
                  <span className={`px-4 py-1 rounded-full text-[10px] font-black uppercase ${inv.status === 'Online' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'}`}>{inv.status}</span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center text-[9px] font-black">
                  <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                    <p className="uppercase text-slate-400 mb-1">Potência</p>
                    <p className="text-sm dark:text-white">{inv.powerKw} kW</p>
                  </div>
                  <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                    <p className="uppercase text-slate-400 mb-1">Hoje (Até agora)</p>
                    <p className="text-sm dark:text-white">{nf.format(inv.dayGenerationKwh)} kWh</p>
                  </div>
                  <div className="bg-white dark:bg-[#09120d] p-3 rounded-2xl border border-slate-100 dark:border-white/5">
                    <p className="uppercase text-slate-400 mb-1">Total</p>
                    <p className="text-sm dark:text-white">{cp.format(inv.totalGenerationKwh)} kWh</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Debug Error Log (Visível apenas se houver erro silenciado) */}
        {solar?.errorLog && (
          <div className="mt-8 p-4 bg-red-100 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-300 dark:border-red-800 rounded-xl font-mono text-xs">
            <strong>Debug Log:</strong> {solar.errorLog}
          </div>
        )}
      </div>
    </main>
  );
}
