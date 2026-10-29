"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cf, downloadCsv, monthLabel, nf, nf0 } from "@/lib/format";
import { parseRateioXlsx, type ParsedRateio } from "@/lib/rateio-parse";

// ---------- tipos (espelham src/lib/rateio.ts) ----------

type Entry = { uc: string; doc: string; pct: number | null; order: number };
type Version = {
  id: string;
  effectiveMonth: string;
  requestDate: string | null;
  ugUc: string | null;
  enquadramento: string | null;
  forma: string | null;
  fileName: string | null;
  uploadedAt: string;
  totalPct: number;
  entries: Entry[];
};
type Data = {
  configured: boolean;
  tariff: number;
  today: string;
  versions: Version[];
  names: Record<string, string>;
  months: Array<{ month: string; kwh: number; partial: boolean }>;
};

const key = (uc: string) => uc.replace(/\D/g, "");
const pctFmt = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 3 });

function addMonths(month: string, count: number) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + count, 1)).toISOString().slice(0, 7);
}

/** Esconde o meio do CPF (CNPJ fica visivel). */
function maskDoc(doc: string) {
  const digits = doc.replace(/\D/g, "");
  if (digits.length !== 11) return doc;
  return `${digits.slice(0, 3)}.***.***-${digits.slice(9)}`;
}

function formatDate(day: string | null) {
  return day ? day.split("-").reverse().join("/") : "—";
}

// ---------- pecas ----------

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 dark:border-emerald-900/20 dark:bg-[#0d1a12]">
      <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{label}</p>
      <p className={`mt-1 text-lg font-black ${tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-[#052e16] dark:text-white"}`}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] font-bold text-slate-500 dark:text-emerald-300/50">{hint}</p>}
    </div>
  );
}

const card = "rounded-[2.5rem] border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-900/30 dark:bg-[#0f1d15] sm:p-8";
const btn =
  "rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-wider transition-colors disabled:opacity-40";
const btnPrimary = `${btn} bg-[#0d2a1d] text-white hover:bg-[#123824] dark:bg-amber-500 dark:text-[#0d1a12] dark:hover:bg-amber-400`;
const btnGhost = `${btn} border border-emerald-600/30 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-900/20`;

// ---------- componente ----------

