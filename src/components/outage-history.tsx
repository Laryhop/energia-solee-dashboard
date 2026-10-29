"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addDays,
  addMonths,
  cf,
  dayLongLabel,
  daysInMonth,
  downloadCsv,
  monthLabel,
  nf,
} from "@/lib/format";

type Outage = {
  id: string;
  sn: string;
  name: string;
  start: string;
  end: string | null;
  lastCheck: string;
  expectedKwh: number;
  daylightMinutes: number;
  startDay: string;
  reason: string;
  method: "comparacao" | "curva";
  checks: number;
  actualKwh: number | null;
  lostKwh: number;
  lostBrl: number;
  kind: "parada" | "comunicacao" | "historico" | null;
  note?: string;
  ignored?: boolean;
  inverterCount?: number;
  missingRecord?: boolean;
};

/** Linha exibida: uma parada, ou varios dias seguidos reconstruidos pelo historico. */
type Row = {
  key: string;
  outages: Outage[];
  name: string;
  historical: boolean;
  startDay: string;
  endDay: string;
  start: string;
  end: string | null;
  reason: string;
  kind: Outage["kind"];
  days: number;
  minutes: number;
  lostKwh: number;
  lostBrl: number;
  expectedKwh: number;
  actualKwh: number;
  note?: string;
  ignored: boolean;
  missingDays: number;
};

type History = {
  configured: boolean;
  year: string;
  tariff: number;
  since: string | null;
  last: {
    at: string;
    error?: string;
    inverters: Array<{ sn: string; name: string; status: string; powerKw: number; state: string }>;
  } | null;
  open: Outage[];
  closed: Outage[];
  checksByDay: Record<string, number>;
  historical: Outage[];
  analyzedDays: string[];
  historicalMethod: "clima" | "mediana" | null;
  historicalError?: string;
};

type View = "dia" | "mes" | "ano";
type InverterInfo = { id: string; name: string };

const SUN_MINUTES_PER_DAY = 12 * 60;
const TZ = "America/Maceio";

// ---------- formatacao ----------

function formatDuration(minutes: number) {
  const total = Math.round(minutes);
  if (total < 1) return "< 1 min";
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  return [days ? `${days} d` : "", hours ? `${hours} h` : "", mins && !days ? `${mins} min` : ""].filter(Boolean).join(" ");
}

/** Horas de sol (sem converter em dias, que confundiria com dias corridos). */
function formatSunHours(minutes: number) {
  const total = Math.round(minutes);
  if (total < 60) return formatDuration(total);
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  return `${nf.format(hours)} h${mins && hours < 24 ? ` ${mins} min` : ""}`;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function localDay(iso: string) {
  return new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10);
}

function minutesSince(iso: string) {
  return Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
}

function totalMinutes(outage: Outage) {
  return ((outage.end ? Date.parse(outage.end) : Date.now()) - Date.parse(outage.start)) / 60_000;
}

/** Agrupa dias seguidos reconstruidos (mesmo motivo) numa unica linha. */
function buildRows(outages: Outage[]): Row[] {
  const sorted = [...outages].sort((a, b) => b.start.localeCompare(a.start));
  const rows: Row[] = [];
  for (const outage of sorted) {
    const historical = outage.kind === "historico";
    const previous = rows.at(-1);
    const dayBefore = previous ? addDays(previous.startDay, -1) : null;
    if (
      historical &&
      previous?.historical &&
      previous.reason === outage.reason &&
      previous.ignored === Boolean(outage.ignored) &&
      dayBefore === outage.startDay
    ) {
      previous.outages.push(outage);
      previous.startDay = outage.startDay;
      previous.start = outage.start;
      previous.days += 1;
      previous.minutes += outage.daylightMinutes;
      previous.lostKwh += outage.lostKwh;
      previous.lostBrl += outage.lostBrl;
      previous.expectedKwh += outage.expectedKwh;
      previous.actualKwh += outage.actualKwh ?? 0;
      if (outage.note && !previous.note) previous.note = outage.note;
      if (outage.missingRecord) previous.missingDays += 1;
      continue;
    }
    rows.push({
      key: outage.id,
      outages: [outage],
      name: outage.name,
      historical,
      startDay: outage.startDay,
      endDay: outage.startDay,
      start: outage.start,
      end: outage.end,
      reason: outage.reason,
      kind: outage.kind,
      days: 1,
      minutes: historical ? outage.daylightMinutes : (outage.end ? Date.parse(outage.end) : Date.now()) / 60_000 - Date.parse(outage.start) / 60_000,
      lostKwh: outage.lostKwh,
      lostBrl: outage.lostBrl,
      expectedKwh: outage.expectedKwh,
      actualKwh: outage.actualKwh ?? 0,
      note: outage.note,
      ignored: Boolean(outage.ignored),
      missingDays: outage.missingRecord ? 1 : 0,
    });
  }
  return rows;
}

