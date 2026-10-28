"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  addDays,
  addMonths,
  cf,
  cp,
  dayLabel,
  dayLongLabel,
  daysInMonth,
  downloadCsv,
  monthEnd,
  monthLabel,
  nf,
  pf,
  variation,
} from "@/lib/format";

type Point = { date: string; label: string; generationKwh: number; economyBrl: number };
type Mode = "month" | "6m" | "12m";

type Props = {
  today: string; // AAAA-MM-DD no fuso da usina
  tariff: number;
  targetDailyKwh: number;
  capacityKwp: number | null;
  liveTodayKwh: number;
  liveMonthKwh: number;
};

const EARLIEST_MONTHS_BACK = 60;

async function fetchHistory(dimension: "day" | "month", start: string, end: string): Promise<Point[]> {
  const response = await fetch(`/api/solar/history?dimension=${dimension}&start=${start}&end=${end}`);
  if (response.status === 401) {
    window.location.reload();
    return [];
  }
  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(`${data?.error || "Falha ao buscar historico."}${data?.detail ? ` ${data.detail}` : ""}`);
  }
  return Array.isArray(data.points) ? data.points : [];
}

// ---------- componentes visuais ----------

function Delta({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  if (value === null || !Number.isFinite(value)) return <span className="text-slate-400">—</span>;
  const positive = value >= 0;
  return (
    <span className={positive ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
      {positive ? "▲" : "▼"} {pf.format(value)}%{suffix}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-emerald-900/20 dark:bg-[#0d1a12]">
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-lg font-black text-[#052e16] dark:text-white">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] font-bold text-slate-500 dark:text-emerald-300/50">{hint}</p>}
    </div>
  );
}

type Bar = {
  key: string;
  label: string;
  tooltipTitle: string;
  value: number;
  ghost?: number;
  partial?: boolean;
  missing?: boolean;
};

function BarChart({
  bars,
  target,
  targetLabel,
  selectedKey,
  onSelect,
  ghostLabel,
}: {
  bars: Bar[];
  target: number;
  targetLabel: string;
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  ghostLabel?: string;
}) {
  const [hover, setHover] = useState<Bar | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusKey = selectedKey ?? bars.find((bar) => bar.partial)?.key ?? bars.at(-1)?.key;

  // Rola o grafico (no celular) ate o dia selecionado ou ate hoje.
  useEffect(() => {
    const container = scrollRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-key="${focusKey}"]`);
    if (container && target && container.scrollWidth > container.clientWidth) {
      container.scrollLeft = target.offsetLeft - container.clientWidth / 2 + target.offsetWidth / 2;
    }
  }, [focusKey, bars.length]);

  const max = Math.max(target, ...bars.map((bar) => Math.max(bar.value, bar.ghost ?? 0)), 1) * 1.12;
  const pct = (value: number) => `${(value / max) * 100}%`;
  const info = hover ?? bars.find((bar) => bar.key === selectedKey) ?? null;

  return (
    <div>
      <div className="mb-3 flex min-h-[44px] flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold text-slate-500 dark:text-emerald-300/60">
        {info ? (
          <>
            <span className="font-black uppercase text-amber-600 dark:text-amber-400">{info.tooltipTitle}</span>
            <span className="text-base font-black text-[#052e16] dark:text-white">
              {info.missing ? "sem registro" : `${nf.format(info.value)} kWh`}
            </span>
            {info.ghost !== undefined && ghostLabel && (
              <span>
                {ghostLabel}: {nf.format(info.ghost)} kWh <Delta value={variation(info.value, info.ghost)} />
              </span>
            )}
            {info.partial && <span className="text-amber-600 dark:text-amber-400">(parcial, em andamento)</span>}
          </>
        ) : (
          <span>Passe o mouse ou toque nas barras para ver os valores.</span>
        )}
      </div>

      <div ref={scrollRef} className="overflow-x-auto pb-2 scroll-smooth">
        <div className="relative h-64" style={{ minWidth: `${bars.length * 22}px` }}>
          {/* linhas de grade */}
          {[0.25, 0.5, 0.75, 1].map((fraction) => (
            <div key={fraction} className="absolute inset-x-0 border-t border-slate-100 dark:border-emerald-900/30" style={{ bottom: `${fraction * 100}%` }}>
              <span className="absolute -top-2 left-0 bg-white pr-1 text-[9px] font-black text-slate-300 dark:bg-[#0f1d15] dark:text-emerald-800">
                {cp.format(max * fraction)}
              </span>
            </div>
          ))}
          {/* meta */}
          {target > 0 && (
            <div className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-dashed border-rose-500" style={{ bottom: pct(target) }}>
              <span className="absolute -top-5 left-8 whitespace-nowrap text-[10px] font-black text-rose-500">{targetLabel}</span>
            </div>
          )}
          <div className="absolute inset-0 flex items-end gap-[3px] pl-7">
            {bars.map((bar) => {
              const selected = bar.key === selectedKey;
              const belowTarget = !bar.partial && !bar.missing && target > 0 && bar.value < target;
              return (
                <button
                  key={bar.key}
                  data-key={bar.key}
                  type="button"
                  aria-label={`${bar.tooltipTitle}: ${nf.format(bar.value)} kWh`}
                  onMouseEnter={() => setHover(bar)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(bar)}
                  onBlur={() => setHover(null)}
                  onClick={() => onSelect?.(bar.key)}
                  className={`group relative flex h-full flex-1 items-end justify-center gap-[2px] ${onSelect ? "cursor-pointer" : "cursor-default"}`}
                >
                  {bar.ghost !== undefined && (
                    <span className="w-1.5 shrink-0 rounded-t-sm bg-slate-400/60 sm:w-2 dark:bg-emerald-700/60" style={{ height: pct(bar.ghost) }} />
                  )}
                  <span
                    className={`w-full max-w-[34px] rounded-t-md border transition-all ${
                      selected
                        ? "border-emerald-700 bg-emerald-500 dark:border-emerald-300 dark:bg-emerald-400"
                        : bar.missing
                          ? "h-1 border-dashed border-slate-300 bg-transparent dark:border-emerald-800"
                          : bar.partial
                            ? "border-amber-400 bg-amber-100 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,rgba(245,158,11,.25)_4px,rgba(245,158,11,.25)_8px)] dark:bg-amber-900/30"
                            : belowTarget
                              ? "border-amber-300 bg-amber-100 group-hover:bg-amber-200 dark:border-amber-700 dark:bg-amber-900/50"
                              : "border-amber-500 bg-yellow-300 group-hover:bg-yellow-400 dark:border-amber-400 dark:bg-amber-500/90"
                    }`}
                    style={bar.missing ? undefined : { height: pct(bar.value) }}
                  />
                </button>
              );
            })}
          </div>
        </div>
        <div className="mt-2 flex gap-[3px] pl-7" style={{ minWidth: `${bars.length * 22}px` }}>
          {bars.map((bar, index) => (
            <span
              key={bar.key}
              className={`flex-1 text-center text-[9px] font-bold ${
                bar.key === selectedKey ? "text-emerald-700 dark:text-emerald-400" : "text-slate-400 dark:text-emerald-300/50"
              }`}
            >
              {bars.length > 16 && index % 2 === 1 && bar.key !== selectedKey ? "" : bar.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- componente principal ----------

export function PeriodAnalysis({ today, tariff, targetDailyKwh, capacityKwp, liveTodayKwh, liveMonthKwh }: Props) {
  const currentMonth = today.slice(0, 7);
  const earliestMonth = addMonths(currentMonth, -EARLIEST_MONTHS_BACK);

  const [mode, setMode] = useState<Mode>("month");
  const [month, setMonth] = useState(currentMonth);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [daily, setDaily] = useState<Point[]>([]);
  const [monthly, setMonthly] = useState<Point[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, Point[]>());

  // ---- busca de dados ----
  useEffect(() => {
    let cancelled = false;
    const cached = (dimension: "day" | "month", start: string, end: string) => {
      const key = `${dimension}:${start}:${end}`;
      const hit = cache.current.get(key);
      if (hit) return Promise.resolve(hit);
      return fetchHistory(dimension, start, end).then((points) => {
        // Periodos que incluem hoje nao ficam em cache no navegador.
        if (end < today) cache.current.set(key, points);
        return points;
      });
    };

    async function load() {
      setLoading(true);
      setError(null);
      try {
        if (mode === "month") {
          const end = monthEnd(month) < today ? monthEnd(month) : today;
          const [days, months] = await Promise.all([
            cached("day", `${month}-01`, end),
            cached("month", `${addMonths(month, -12)}-01`, end),
          ]);
          if (cancelled) return;
          setDaily(days);
          setMonthly(months);
        } else {
          const months = await cached("month", `${addMonths(currentMonth, -23)}-01`, today);
          if (cancelled) return;
          setMonthly(months);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Falha ao buscar historico.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [mode, month, today, currentMonth]);

  const monthlyByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const point of monthly) map.set(point.date.slice(0, 7), point.generationKwh);
    // O mes atual na estatistica mensal pode nao incluir hoje; usa o valor ao vivo se for maior.
    map.set(currentMonth, Math.max(map.get(currentMonth) ?? 0, liveMonthKwh));
    return map;
  }, [monthly, currentMonth, liveMonthKwh]);

  // ---- visao mensal (dia a dia) ----
  const monthView = useMemo(() => {
    if (mode !== "month") return null;
    const isCurrent = month === currentMonth;
    const totalDays = daysInMonth(month);
    const lastDay = isCurrent ? Number(today.slice(8, 10)) : totalDays;
    const byDate = new Map(daily.map((point) => [point.date.slice(0, 10), point.generationKwh]));
    if (isCurrent && liveTodayKwh > (byDate.get(today) ?? 0)) byDate.set(today, liveTodayKwh);

    const days = Array.from({ length: totalDays }, (_, index) => {
      const date = `${month}-${String(index + 1).padStart(2, "0")}`;
      const future = index + 1 > lastDay;
      const value = byDate.get(date) ?? 0;
      return { date, value, future, partial: date === today, missing: !future && date !== today && !byDate.has(date) };
    });

    const closed = days.filter((day) => !day.future && !day.partial && !day.missing);
    const total = days.reduce((sum, day) => sum + day.value, 0);
    const average = closed.length ? closed.reduce((sum, day) => sum + day.value, 0) / closed.length : 0;
    const sortedClosed = [...closed].sort((a, b) => b.value - a.value);
    const best = sortedClosed[0];
    const worst = sortedClosed.at(-1);
    const belowTarget = closed.filter((day) => day.value < targetDailyKwh).length;
    const remaining = totalDays - lastDay;
    const projection = isCurrent ? total + average * remaining : total;
    const monthTarget = targetDailyKwh * totalDays;
    const previousMonth = monthlyByKey.get(addMonths(month, -1)) ?? 0;
    const lastYear = monthlyByKey.get(addMonths(month, -12)) ?? 0;
    const missingDays = days.filter((day) => day.missing).length;

    return {
      isCurrent,
      days,
      total,
      average,
      best,
      worst,
      belowTarget,
      closedCount: closed.length,
      remaining,
      projection,
      monthTarget,
      previousMonth,
      lastYear,
      missingDays,
      neededPerDay: isCurrent && remaining > 0 ? Math.max(0, (monthTarget - total) / remaining) : 0,
      ranking: sortedClosed.map((day) => day.date),
    };
  }, [mode, month, currentMonth, today, daily, liveTodayKwh, targetDailyKwh, monthlyByKey]);

  // ---- visao de varios meses ----
  const multiView = useMemo(() => {
    if (mode === "month") return null;
    const count = mode === "6m" ? 6 : 12;
    const months = Array.from({ length: count }, (_, index) => addMonths(currentMonth, index - count + 1));
    const previousMonths = months.map((key) => addMonths(key, -count));
    const value = (key: string) => monthlyByKey.get(key) ?? 0;

    const rows = months.map((key) => ({
      key,
      value: value(key),
      lastYear: value(addMonths(key, -12)),
      partial: key === currentMonth,
      target: targetDailyKwh * daysInMonth(key),
    }));
    const closed = rows.filter((row) => !row.partial && row.value > 0);
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    const previousTotal = previousMonths.reduce((sum, key) => sum + value(key), 0);
    const previousMonthsWithData = previousMonths.filter((key) => value(key) > 0).length;
    const sorted = [...closed].sort((a, b) => b.value - a.value);
    const average = closed.length ? closed.reduce((sum, row) => sum + row.value, 0) / closed.length : 0;
    const monthsHitTarget = closed.filter((row) => row.value >= row.target).length;

    return {
      count,
      rows,
      total,
      previousTotal,
      previousMonthsWithData,
      average,
      best: sorted[0],
      worst: sorted.at(-1),
      monthsHitTarget,
      closedCount: closed.length,
      averageTarget: targetDailyKwh * 30.4,
    };
  }, [mode, currentMonth, monthlyByKey, targetDailyKwh]);

  // ---- dia selecionado ----
  const dayView = useMemo(() => {
    if (!monthView || !selectedDay || selectedDay.slice(0, 7) !== month) return null;
    const day = monthView.days.find((item) => item.date === selectedDay);
    if (!day || day.future) return null;
    const previous = monthView.days.find((item) => item.date === addDays(selectedDay, -1));
    const position = monthView.ranking.indexOf(selectedDay);
    return {
      ...day,
      economy: day.value * tariff,
      targetPct: targetDailyKwh ? (day.value / targetDailyKwh) * 100 : 0,
      vsAverage: variation(day.value, monthView.average),
      vsPrevious: previous && !previous.missing ? variation(day.value, previous.value) : null,
      position: position >= 0 ? position + 1 : null,
      yieldKwhKwp: capacityKwp ? day.value / capacityKwp : null,
    };
  }, [monthView, selectedDay, month, tariff, targetDailyKwh, capacityKwp]);

  // ---- acoes ----
  function pickDay(date: string) {
    if (!date || date > today) return;
    setMode("month");
    setMonth(date.slice(0, 7));
    setSelectedDay(date);
  }

  function exportCsv() {
    if (monthView) {
      downloadCsv(
        `geracao-${month}.csv`,
        ["Data", "Geração (kWh)", "Venda estimada (R$)", "Meta (kWh)"],
        monthView.days
          .filter((day) => !day.future)
          .map((day) => [day.date.split("-").reverse().join("/"), day.value, day.value * tariff, targetDailyKwh]),
      );
    } else if (multiView) {
      downloadCsv(
        `geracao-ultimos-${multiView.count}-meses.csv`,
        ["Mês", "Geração (kWh)", "Venda estimada (R$)", "Mesmo mês ano anterior (kWh)", "Meta (kWh)"],
        multiView.rows.map((row) => [monthLabel(row.key, true), row.value, row.value * tariff, row.lastYear, row.target]),
      );
    }
  }

  const tabClass = (active: boolean) =>
    `rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-wider transition-colors ${
      active
        ? "bg-[#0d2a1d] text-white dark:bg-amber-500 dark:text-[#0d1a12]"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/5 dark:text-emerald-200/70 dark:hover:bg-white/10"
    }`;

  return (
    <section className="rounded-[2.5rem] border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-900/30 dark:bg-[#0f1d15] sm:p-8">
      {/* cabecalho e controles */}
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-black text-[#052e16] dark:text-white">Análise de geração</h2>
          <p className="text-xs font-bold text-slate-500 dark:text-emerald-400/50">
            Escolha um mês, os últimos 6 ou 12 meses, ou um dia específico.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={tabClass(mode === "month")} onClick={() => setMode("month")}>Mês</button>
          <button type="button" className={tabClass(mode === "6m")} onClick={() => setMode("6m")}>6 meses</button>
          <button type="button" className={tabClass(mode === "12m")} onClick={() => setMode("12m")}>12 meses</button>
          <label className="flex items-center gap-2 rounded-full bg-slate-100 py-1 pl-4 pr-1 text-[11px] font-black uppercase tracking-wider text-slate-600 dark:bg-white/5 dark:text-emerald-200/70">
            Ver dia
            <input
              type="date"
              max={today}
              min={`${earliestMonth}-01`}
              value={selectedDay ?? ""}
              onChange={(event) => pickDay(event.target.value)}
              className="rounded-full bg-white px-3 py-1 text-xs font-bold text-[#052e16] dark:bg-[#0d1a12] dark:text-white dark:[color-scheme:dark]"
            />
          </label>
          <button
            type="button"
            onClick={exportCsv}
            disabled={loading || !!error}
            className="rounded-full border border-emerald-600/30 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
          >
            Exportar CSV
          </button>
        </div>
      </div>

      {mode === "month" && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-2xl bg-slate-50 p-2 dark:bg-[#0d1a12]">
          <button
            type="button"
            disabled={month <= earliestMonth}
            onClick={() => { setMonth(addMonths(month, -1)); setSelectedDay(null); }}
            className="rounded-xl px-4 py-2 text-sm font-black text-[#052e16] hover:bg-white disabled:opacity-30 dark:text-white dark:hover:bg-white/10"
          >
            ← Anterior
          </button>
          <p className="text-center text-sm font-black text-[#052e16] dark:text-white">
            {monthLabel(month, true)} {month === currentMonth && <span className="text-amber-600 dark:text-amber-400">(em andamento)</span>}
          </p>
          <button
            type="button"
            disabled={month >= currentMonth}
            onClick={() => { setMonth(addMonths(month, 1)); setSelectedDay(null); }}
            className="rounded-xl px-4 py-2 text-sm font-black text-[#052e16] hover:bg-white disabled:opacity-30 dark:text-white dark:hover:bg-white/10"
          >
            Próximo →
          </button>
        </div>
      )}

      {error ? (
        <p className="rounded-2xl bg-rose-50 p-4 text-sm font-bold text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">{error}</p>
      ) : loading ? (
        <div className="flex h-72 items-center justify-center text-xs font-black uppercase tracking-widest text-slate-400 animate-pulse">
          Carregando histórico...
        </div>
      ) : monthView ? (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={monthView.isCurrent ? "Gerado até agora" : "Total do mês"}
              value={`${nf.format(monthView.total)} kWh`}
              hint={`${cf.format(monthView.total * tariff)} em venda estimada`}
            />
            <Stat
              label="Meta do mês"
              value={`${nf.format((monthView.total / monthView.monthTarget) * 100)}%`}
              hint={`${nf.format(monthView.monthTarget)} kWh (${nf.format(targetDailyKwh)}/dia)`}
            />
            <Stat
              label="Média por dia"
              value={`${nf.format(monthView.average)} kWh`}
              hint={`${monthView.belowTarget} de ${monthView.closedCount} dias abaixo da meta`}
            />
            {monthView.isCurrent ? (
              <Stat
                label="Projeção do mês"
                value={`${nf.format(monthView.projection)} kWh`}
                hint={
                  monthView.remaining > 0
                    ? `Precisa de ${nf.format(monthView.neededPerDay)} kWh/dia nos ${monthView.remaining} dias restantes`
                    : "Último dia do mês"
                }
              />
            ) : (
              <Stat
                label="vs. mês anterior"
                value={<Delta value={variation(monthView.total, monthView.previousMonth)} />}
                hint={`${monthLabel(addMonths(month, -1))}: ${nf.format(monthView.previousMonth)} kWh`}
              />
            )}
            <Stat
              label="Melhor dia"
              value={monthView.best ? `${nf.format(monthView.best.value)} kWh` : "—"}
              hint={monthView.best ? dayLabel(monthView.best.date) : undefined}
            />
            <Stat
              label="Pior dia"
              value={monthView.worst ? `${nf.format(monthView.worst.value)} kWh` : "—"}
              hint={monthView.worst ? dayLabel(monthView.worst.date) : undefined}
            />
            <Stat
              label="vs. mesmo mês ano passado"
              value={<Delta value={variation(monthView.isCurrent ? monthView.projection : monthView.total, monthView.lastYear)} />}
              hint={`${monthLabel(addMonths(month, -12))}: ${monthView.lastYear ? `${nf.format(monthView.lastYear)} kWh` : "sem dados"}${monthView.isCurrent ? " (usando a projeção)" : ""}`}
            />
            <Stat
              label={capacityKwp ? "Produtividade" : "Dias sem registro"}
              value={
                capacityKwp
                  ? `${nf.format(monthView.average / capacityKwp)} kWh/kWp`
                  : `${monthView.missingDays}`
              }
              hint={capacityKwp ? `média por dia · usina de ${nf.format(capacityKwp)} kWp` : "possível falha de comunicação"}
            />
          </div>

          <BarChart
            bars={monthView.days.map((day) => ({
              key: day.date,
              label: day.date.slice(8, 10),
              tooltipTitle: dayLongLabel(day.date),
              value: day.value,
              partial: day.partial,
              missing: day.missing || day.future,
            }))}
            target={targetDailyKwh}
            targetLabel={`META ${nf.format(targetDailyKwh)} kWh`}
            selectedKey={selectedDay}
            onSelect={(key) => {
              if (key <= today) setSelectedDay(key === selectedDay ? null : key);
            }}
          />
          <p className="mt-2 text-[11px] font-bold text-slate-400">
            Clique em um dia para ver o detalhe (fica verde). Barras em tom mais fraco ficaram abaixo da meta; a listrada é o dia de hoje.
          </p>

          {dayView && (
            <div className="mt-6 rounded-[2rem] border-2 border-amber-400/60 bg-amber-50/60 p-5 dark:border-amber-500/30 dark:bg-amber-900/10">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-400">Detalhe do dia</p>
                  <p className="text-lg font-black text-[#052e16] dark:text-white">{dayLongLabel(dayView.date)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedDay(null)}
                  className="rounded-full bg-white px-4 py-2 text-[11px] font-black uppercase text-amber-800 hover:bg-amber-100 dark:bg-white/5 dark:text-amber-300"
                >
                  Fechar
                </button>
              </div>
              {dayView.missing ? (
                <p className="text-sm font-bold text-slate-600 dark:text-emerald-200/70">
                  Não há registro de geração para este dia no SEMS+. Pode ter sido falha de comunicação do inversor
                  com a internet ou usina desligada.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <Stat
                    label={dayView.partial ? "Gerado até agora" : "Geração"}
                    value={`${nf.format(dayView.value)} kWh`}
                    hint={`${cf.format(dayView.economy)} em venda estimada`}
                  />
                  <Stat
                    label="Meta diária"
                    value={`${nf.format(dayView.targetPct)}%`}
                    hint={dayView.value >= targetDailyKwh ? "Meta atingida" : `Faltaram ${nf.format(targetDailyKwh - dayView.value)} kWh`}
                  />
                  <Stat
                    label="vs. média do mês"
                    value={<Delta value={dayView.vsAverage} />}
                    hint={`Média: ${nf.format(monthView.average)} kWh`}
                  />
                  <Stat
                    label="vs. dia anterior"
                    value={<Delta value={dayView.vsPrevious} />}
                    hint={
                      dayView.position
                        ? `${dayView.position}º melhor dia de ${monthView.closedCount} no mês`
                        : dayView.yieldKwhKwp
                          ? `${nf.format(dayView.yieldKwhKwp)} kWh/kWp`
                          : undefined
                    }
                  />
                </div>
              )}
              <p className="mt-3 text-[11px] font-bold text-slate-400">
                O SEMS+ guarda só o total por dia; a curva hora a hora existe apenas para o dia de hoje.
              </p>
            </div>
          )}
        </>
      ) : multiView ? (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label={`Total ${multiView.count} meses`}
              value={`${nf.format(multiView.total)} kWh`}
              hint={`${cf.format(multiView.total * tariff)} em venda estimada`}
            />
            <Stat
              label={`vs. ${multiView.count} meses anteriores`}
              value={
                multiView.previousMonthsWithData < multiView.count ? (
                  <span className="text-slate-400">—</span>
                ) : (
                  <Delta value={variation(multiView.total, multiView.previousTotal)} />
                )
              }
              hint={
                multiView.previousMonthsWithData < multiView.count
                  ? `Período anterior incompleto (${multiView.previousMonthsWithData} de ${multiView.count} meses com dados)`
                  : `Antes: ${nf.format(multiView.previousTotal)} kWh`
              }
            />
            <Stat
              label="Média mensal"
              value={`${nf.format(multiView.average)} kWh`}
              hint={`${multiView.monthsHitTarget} de ${multiView.closedCount} meses bateram a meta`}
            />
            <Stat
              label="Melhor / pior mês"
              value={multiView.best ? `${nf.format(multiView.best.value)} kWh` : "—"}
              hint={
                multiView.best && multiView.worst
                  ? `${monthLabel(multiView.best.key)} · pior: ${monthLabel(multiView.worst.key)} (${nf.format(multiView.worst.value)} kWh)`
                  : undefined
              }
            />
          </div>

          <BarChart
            bars={multiView.rows.map((row) => ({
              key: row.key,
              label: monthLabel(row.key),
              tooltipTitle: monthLabel(row.key, true),
              value: row.value,
              ghost: row.lastYear || undefined,
              partial: row.partial,
            }))}
            target={multiView.averageTarget}
            targetLabel={`META ~${nf.format(multiView.averageTarget)} kWh/mês`}
            ghostLabel="Ano anterior"
            onSelect={(key) => {
              setMonth(key);
              setSelectedDay(null);
              setMode("month");
            }}
          />
          <p className="mt-2 text-[11px] font-bold text-slate-400">
            A barrinha cinza ao lado mostra o mesmo mês do ano anterior. Clique em um mês para abrir o detalhe dia a dia.
          </p>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 dark:border-emerald-900/30">
                  <th className="pb-3 pr-4">Mês</th>
                  <th className="pb-3 pr-4">Geração</th>
                  <th className="pb-3 pr-4">Venda estimada</th>
                  <th className="pb-3 pr-4">Meta</th>
                  <th className="pb-3">vs. ano anterior</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                {[...multiView.rows].reverse().map((row) => (
                  <tr key={row.key} className="font-bold dark:text-white">
                    <td className="py-3 pr-4">
                      {monthLabel(row.key, true)} {row.partial && <span className="text-[10px] text-amber-600">(parcial)</span>}
                    </td>
                    <td className="py-3 pr-4 font-black">{nf.format(row.value)} kWh</td>
                    <td className="py-3 pr-4 text-emerald-600 dark:text-emerald-400">{cf.format(row.value * tariff)}</td>
                    <td className="py-3 pr-4">{nf.format((row.value / row.target) * 100)}%</td>
                    <td className="py-3 text-xs">{row.partial ? "—" : <Delta value={variation(row.value, row.lastYear)} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}