export function RateioTab() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showDocs, setShowDocs] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"planilha" | "pct" | "nome">("planilha");
  const [upload, setUpload] = useState<{ parsed: ParsedRateio; fileName: string; effectiveMonth: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [accYear, setAccYear] = useState<string>("todos");
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/rateio", { cache: "no-store" });
      if (response.status === 401) {
        window.location.reload();
        return;
      }
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Falha ao carregar o rateio.");
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao carregar o rateio.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ---------- calculos ----------
  const today = data?.today ?? new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const previousMonth = addMonths(currentMonth, -1);
  const versions = useMemo(() => data?.versions ?? [], [data]);
  const names = useMemo(() => data?.names ?? {}, [data]);
  const tariff = data?.tariff ?? 0;

  /** Versao vigente num mes de referencia. */
  const versionFor = useCallback(
    (month: string) => [...versions].reverse().find((version) => version.effectiveMonth <= month) ?? null,
    [versions],
  );
  const current = versionFor(currentMonth) ?? versions.at(-1) ?? null;
  const previousVersion = current ? versions[versions.indexOf(current) - 1] ?? null : null;
  const generation = useMemo(() => new Map((data?.months ?? []).map((row) => [row.month, row])), [data]);
  const baseKwh = generation.get(previousMonth)?.kwh ?? 0;

  // Creditos por UC e mes (meses fechados desde a primeira vigencia)
  const accumulated = useMemo(() => {
    const firstMonth = versions[0]?.effectiveMonth;
    const months: string[] = [];
    if (firstMonth) for (let month = firstMonth; month < currentMonth; month = addMonths(month, 1)) months.push(month);
    const perUc = new Map<string, { uc: string; doc: string; byMonth: Map<string, number>; total: number }>();
    for (const month of months) {
      const version = versionFor(month);
      const kwh = generation.get(month)?.kwh ?? 0;
      if (!version) continue;
      for (const entry of version.entries) {
        const id = key(entry.uc);
        const row = perUc.get(id) ?? { uc: entry.uc, doc: entry.doc, byMonth: new Map(), total: 0 };
        const credit = kwh * (entry.pct ?? 0);
        row.byMonth.set(month, credit);
        row.total += credit;
        perUc.set(id, row);
      }
    }
    // Inclui as UCs da lista atual que ainda nao receberam nada
    for (const entry of current?.entries ?? []) {
      if (!perUc.has(key(entry.uc))) perUc.set(key(entry.uc), { uc: entry.uc, doc: entry.doc, byMonth: new Map(), total: 0 });
    }
    return { months, rows: [...perUc.values()] };
  }, [versions, versionFor, generation, currentMonth, current]);

  const accTotal = new Map(accumulated.rows.map((row) => [key(row.uc), row.total]));
  const accYears = [...new Set(accumulated.months.map((month) => month.slice(0, 4)))];
  const accMonths = accYear === "todos" ? accumulated.months : accumulated.months.filter((month) => month.startsWith(accYear));

  const list = useMemo(() => {
    const previousKeys = new Set((previousVersion?.entries ?? []).map((entry) => key(entry.uc)));
    let rows = (current?.entries ?? []).map((entry) => ({
      ...entry,
      id: key(entry.uc),
      name: names[key(entry.uc)] ?? "",
      isNew: Boolean(previousVersion) && !previousKeys.has(key(entry.uc)),
      isPlant: Boolean(current?.ugUc) && key(entry.uc) === key(current?.ugUc ?? ""),
      estimate: baseKwh * (entry.pct ?? 0),
    }));
    const term = search.trim().toLowerCase();
    if (term) {
      const digits = term.replace(/\D/g, "");
      rows = rows.filter(
        (row) => row.name.toLowerCase().includes(term) || (digits && (row.id.includes(digits) || row.doc.replace(/\D/g, "").includes(digits))),
      );
    }
    if (sort === "pct") rows.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
    if (sort === "nome") rows.sort((a, b) => (a.name || "~").localeCompare(b.name || "~", "pt-BR"));
    return rows;
  }, [current, previousVersion, names, baseKwh, search, sort]);

  // ---------- planilha nova ----------
  async function onFile(file: File) {
    setReading(true);
    setError(null);
    setMessage(null);
    try {
      const parsed = await parseRateioXlsx(file);
      const effectiveMonth = parsed.requestDate ? parsed.requestDate.slice(0, 7) : currentMonth;
      setUpload({ parsed, fileName: file.name, effectiveMonth });
    } catch (err) {
      setError(err instanceof Error ? `Não consegui ler a planilha: ${err.message}` : "Não consegui ler a planilha.");
    } finally {
      setReading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const nameOf = (uc: string) => upload?.parsed.names[key(uc)] || names[key(uc)] || "";

  const diff = useMemo(() => {
    if (!upload) return null;
    const base = versionFor(upload.effectiveMonth) ?? versions.at(-1) ?? null;
    const before = new Map((base?.entries ?? []).map((entry) => [key(entry.uc), entry]));
    const after = new Map(upload.parsed.entries.map((entry) => [key(entry.uc), entry]));
    const added = upload.parsed.entries.filter((entry) => !before.has(key(entry.uc)));
    const removed = (base?.entries ?? []).filter((entry) => !after.has(key(entry.uc)));
    const changed = upload.parsed.entries
      .filter((entry) => before.has(key(entry.uc)) && Math.abs((before.get(key(entry.uc))?.pct ?? 0) - (entry.pct ?? 0)) > 1e-7)
      .map((entry) => ({ entry, old: before.get(key(entry.uc))?.pct ?? 0 }));
    return { base, added, removed, changed };
  }, [upload, versionFor, versions]);

  async function saveUpload() {
    if (!upload) return;
    setSaving(true);
    try {
      const response = await fetch("/api/rateio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...upload.parsed, effectiveMonth: upload.effectiveMonth, fileName: upload.fileName }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error || "Falha ao salvar.");
      setUpload(null);
      setMessage(`Rateio salvo: ${body.entries.length} UCs, valendo a partir de ${monthLabel(body.effectiveMonth, true).toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  async function patch(body: Record<string, string>) {
    const response = await fetch("/api/rateio", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || "Falha ao salvar.");
    await load();
  }

  async function removeVersion(version: Version) {
    if (!window.confirm(`Remover a lista de rateio que vale a partir de ${monthLabel(version.effectiveMonth, true).toLowerCase()}?`)) return;
    const response = await fetch(`/api/rateio?id=${encodeURIComponent(version.id)}`, { method: "DELETE" });
    if (!response.ok) setError((await response.json())?.error || "Falha ao remover.");
    await load();
  }

  // ---------- exportacao ----------
  function exportList() {
    downloadCsv(
      `rateio-${current?.effectiveMonth ?? "atual"}.csv`,
      ["UC", "Nome", "CPF/CNPJ", "% do excedente", `Estimativa kWh/mês (base ${monthLabel(previousMonth)})`, "Estimativa R$/mês", "Acumulado kWh"],
      list.map((row) => [row.uc, row.name, row.doc, (row.pct ?? 0) * 100, row.estimate, row.estimate * tariff, accTotal.get(row.id) ?? 0]),
    );
  }

  function exportAccumulated() {
    downloadCsv(
      `rateio-acumulado-${accYear}.csv`,
      ["UC", "Nome", ...accMonths.map((month) => monthLabel(month)), "Total kWh", "Total R$"],
      accumulated.rows.map((row) => {
        const total = accMonths.reduce((sum, month) => sum + (row.byMonth.get(month) ?? 0), 0);
        return [row.uc, names[key(row.uc)] ?? "", ...accMonths.map((month) => row.byMonth.get(month) ?? 0), total, total * tariff];
      }),
    );
  }

  // ---------- render ----------
  if (error && !data) {
    return <p className="rounded-2xl bg-rose-50 p-4 text-sm font-bold text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">{error}</p>;
  }
  if (!data) {
    return <div className="flex h-60 items-center justify-center text-xs font-black uppercase tracking-widest text-slate-400 animate-pulse">Carregando rateio...</div>;
  }

  const uploadButton = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])}
      />
      <button type="button" className={btnPrimary} disabled={reading || !data.configured} onClick={() => fileInput.current?.click()}>
        {reading ? "Lendo planilha..." : "Enviar planilha de rateio"}
      </button>
    </>
  );

  const accSum = (month: string) => accumulated.rows.reduce((sum, row) => sum + (row.byMonth.get(month) ?? 0), 0);
  const accGrand = accMonths.reduce((sum, month) => sum + accSum(month), 0);

  return (
    <div className="space-y-8">
      {/* cabecalho */}
      <section className={card}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-black text-[#052e16] dark:text-white">Rateio dos créditos</h2>
            <p className="text-xs font-bold text-slate-500 dark:text-emerald-400/50">
              Lista de unidades consumidoras que recebem os créditos da usina, enviada à Equatorial.
            </p>
            {current && (
              <p className="mt-2 text-[11px] font-bold text-slate-500 dark:text-emerald-300/60">
                Lista vigente desde a geração de <b>{monthLabel(current.effectiveMonth, true).toLowerCase()}</b> · solicitação de{" "}
                {formatDate(current.requestDate)} · {current.enquadramento ?? "—"} · {current.forma ?? "—"}
                {current.ugUc && <> · UC geradora {current.ugUc}</>}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">{uploadButton}</div>
        </div>

        {!data.configured && (
          <p className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
            Conecte o banco (Upstash) na Vercel para salvar o rateio.
          </p>
        )}
        {error && <p className="mt-4 rounded-2xl bg-rose-50 p-4 text-sm font-bold text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">{error}</p>}
        {message && <p className="mt-4 rounded-2xl bg-emerald-50 p-4 text-sm font-bold text-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300">{message}</p>}

        {/* previa da planilha enviada */}
        {upload && diff && (
          <div className="mt-6 rounded-[2rem] border-2 border-amber-400/60 bg-amber-50/50 p-5 dark:border-amber-500/30 dark:bg-amber-900/10">
            <p className="text-[10px] font-black uppercase tracking-widest text-amber-700 dark:text-amber-400">Conferir antes de salvar</p>
            <p className="mt-1 text-lg font-black text-[#052e16] dark:text-white">{upload.fileName}</p>
            <p className="text-xs font-bold text-slate-600 dark:text-emerald-200/70">
              {upload.parsed.entries.length} UCs · soma {pctFmt.format(upload.parsed.totalPct)} · solicitação {formatDate(upload.parsed.requestDate)} ·{" "}
              {upload.parsed.forma ?? "—"}
            </p>

            <p className={`mt-2 text-xs font-bold ${Object.keys(upload.parsed.names).length ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-300"}`}>
              {Object.keys(upload.parsed.names).length
                ? `✓ Nome do cliente encontrado para ${Object.keys(upload.parsed.names).length} de ${upload.parsed.entries.length} UCs (aba ${upload.parsed.namesFrom.map((sheet) => `“${sheet}”`).join(", ")}).`
                : "Nenhuma aba com nome do cliente e UC foi encontrada nesta planilha — os nomes já salvos no site serão mantidos."}
            </p>

            <label className="mt-4 flex flex-wrap items-center gap-3 text-sm font-black text-[#052e16] dark:text-white">
              Vale a partir da geração de
              <input
                type="month"
                value={upload.effectiveMonth}
                onChange={(event) => event.target.value && setUpload({ ...upload, effectiveMonth: event.target.value })}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm dark:border-emerald-900/40 dark:bg-[#0d1a12] dark:[color-scheme:dark]"
              />
            </label>
            <p className="mt-1 text-[11px] font-bold text-slate-500 dark:text-emerald-300/60">
              Os créditos desse mês em diante serão calculados com esta lista. Para registrar uma lista antiga, escolha o mês em que ela começou a valer.
            </p>

            {upload.parsed.warnings.map((warning) => (
              <p key={warning} className="mt-3 text-xs font-bold text-amber-700 dark:text-amber-300">⚠️ {warning}</p>
            ))}

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="rounded-2xl bg-white p-4 dark:bg-[#0d1a12]">
                <p className="text-[10px] font-black uppercase text-emerald-700 dark:text-emerald-400">Novas UCs ({diff.added.length})</p>
                <ul className="mt-2 space-y-1 text-xs font-bold text-[#052e16] dark:text-white">
                  {diff.added.slice(0, 30).map((entry) => (
                    <li key={entry.uc}>
                      {nameOf(entry.uc) ? `${nameOf(entry.uc)} · ` : ""}
                      {entry.uc} · {entry.pct !== null ? pctFmt.format(entry.pct) : "—"}
                    </li>
                  ))}
                  {!diff.added.length && <li className="text-slate-400">nenhuma</li>}
                </ul>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-[#0d1a12]">
                <p className="text-[10px] font-black uppercase text-rose-700 dark:text-rose-400">Saíram da lista ({diff.removed.length})</p>
                <ul className="mt-2 space-y-1 text-xs font-bold text-[#052e16] dark:text-white">
                  {diff.removed.slice(0, 30).map((entry) => (
                    <li key={entry.uc}>
                      {nameOf(entry.uc) ? `${nameOf(entry.uc)} · ` : ""}
                      {entry.uc}
                    </li>
                  ))}
                  {!diff.removed.length && <li className="text-slate-400">nenhuma</li>}
                </ul>
              </div>
              <div className="rounded-2xl bg-white p-4 dark:bg-[#0d1a12]">
                <p className="text-[10px] font-black uppercase text-sky-700 dark:text-sky-400">Percentual alterado ({diff.changed.length})</p>
                <ul className="mt-2 space-y-1 text-xs font-bold text-[#052e16] dark:text-white">
                  {diff.changed.slice(0, 30).map(({ entry, old }) => (
                    <li key={entry.uc}>
                      {nameOf(entry.uc) || entry.uc}: {pctFmt.format(old)} → {pctFmt.format(entry.pct ?? 0)}
                    </li>
                  ))}
                  {!diff.changed.length && <li className="text-slate-400">nenhum</li>}
                </ul>
              </div>
            </div>
            {!diff.base && <p className="mt-3 text-xs font-bold text-slate-500">Esta é a primeira lista de rateio do painel.</p>}

            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" className={btnPrimary} disabled={saving} onClick={saveUpload}>
                {saving ? "Salvando..." : "Salvar rateio"}
              </button>
              <button type="button" className={btnGhost} onClick={() => setUpload(null)}>
                Cancelar
              </button>
            </div>
          </div>
        )}

        {!current && !upload && data.configured && (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-slate-200 p-6 text-center dark:border-emerald-900/40">
            <p className="text-sm font-black text-[#052e16] dark:text-white">Nenhuma lista de rateio enviada ainda.</p>
            <p className="mt-1 text-xs font-bold text-slate-500">
              Envie a planilha da Equatorial (.xlsx). O site lê a lista de UCs e os percentuais automaticamente.
            </p>
          </div>
        )}

        {current && (
          <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="UCs no rateio" value={String(current.entries.length)} hint={previousVersion ? `${list.filter((row) => row.isNew).length} nova(s) nesta lista` : undefined} />
            <Stat
              label="Total distribuído"
              value={pctFmt.format(current.totalPct)}
              tone={Math.abs(current.totalPct - 1) > 0.001 ? "warn" : undefined}
              hint={Math.abs(current.totalPct - 1) > 0.001 ? "a soma deveria ser 100%" : "do excedente da usina"}
            />
            <Stat
              label={`Geração de ${monthLabel(previousMonth)}`}
              value={baseKwh ? `${nf0.format(baseKwh)} kWh` : "—"}
              hint="base da estimativa mensal"
            />
            <Stat
              label="Créditos estimados/mês"
              value={baseKwh ? `${nf0.format(baseKwh * current.totalPct)} kWh` : "—"}
              hint={baseKwh ? `${cf.format(baseKwh * current.totalPct * tariff)} pela tarifa de ${cf.format(tariff)}` : undefined}
            />
          </div>
        )}
      </section>

      {/* lista vigente */}
      {current && (
        <section className={card}>
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-xl font-black text-[#052e16] dark:text-white">Lista de rateio vigente</h2>
              <p className="text-xs font-bold text-slate-500 dark:text-emerald-400/50">
                Estimativa = geração de {monthLabel(previousMonth, true).toLowerCase()} × % da UC. Os nomes vêm da planilha; clique no nome para corrigir.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar UC, nome ou CPF"
                className="w-48 rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-[#052e16] placeholder:text-slate-400 dark:bg-white/5 dark:text-white"
              />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
                className="rounded-full bg-slate-100 px-3 py-2 text-xs font-bold text-[#052e16] dark:bg-white/5 dark:text-white"
              >
                <option value="planilha">Ordem da planilha</option>
                <option value="pct">Maior %</option>
                <option value="nome">Nome</option>
              </select>
              <button type="button" className={btnGhost} onClick={() => setShowDocs(!showDocs)}>
                {showDocs ? "Ocultar CPF" : "Mostrar CPF"}
              </button>
              <button type="button" className={btnGhost} onClick={exportList}>
                Exportar CSV
              </button>
            </div>
          </div>

          <ul className="space-y-2 sm:hidden">
            {list.map((row) => (
              <li key={row.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3 dark:border-emerald-900/20 dark:bg-[#0d1a12]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-[#052e16] dark:text-white">
                      {row.name || row.uc}
                      {row.isPlant && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black uppercase text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">usina</span>}
                      {row.isNew && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-black uppercase text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">novo</span>}
                    </p>
                    <p className="font-mono text-[10px] text-slate-400">
                      {row.name ? `${row.uc} · ` : ""}
                      {showDocs ? row.doc : maskDoc(row.doc)}
                    </p>
                  </div>
                  <p className="shrink-0 text-right text-sm font-black text-[#052e16] dark:text-white">{row.pct !== null ? pctFmt.format(row.pct) : "—"}</p>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-500 dark:text-emerald-200/70">
                  <p>
                    Estimativa/mês
                    <span className="block text-sm font-black text-[#052e16] dark:text-white">{baseKwh ? `${nf.format(row.estimate)} kWh` : "—"}</span>
                    {baseKwh > 0 && <span className="text-emerald-600 dark:text-emerald-400">{cf.format(row.estimate * tariff)}</span>}
                  </p>
                  <p>
                    Acumulado enviado
                    <span className="block text-sm font-black text-[#052e16] dark:text-white">{nf.format(accTotal.get(row.id) ?? 0)} kWh</span>
                    {cf.format((accTotal.get(row.id) ?? 0) * tariff)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const name = window.prompt(`Nome para a UC ${row.uc}:`, row.name);
                    if (name !== null) patch({ uc: row.uc, name }).catch((err) => setError(err instanceof Error ? err.message : "Falha ao salvar."));
                  }}
                  className="mt-2 text-[11px] font-bold text-slate-500 dark:text-emerald-300/60"
                >
                  ✏️ {row.name ? "mudar nome" : "dar nome"}
                </button>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 dark:border-emerald-900/30">
                  <th className="pb-3 pr-3">#</th>
                  <th className="pb-3 pr-3">UC</th>
                  <th className="pb-3 pr-3">Cliente</th>
                  <th className="pb-3 pr-3">Titular (CPF/CNPJ)</th>
                  <th className="pb-3 pr-3 text-right">% do excedente</th>
                  <th className="pb-3 pr-3 text-right">Estimativa/mês</th>
                  <th className="pb-3 text-right">Acumulado enviado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                {list.map((row) => (
                  <tr key={row.id} className="font-bold dark:text-white">
                    <td className="py-2.5 pr-3 text-xs text-slate-400">{row.order}</td>
                    <td className="py-2.5 pr-3 whitespace-nowrap font-mono text-xs">
                      {row.uc}
                      {row.isPlant && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-sans text-[9px] font-black uppercase text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">usina</span>}
                      {row.isNew && <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 font-sans text-[9px] font-black uppercase text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">novo</span>}
                    </td>
                    <td className="py-2.5 pr-3">
                      {editingName === row.id ? (
                        <form
                          className="flex gap-1"
                          onSubmit={async (event) => {
                            event.preventDefault();
                            try {
                              await patch({ uc: row.uc, name: nameDraft });
                              setEditingName(null);
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Falha ao salvar.");
                            }
                          }}
                        >
                          <input
                            autoFocus
                            value={nameDraft}
                            maxLength={80}
                            onChange={(event) => setNameDraft(event.target.value)}
                            className="w-40 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-emerald-900/40 dark:bg-[#0d1a12]"
                          />
                          <button type="submit" className="rounded-lg bg-[#0d2a1d] px-2 text-[10px] font-black text-white dark:bg-amber-500 dark:text-[#0d1a12]">
                            OK
                          </button>
                          <button type="button" onClick={() => setEditingName(null)} className="px-1 text-[10px] text-slate-400">
                            ✕
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingName(row.id);
                            setNameDraft(row.name);
                          }}
                          className="text-left text-sm font-bold hover:text-emerald-700 dark:hover:text-emerald-300"
                        >
                          {row.name || <span className="text-xs font-semibold text-slate-400">✏️ dar nome</span>}
                        </button>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap font-mono text-xs text-slate-500 dark:text-emerald-200/70">{showDocs ? row.doc : maskDoc(row.doc)}</td>
                    <td className="py-2.5 pr-3 text-right">{row.pct !== null ? pctFmt.format(row.pct) : "—"}</td>
                    <td className="py-2.5 pr-3 text-right whitespace-nowrap">
                      {baseKwh ? `${nf.format(row.estimate)} kWh` : "—"}
                      {baseKwh > 0 && <span className="block text-[11px] text-emerald-600 dark:text-emerald-400">{cf.format(row.estimate * tariff)}</span>}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {nf.format(accTotal.get(row.id) ?? 0)} kWh
                      <span className="block text-[11px] text-slate-400">{cf.format((accTotal.get(row.id) ?? 0) * tariff)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!list.length && <p className="mt-4 text-sm font-bold text-slate-400">Nenhuma UC encontrada para “{search}”.</p>}
        </section>
      )}

      {/* acumulado */}
      {current && (
        <section className={card}>
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-xl font-black text-[#052e16] dark:text-white">Créditos enviados por mês</h2>
              <p className="text-xs font-bold text-slate-500 dark:text-emerald-400/50">
                Geração de cada mês × % da lista que valia naquele mês. O mês atual entra quando fechar.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={accYear}
                onChange={(event) => setAccYear(event.target.value)}
                className="rounded-full bg-slate-100 px-3 py-2 text-xs font-bold text-[#052e16] dark:bg-white/5 dark:text-white"
              >
                <option value="todos">Todos os meses</option>
                {accYears.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </select>
              <button type="button" className={btnGhost} onClick={exportAccumulated} disabled={!accMonths.length}>
                Exportar CSV
              </button>
            </div>
          </div>

          {!accMonths.length ? (
            <p className="rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-500 dark:bg-[#0d1a12] dark:text-emerald-300/60">
              Ainda não há mês fechado desde a vigência da primeira lista ({monthLabel(versions[0].effectiveMonth, true).toLowerCase()}). Se
              essa lista já valia antes, ajuste o mês de vigência em “Listas enviadas” abaixo ou envie as planilhas antigas.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" style={{ minWidth: `${360 + accMonths.length * 90}px` }}>
                <thead>
                  <tr className="border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 dark:border-emerald-900/30">
                    <th className="sticky left-0 z-10 bg-white pb-3 pr-3 dark:bg-[#0f1d15]">UC</th>
                    {accMonths.map((month) => (
                      <th key={month} className="pb-3 pr-3 text-right">
                        {monthLabel(month)}
                      </th>
                    ))}
                    <th className="pb-3 pr-3 text-right">Total kWh</th>
                    <th className="pb-3 text-right">Total R$</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                  {[...accumulated.rows]
                    .sort((a, b) => b.total - a.total)
                    .map((row) => {
                      const total = accMonths.reduce((sum, month) => sum + (row.byMonth.get(month) ?? 0), 0);
                      const inCurrent = current.entries.some((entry) => key(entry.uc) === key(row.uc));
                      return (
                        <tr key={row.uc} className={`font-bold dark:text-white ${inCurrent ? "" : "opacity-50"}`}>
                          <td className="sticky left-0 z-10 bg-white py-2 pr-3 dark:bg-[#0f1d15]">
                            <span className="block max-w-[200px] truncate">{names[key(row.uc)] || row.uc}</span>
                            {names[key(row.uc)] && <span className="block font-mono text-[10px] text-slate-400">{row.uc}</span>}
                            {!inCurrent && <span className="block text-[10px] uppercase text-rose-500">fora da lista atual</span>}
                          </td>
                          {accMonths.map((month) => (
                            <td key={month} className="py-2 pr-3 text-right whitespace-nowrap">
                              {row.byMonth.has(month) ? nf.format(row.byMonth.get(month) ?? 0) : <span className="text-slate-300">—</span>}
                            </td>
                          ))}
                          <td className="py-2 pr-3 text-right font-black whitespace-nowrap">{nf.format(total)}</td>
                          <td className="py-2 text-right whitespace-nowrap text-emerald-600 dark:text-emerald-400">{cf.format(total * tariff)}</td>
                        </tr>
                      );
                    })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-200 font-black dark:border-emerald-900/40 dark:text-white">
                    <td className="sticky left-0 z-10 bg-white py-2 pr-3 dark:bg-[#0f1d15]">Total enviado</td>
                    {accMonths.map((month) => (
                      <td key={month} className="py-2 pr-3 text-right whitespace-nowrap">
                        {nf.format(accSum(month))}
                      </td>
                    ))}
                    <td className="py-2 pr-3 text-right whitespace-nowrap">{nf.format(accGrand)}</td>
                    <td className="py-2 text-right whitespace-nowrap text-emerald-600 dark:text-emerald-400">{cf.format(accGrand * tariff)}</td>
                  </tr>
                  <tr className="text-[11px] font-bold text-slate-400">
                    <td className="sticky left-0 z-10 bg-white py-1 pr-3 dark:bg-[#0f1d15]">Geração da usina</td>
                    {accMonths.map((month) => (
                      <td key={month} className="py-1 pr-3 text-right whitespace-nowrap">
                        {nf.format(generation.get(month)?.kwh ?? 0)}
                      </td>
                    ))}
                    <td className="py-1 pr-3 text-right whitespace-nowrap">
                      {nf.format(accMonths.reduce((sum, month) => sum + (generation.get(month)?.kwh ?? 0), 0))}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}

      {/* versoes */}
      {versions.length > 0 && (
        <section className={card}>
          <h2 className="text-xl font-black text-[#052e16] dark:text-white">Listas enviadas</h2>
          <p className="mb-4 text-xs font-bold text-slate-500 dark:text-emerald-400/50">
            Cada planilha vale a partir do mês indicado até a próxima. Ajuste o mês se precisar.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] font-black uppercase text-slate-400 dark:border-emerald-900/30">
                  <th className="pb-3 pr-3">Vale a partir de</th>
                  <th className="pb-3 pr-3">Solicitação</th>
                  <th className="pb-3 pr-3">UCs</th>
                  <th className="pb-3 pr-3">Soma</th>
                  <th className="pb-3 pr-3">Arquivo</th>
                  <th className="pb-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50 dark:divide-emerald-900/10">
                {[...versions].reverse().map((version) => (
                  <tr key={version.id} className="font-bold dark:text-white">
                    <td className="py-2.5 pr-3">
                      <input
                        type="month"
                        defaultValue={version.effectiveMonth}
                        onBlur={async (event) => {
                          if (event.target.value && event.target.value !== version.effectiveMonth) {
                            try {
                              await patch({ id: version.id, effectiveMonth: event.target.value });
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Falha ao salvar.");
                            }
                          }
                        }}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs dark:border-emerald-900/40 dark:bg-[#0d1a12] dark:[color-scheme:dark]"
                      />
                      {version === current && <span className="ml-2 text-[10px] font-black uppercase text-emerald-600">vigente</span>}
                    </td>
                    <td className="py-2.5 pr-3">{formatDate(version.requestDate)}</td>
                    <td className="py-2.5 pr-3">{version.entries.length}</td>
                    <td className="py-2.5 pr-3">{pctFmt.format(version.totalPct)}</td>
                    <td className="max-w-[220px] truncate py-2.5 pr-3 text-xs text-slate-500">
                      {version.fileName ?? "—"}
                      <span className="block text-[10px]">enviado {new Date(version.uploadedAt).toLocaleDateString("pt-BR")}</span>
                    </td>
                    <td className="py-2.5 text-right">
                      <button type="button" onClick={() => removeVersion(version)} className="text-[10px] font-black uppercase text-rose-500 hover:text-rose-700">
                        Remover
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-[11px] font-bold text-slate-400">
            Os créditos são estimados pela geração total da usina medida no SEMS+. O valor real compensado pela Equatorial considera o
            excedente injetado na rede (geração menos o consumo da própria UC geradora) e pode ser um pouco diferente.
          </p>
        </section>
      )}
    </div>
  );
}