const shortDay = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;

function rowPeriod(row: Row) {
  if (row.historical) {
    return row.days > 1 ? `${shortDay(row.startDay)} → ${shortDay(row.endDay)}` : shortDay(row.startDay);
  }
  const end = row.end
    ? localDay(row.end) === row.startDay
      ? formatTime(row.end)
      : formatDateTime(row.end)
    : "em andamento";
  return `${formatDateTime(row.start)} → ${end}`;
}

function rowDuration(row: Row) {
  if (row.historical) {
    const hours = row.minutes / 60;
    return row.days > 1
      ? `${row.days} dias · ≈${nf.format(Math.round(hours))} h de sol`
      : `≈${formatSunHours(row.minutes)} de sol`;
  }
  return formatDuration(row.minutes);
}

// ---------- pecas visuais ----------

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "bad" | "ok" }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-emerald-900/20 dark:bg-[#0d1a12]">
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
      <p
        className={`mt-1 text-lg font-black ${
          tone === "bad" ? "text-rose-600 dark:text-rose-400" : tone === "ok" ? "text-emerald-700 dark:text-emerald-400" : "text-[#052e16] dark:text-white"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[11px] font-bold text-slate-500 dark:text-emerald-300/50">{hint}</p>}
    </div>
  );
}

function LossBars({ bars, onSelect }: { bars: Array<{ key: string; label: string; title: string; kwh: number; brl: number; count: number }>; onSelect: (key: string) => void }) {
  const [hover, setHover] = useState<(typeof bars)[number] | null>(null);
  const max = Math.max(...bars.map((bar) => bar.kwh), 1);
  return (
    <div>
      <p className="mb-2 min-h-[20px] text-xs font-bold text-slate-500 dark:text-emerald-300/60">
        {hover ? (
          <>
            <span className="font-black text-rose-600 dark:text-rose-400">{hover.title}</span>: {hover.count} parada{hover.count === 1 ? "" : "s"} ·{" "}
            {nf.format(hover.kwh)} kWh · {cf.format(hover.brl)}
          </>
        ) : (
          "Energia perdida por período. Clique numa barra para abrir o detalhe."
        )}
      </p>
      <div className="overflow-x-auto pb-1">
        <div className="flex h-28 items-end gap-[3px]" style={{ minWidth: `${bars.length * 16}px` }}>
          {bars.map((bar) => (
            <button
              key={bar.key}
              type="button"
              onMouseEnter={() => setHover(bar)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(bar)}
              onBlur={() => setHover(null)}
              onClick={() => onSelect(bar.key)}
              aria-label={`${bar.title}: ${nf.format(bar.kwh)} kWh perdidos`}
              className="group flex h-full flex-1 items-end"
            >
              <span
                className={`w-full rounded-t ${bar.count ? "bg-rose-400 group-hover:bg-rose-500 dark:bg-rose-500/80" : "bg-slate-200 dark:bg-white/5"}`}
                style={{ height: bar.count ? `${Math.max(6, (bar.kwh / max) * 100)}%` : "3px" }}
              />
            </button>
          ))}
        </div>
        <div className="mt-1 flex gap-[3px]" style={{ minWidth: `${bars.length * 16}px` }}>
          {bars.map((bar, index) => (
            <span key={bar.key} className="flex-1 text-center text-[9px] font-bold text-slate-400">
              {bars.length > 16 && index % 2 === 1 ? "" : bar.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Linha do tempo do dia (05:00-18:30) com as paradas de cada inversor. */
function DayTimeline({ day, inverters, outages }: { day: string; inverters: InverterInfo[]; outages: Outage[] }) {
  const startH = 5;
  const endH = 18.5;
  const dayStart = Date.parse(`${day}T00:00:00-03:00`);
  const toPct = (ms: number) => {
    const hour = (ms - dayStart) / 3_600_000;
    return Math.min(100, Math.max(0, ((hour - startH) / (endH - startH)) * 100));
  };
  const names = new Map(inverters.map((inv) => [inv.id, inv.name]));
  for (const outage of outages) if (!names.has(outage.sn)) names.set(outage.sn, outage.name);
  const hasHistorical = outages.some((outage) => outage.kind === "historico");

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[520px]">
        <div className="relative ml-28 h-5 text-[9px] font-bold text-slate-400">
          {[6, 8, 10, 12, 14, 16, 18].map((hour) => (
            <span key={hour} className="absolute -translate-x-1/2" style={{ left: `${((hour - startH) / (endH - startH)) * 100}%` }}>
              {String(hour).padStart(2, "0")}h
            </span>
          ))}
        </div>
        {[...names.entries()].map(([sn, name]) => (
          <div key={sn} className="flex items-center gap-2 py-1">
            <span className="shrink-0 truncate text-xs font-black text-[#052e16] dark:text-white" style={{ width: "6.5rem" }}>
              {name}
            </span>
            <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-emerald-100 dark:bg-emerald-900/30">
              {outages
                .filter((outage) => outage.sn === sn)
                .map((outage) => {
                  const left = toPct(Date.parse(outage.start));
                  const right = toPct(outage.end ? Date.parse(outage.end) : Date.now());
                  return (
                    <span
                      key={outage.id}
                      title={`${formatTime(outage.start)} – ${outage.end ? formatTime(outage.end) : "agora"} · ${outage.reason}`}
                      className={`absolute inset-y-0 ${
                        outage.kind === "comunicacao"
                          ? "bg-amber-400"
                          : outage.kind === "historico"
                            ? "bg-[repeating-linear-gradient(45deg,#f43f5e,#f43f5e_6px,#fb7185_6px,#fb7185_12px)]"
                            : "bg-rose-500"
                      } ${outage.end ? "" : "animate-pulse"} ${outage.ignored ? "opacity-30" : ""}`}
                      style={{ left: `${left}%`, width: `${Math.max(0.6, right - left)}%` }}
                    />
                  );
                })}
            </div>
          </div>
        ))}
        <p className="ml-28 mt-2 text-[10px] font-bold text-slate-400">
          <span className="mr-1 inline-block h-2 w-3 rounded-sm bg-emerald-200 align-middle dark:bg-emerald-800" /> funcionando{" "}
          <span className="ml-3 mr-1 inline-block h-2 w-3 rounded-sm bg-rose-500 align-middle" /> parado{" "}
          <span className="ml-3 mr-1 inline-block h-2 w-3 rounded-sm bg-amber-400 align-middle" /> sem comunicação (seguiu gerando)
        </p>
        {hasHistorical && (
          <p className="ml-28 mt-1 text-[10px] font-bold text-slate-400">
            A faixa listrada é uma estimativa pela geração total do dia: mostra quanto tempo de sol foi perdido, não o horário exato.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- componente principal ----------

export function OutageHistory({ today, inverters }: { today: string; inverters: InverterInfo[] }) {
  const [view, setView] = useState<View>("mes");
  const [anchor, setAnchor] = useState(today); // AAAA-MM-DD dentro do periodo
  const [history, setHistory] = useState<History | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const cache = useRef(new Map<string, History>());
  const year = anchor.slice(0, 4);
  const inverterCount = inverters.length;

  const load = useCallback(
    async (force = false) => {
      const cached = cache.current.get(year);
      if (cached && !force) {
        setHistory(cached);
        return;
      }
      try {
        const response = await fetch(`/api/outages?year=${year}&inverters=${Math.max(1, inverterCount)}`, { cache: "no-store" });
        if (response.status === 401) {
          window.location.reload();
          return;
        }
        const data = await response.json();
        if (!response.ok || data?.error) throw new Error(`${data?.error || "Falha ao carregar paradas."} ${data?.detail || ""}`.trim());
        cache.current.set(year, data);
        setHistory(data);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Falha ao carregar paradas.");
      }
    },
    [year, inverterCount],
  );

  useEffect(() => {
    load();
    if (year !== today.slice(0, 4)) return;
    const interval = window.setInterval(() => load(true), 60_000);
    return () => window.clearInterval(interval);
  }, [load, year, today]);

  // ---- periodo selecionado ----
  const period = useMemo(() => {
    if (view === "dia") return { start: anchor, end: anchor, title: dayLongLabel(anchor) };
    if (view === "mes") {
      const month = anchor.slice(0, 7);
      return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, "0")}`, title: monthLabel(month, true) };
    }
    return { start: `${year}-01-01`, end: `${year}-12-31`, title: `Ano de ${year}` };
  }, [view, anchor, year]);

  // Usa o nome atual do inversor (o registro guarda o nome da epoca da parada).
  const all = useMemo(() => {
    const names = new Map(inverters.map((inv) => [inv.id, inv.name]));
    const rename = (outage: Outage) => ({ ...outage, name: names.get(outage.sn) ?? outage.name });
    return history
      ? [...history.open.map(rename), ...history.closed.map(rename), ...(history.historical ?? [])]
      : [];
  }, [history, inverters]);
  const openNow = all.filter((outage) => !outage.end);
  const inPeriod = useMemo(
    () => all.filter((outage) => outage.startDay >= period.start && outage.startDay <= period.end),
    [all, period],
  );
  const counted = inPeriod.filter((outage) => !outage.ignored);
  const rows = useMemo(() => buildRows(inPeriod), [inPeriod]);
  const countedRows = rows.filter((row) => !row.ignored);

  const summary = useMemo(() => {
    const lostKwh = counted.reduce((sum, outage) => sum + outage.lostKwh, 0);
    const lostBrl = counted.reduce((sum, outage) => sum + outage.lostBrl, 0);
    const sunMinutes = counted.reduce((sum, outage) => sum + outage.daylightMinutes, 0);
    // Minutos-inversor parados (parada da usina inteira conta para todos os inversores).
    const total = Math.max(inverters.length, 1);
    const inverterMinutes = counted.reduce(
      (sum, outage) => sum + outage.daylightMinutes * Math.min(total, outage.inverterCount ?? 1),
      0,
    );
    const coveredDays = new Set<string>();
    for (const [day, count] of Object.entries(history?.checksByDay ?? {})) if (count > 0) coveredDays.add(day);
    for (const day of history?.analyzedDays ?? []) coveredDays.add(day);
    const monitoredDays = [...coveredDays].filter((day) => day >= period.start && day <= period.end && day <= today).length;
    const availability = monitoredDays
      ? Math.max(0, 100 - (inverterMinutes / (monitoredDays * SUN_MINUTES_PER_DAY * total)) * 100)
      : null;
    const communication = counted.filter((outage) => outage.kind === "comunicacao").length;
    const historicalDays = counted.filter((outage) => outage.kind === "historico").length;
    return { lostKwh, lostBrl, sunMinutes, monitoredDays, availability, communication, historicalDays };
  }, [counted, history, period, today, inverters.length]);

  const byInverter = useMemo(() => {
    const map = new Map<string, { name: string; count: number; minutes: number; kwh: number; brl: number }>();
    for (const inv of inverters) map.set(inv.id, { name: inv.name, count: 0, minutes: 0, kwh: 0, brl: 0 });
    for (const outage of counted) {
      const row = map.get(outage.sn) ?? {
        name: outage.kind === "historico" ? "Usina inteira (estimado pelo histórico diário)" : outage.name,
        count: 0,
        minutes: 0,
        kwh: 0,
        brl: 0,
      };
      row.count += 1;
      row.minutes += outage.daylightMinutes;
      row.kwh += outage.lostKwh;
      row.brl += outage.lostBrl;
      map.set(outage.sn, row);
    }
    return [...map.entries()].sort((a, b) => b[1].kwh - a[1].kwh);
  }, [counted, inverters]);

  const bars = useMemo(() => {
    const sum = (list: Outage[]) => ({
      kwh: list.reduce((total, outage) => total + outage.lostKwh, 0),
      brl: list.reduce((total, outage) => total + outage.lostBrl, 0),
      count: list.length,
    });
    if (view === "mes") {
      const month = anchor.slice(0, 7);
      return Array.from({ length: daysInMonth(month) }, (_, index) => {
        const day = `${month}-${String(index + 1).padStart(2, "0")}`;
        return { key: day, label: String(index + 1).padStart(2, "0"), title: dayLongLabel(day), ...sum(counted.filter((o) => o.startDay === day)) };
      });
    }
    if (view === "ano") {
      return Array.from({ length: 12 }, (_, index) => {
        const month = `${year}-${String(index + 1).padStart(2, "0")}`;
        return { key: `${month}-01`, label: monthLabel(month).slice(0, 3), title: monthLabel(month, true), ...sum(counted.filter((o) => o.startDay.startsWith(month))) };
      });
    }
    return [];
  }, [view, anchor, year, counted]);

  // ---- acoes ----
  function move(step: number) {
    if (view === "dia") setAnchor((current) => addDays(current, step));
    else if (view === "mes") setAnchor((current) => `${addMonths(current.slice(0, 7), step)}-01`);
    else setAnchor((current) => `${Number(current.slice(0, 4)) + step}-01-01`);
  }
  const canGoForward = period.end < today;

  async function save(row: Row, changes: { note?: string; ignored?: boolean }) {
    setSaving(true);
    try {
      for (const outage of row.outages) {
        const response = await fetch("/api/outages", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: outage.id, ...changes }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || "Falha ao salvar.");
      }
      setEditing(null);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  function exportCsv() {
    downloadCsv(
      `paradas-${view === "dia" ? anchor : view === "mes" ? anchor.slice(0, 7) : year}.csv`,
      ["Inversor", "Início", "Fim", "Duração total (min)", "Em horário de sol (min)", "Motivo", "Tipo", "Energia perdida (kWh)", "Valor perdido (R$)", "Ignorada", "Observação"],
      inPeriod.map((outage) => [
        outage.name,
        formatDateTime(outage.start),
        outage.end ? formatDateTime(outage.end) : "em andamento",
        Math.round(totalMinutes(outage)),
        Math.round(outage.daylightMinutes),
        outage.reason,
        outage.kind === "comunicacao"
          ? "Sem comunicação"
          : outage.kind === "historico"
            ? "Estimada pelo histórico diário"
            : outage.end
              ? "Parada"
              : "Em andamento",
        outage.lostKwh,
        outage.lostBrl,
        outage.ignored ? "sim" : "não",
        outage.note ?? "",
      ]),
    );
  }

  const tabClass = (active: boolean) =>
    `rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-wider transition-colors ${
      active
        ? "bg-[#0d2a1d] text-white dark:bg-amber-500 dark:text-[#0d1a12]"
        : "bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-white/5 dark:text-emerald-200/70 dark:hover:bg-white/10"
    }`;

  // ---- status do monitoramento ----
  const lastAt = history?.last?.at;
  const lastAgo = lastAt ? minutesSince(lastAt) : null;
  const hourNow = Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const monitorLate = lastAgo !== null && lastAgo > 20 && hourNow >= 6 && hourNow < 18;

  const editor = (row: Row) => (
    <div className="mt-2 space-y-2">
      <textarea
        value={noteDraft}
        onChange={(event) => setNoteDraft(event.target.value)}
        maxLength={500}
        rows={2}
        placeholder="Ex.: disjuntor desarmou, técnico religou"
        className="w-full min-w-[200px] rounded-xl border border-slate-200 bg-white p-2 text-xs font-semibold text-[#052e16] dark:border-emerald-900/40 dark:bg-[#0f1d15] dark:text-white"
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={() => save(row, { note: noteDraft })} className="rounded-full bg-[#0d2a1d] px-3 py-1 text-[10px] font-black uppercase text-white disabled:opacity-50 dark:bg-amber-500 dark:text-[#0d1a12]">
          Salvar
        </button>
        <button type="button" disabled={saving} onClick={() => save(row, { ignored: !row.ignored })} className="rounded-full bg-slate-100 px-3 py-1 text-[10px] font-black uppercase text-slate-700 disabled:opacity-50 dark:bg-white/10 dark:text-white">
          {row.ignored ? "Voltar a contar" : "Ignorar (falso alarme)"}
        </button>
        <button type="button" onClick={() => setEditing(null)} className="px-2 text-[10px] font-black uppercase text-slate-400">
          Cancelar
        </button>
      </div>
      {!history?.configured && <p className="text-[10px] font-bold text-amber-600">Para salvar observações, conecte o banco (Upstash).</p>}
    </div>
  );

  const noteButton = (row: Row) =>
    row.end ? (
      <button
        type="button"
        onClick={() => {
          setEditing(row.key);
          setNoteDraft(row.note ?? "");
        }}
        className="text-left text-xs font-semibold text-slate-600 hover:text-emerald-700 dark:text-emerald-200/70"
      >
        {row.note ? `📝 ${row.note}` : "✏️ adicionar observação"}
      </button>
    ) : (
      <span className="text-xs text-slate-400">—</span>
    );

  const kindBadge = (row: Row) =>
    row.kind === "comunicacao" ? (
      <span className="mt-0.5 block text-[10px] font-black uppercase text-amber-600 dark:text-amber-400">só comunicação · seguiu gerando</span>
    ) : row.historical ? (
      <span className="mt-0.5 block text-[10px] font-black uppercase text-sky-600 dark:text-sky-400">
        estimado pelo histórico · gerou {nf.format(row.actualKwh)} de {nf.format(row.expectedKwh)} kWh esperados
        {row.missingDays > 0 &&
          ` · ${row.missingDays === row.days ? "sem registro no SEMS+" : `${row.missingDays} dia${row.missingDays > 1 ? "s" : ""} sem registro no SEMS+`}`}
      </span>
    ) : null;

  return (
    <section className="rounded-[2.5rem] border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-900/30 dark:bg-[#0f1d15] sm:p-8">
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-xl font-black text-[#052e16] dark:text-white">Histórico de paradas dos inversores</h2>
          <p className="text-xs font-bold text-slate-500 dark:text-emerald-400/50">
            Quando a usina ou cada inversor parou, por quanto tempo e quanto deixou de gerar.
          </p>
          {history?.configured && (
            <p className="mt-2 flex items-center gap-2 text-[11px] font-bold text-slate-500 dark:text-emerald-300/60">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${monitorLate || history.last?.error ? "bg-amber-500" : "bg-emerald-500 animate-pulse"}`} />
              <span>
                {lastAt
                  ? `Última verificação ${formatDateTime(lastAt)} (há ${formatDuration(lastAgo ?? 0)})`
                  : "Aguardando a primeira verificação"}
                {history.since && ` · monitoramento ao vivo desde ${new Date(history.since).toLocaleDateString("pt-BR", { timeZone: TZ })}`}
              </span>
            </p>
          )}
          {monitorLate && (
            <p className="mt-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
              A verificação automática está atrasada. Confira a aba Actions do GitHub ou deixe o painel aberto.
            </p>
          )}
          {history?.last?.error && (
            <p className="mt-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">Última verificação falhou: {history.last.error}</p>
          )}
        </div>
        {history && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={tabClass(view === "dia")} onClick={() => setView("dia")}>Dia</button>
            <button type="button" className={tabClass(view === "mes")} onClick={() => setView("mes")}>Mês</button>
            <button type="button" className={tabClass(view === "ano")} onClick={() => setView("ano")}>Ano</button>
            <input
              type="date"
              max={today}
              value={anchor}
              onChange={(event) => event.target.value && setAnchor(event.target.value)}
              className="rounded-full bg-slate-100 px-3 py-2 text-xs font-bold text-[#052e16] dark:bg-white/5 dark:text-white dark:[color-scheme:dark]"
            />
            <button
              type="button"
              onClick={exportCsv}
              disabled={!inPeriod.length}
              className="rounded-full border border-emerald-600/30 px-4 py-2 text-[11px] font-black uppercase tracking-wider text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-400 dark:hover:bg-emerald-900/20"
            >
              Exportar CSV
            </button>
          </div>
        )}
      </div>

      {error && <p className="mb-4 rounded-2xl bg-rose-50 p-4 text-sm font-bold text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">{error}</p>}

      {!history ? (
        !error && <div className="flex h-40 items-center justify-center text-xs font-black uppercase tracking-widest text-slate-400 animate-pulse">Carregando paradas...</div>
      ) : (
        <>
          {!history.configured && (
            <div className="mb-5 rounded-2xl border-2 border-dashed border-amber-300 bg-amber-50/60 p-4 text-xs text-amber-900 dark:border-amber-700/50 dark:bg-amber-900/10 dark:text-amber-200">
              <p className="font-black">O monitoramento ao vivo (a cada 5 min) precisa do banco de dados.</p>
              <p className="mt-1 font-semibold">
                Na Vercel: <b>Storage → Create Database → Upstash for Redis</b>, conecte ao projeto e faça <b>Redeploy</b>.
                As paradas antigas abaixo são estimadas pela geração diária e funcionam sem o banco.
              </p>
            </div>
          )}

          {/* paradas em andamento */}
          {openNow.length > 0 && (
            <div className="mb-5 space-y-2">
              {openNow.map((outage) => (
                <div key={outage.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-300 bg-rose-50 p-4 text-rose-800 dark:border-rose-800/60 dark:bg-rose-900/20 dark:text-rose-200">
                  <p className="text-sm font-black">
                    <span className="mr-2 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" />
                    {outage.name} parado desde {formatDateTime(outage.start)} ({formatDuration(totalMinutes(outage))}) · {outage.reason}
                  </p>
                  <p className="text-xs font-black">
                    ~{nf.format(outage.lostKwh)} kWh · {cf.format(outage.lostBrl)} perdidos até agora
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* navegacao do periodo */}
          <div className="mb-4 flex items-center justify-between gap-2 rounded-2xl bg-slate-50 p-2 dark:bg-[#0d1a12]">
            <button type="button" onClick={() => move(-1)} className="rounded-xl px-4 py-2 text-sm font-black text-[#052e16] hover:bg-white dark:text-white dark:hover:bg-white/10">
              ← Anterior
            </button>
            <p className="text-center text-sm font-black text-[#052e16] dark:text-white">{period.title}</p>
            <button
              type="button"
              disabled={!canGoForward}
              onClick={() => move(1)}
              className="rounded-xl px-4 py-2 text-sm font-black text-[#052e16] hover:bg-white disabled:opacity-30 dark:text-white dark:hover:bg-white/10"
            >
              Próximo →
            </button>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat
              label="Paradas"
              value={String(countedRows.length)}
              hint={
                [
                  summary.historicalDays ? `${summary.historicalDays} dia${summary.historicalDays > 1 ? "s" : ""} com a usina parada/baixa` : "",
                  summary.communication ? `${summary.communication} só de comunicação` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
              tone={countedRows.length ? "bad" : "ok"}
            />
            <Stat label="Tempo parado (sol)" value={formatSunHours(summary.sunMinutes)} hint="horas de sol sem gerar, 05:30–17:30" />
            <Stat label="Energia perdida" value={`${nf.format(summary.lostKwh)} kWh`} hint="estimativa" tone={summary.lostKwh > 0 ? "bad" : undefined} />
            <Stat label="Dinheiro perdido" value={cf.format(summary.lostBrl)} hint={`tarifa ${cf.format(history.tariff)}/kWh`} tone={summary.lostBrl > 0 ? "bad" : undefined} />
            <Stat
              label="Disponibilidade"
              value={summary.availability === null ? "—" : `${nf.format(summary.availability)}%`}
              hint={summary.monitoredDays ? `${summary.monitoredDays} dia${summary.monitoredDays > 1 ? "s" : ""} analisado${summary.monitoredDays > 1 ? "s" : ""}` : "sem dados no período"}
              tone={summary.availability !== null && summary.availability >= 99 ? "ok" : summary.availability !== null && summary.availability < 90 ? "bad" : undefined}
            />
          </div>

          {view === "dia" ? (
            <DayTimeline day={anchor} inverters={inverters} outages={inPeriod} />
          ) : (
            <LossBars
              bars={bars}
              onSelect={(key) => {
                setAnchor(key);
                setView(view === "ano" ? "mes" : "dia");
              }}
            />
          )}

          {/* por inversor */}
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 dark:border-emerald-900/30">
                  <th className="pb-3 pr-4">Inversor</th>
                  <th className="pb-3 pr-4">Paradas</th>
                  <th className="pb-3 pr-4">Tempo parado (sol)</th>
                  <th className="pb-3 pr-4">Energia perdida</th>
                  <th className="pb-3">Dinheiro perdido</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                {byInverter.map(([sn, row]) => (
                  <tr key={sn} className="font-bold dark:text-white">
                    <td className="py-3 pr-4 font-black">{row.name}</td>
                    <td className="py-3 pr-4">{sn === "usina" ? `${row.count} dia${row.count > 1 ? "s" : ""}` : row.count}</td>
                    <td className="py-3 pr-4">{row.count ? formatSunHours(row.minutes) : "—"}</td>
                    <td className="py-3 pr-4">{row.count ? `${nf.format(row.kwh)} kWh` : "—"}</td>
                    <td className={`py-3 ${row.brl > 0 ? "text-rose-600 dark:text-rose-400" : ""}`}>{row.count ? cf.format(row.brl) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* registros */}
          <h3 className="mb-3 mt-8 text-sm font-black uppercase tracking-wider text-slate-500 dark:text-emerald-300/60">
            Registros ({rows.length})
          </h3>
          {rows.length === 0 ? (
            <p className="rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">
              {summary.monitoredDays ? "Nenhuma parada neste período. 🎉" : "Sem dados de geração neste período."}
            </p>
          ) : (
            <>
              <ul className="space-y-3 sm:hidden">
                {rows.map((row) => (
                  <li
                    key={row.key}
                    className={`rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-emerald-900/20 dark:bg-[#0d1a12] ${row.ignored ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-black text-[#052e16] dark:text-white">{row.name}</p>
                      <p className="text-right text-sm font-black text-rose-600 dark:text-rose-400">
                        {nf.format(row.lostKwh)} kWh
                        <span className="block text-xs">{cf.format(row.lostBrl)}</span>
                      </p>
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-600 dark:text-emerald-200/70">
                      {rowPeriod(row)} · {rowDuration(row)}
                    </p>
                    <p className="mt-1 text-xs font-bold text-slate-500 dark:text-emerald-300/60">
                      {row.reason}
                      {row.ignored && " · ignorada"}
                    </p>
                    {kindBadge(row)}
                    <div className="mt-2">{noteButton(row)}</div>
                    {editing === row.key && editor(row)}
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 dark:border-emerald-900/30">
                      <th className="pb-3 pr-3">Inversor</th>
                      <th className="pb-3 pr-3">Período</th>
                      <th className="pb-3 pr-3">Duração</th>
                      <th className="pb-3 pr-3">Motivo</th>
                      <th className="pb-3 pr-3">Perdido</th>
                      <th className="pb-3">Observação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                    {rows.map((row) => (
                      <tr key={row.key} className={`align-top font-bold dark:text-white ${row.ignored ? "opacity-40" : ""}`}>
                        <td className="py-3 pr-3 font-black">{row.name}</td>
                        <td className={`py-3 pr-3 whitespace-nowrap ${row.end ? "" : "text-rose-600 dark:text-rose-400"}`}>{rowPeriod(row)}</td>
                        <td className="py-3 pr-3 whitespace-nowrap">{rowDuration(row)}</td>
                        <td className="py-3 pr-3">
                          {row.reason}
                          {kindBadge(row)}
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap">
                          <span className={row.lostKwh > 0 ? "text-rose-600 dark:text-rose-400" : ""}>{nf.format(row.lostKwh)} kWh</span>
                          <span className="block text-xs">{cf.format(row.lostBrl)}</span>
                          {row.ignored && <span className="block text-[10px] uppercase">ignorada</span>}
                        </td>
                        <td className="max-w-[260px] py-3 text-xs">
                          {editing === row.key ? editor(row) : noteButton(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {history.historicalError && (
            <p className="mt-4 text-[11px] font-bold text-amber-600 dark:text-amber-400">{history.historicalError}</p>
          )}
          <p className="mt-4 text-[11px] font-bold text-slate-400">
            Monitoramento ao vivo (a cada 5 min): a energia perdida é estimada pela produção dos outros inversores no mesmo
            momento, ou pela curva solar típica quando a usina inteira para; se o inversor só perdeu a conexão com o portal
            e seguiu gerando, nada é contado. Dias anteriores ao monitoramento ao vivo são estimados pela geração total do
            dia no SEMS+ comparada ao que a usina deveria gerar
            {history.historicalMethod === "clima" ? " com a radiação solar real daquele dia (dias de chuva não viram parada)" : " pela mediana dos dias normais"};
            {" "}nesses dias não há detalhe por inversor nem horário exato. Use “Ignorar” para descartar um falso alarme.
          </p>
        </>
      )}
    </section>
  );
}
