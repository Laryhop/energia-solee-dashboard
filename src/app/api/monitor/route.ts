import { NextResponse } from "next/server";

import { runMonitor } from "@/lib/monitor";
import { getStationToday, syncProductionStore, type ProductionSyncResult } from "@/lib/sems/client";
import { isStorageConfigured, redis } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** O banco guarda a geracao diaria desde 1º de janeiro do ano anterior. */
const BACKFILL_BUDGET_MS = 25_000;
const KEY_BACKFILL_DONE = "solee:backfill:done";

function addMonths(month: string, count: number) {
  const [year, value] = month.split("-").map(Number);
  return new Date(Date.UTC(year, value - 1 + count, 1)).toISOString().slice(0, 7);
}

/**
 * Preenche o banco mes a mes (os que ja estao completos nao vao na API).
 * Para por tempo e continua na proxima chamada.
 */
async function backfill() {
  // Depois de completo, so confere de novo a cada 6 horas (os dias novos entram sozinhos ao serem lidos).
  const [done] = await redis([["GET", KEY_BACKFILL_DONE]]);
  if (done) return { complete: true, checkedAt: done };

  const started = Date.now();
  const today = getStationToday();
  const from = `${Number(today.slice(0, 4)) - 1}-01`;
  const totals: ProductionSyncResult & { months: number; complete: boolean; from: string } = {
    storedDays: 0,
    fetchedDays: 0,
    recentDays: 0,
    firstDay: null,
    lastStoredDay: null,
    months: 0,
    complete: true,
    from: `${from}-01`,
  };

  for (let month = from; month <= today.slice(0, 7); month = addMonths(month, 1)) {
    if (Date.now() - started > BACKFILL_BUDGET_MS) {
      totals.complete = false;
      break;
    }
    const [year, value] = month.split("-").map(Number);
    const end = new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
    const result = await syncProductionStore(`${month}-01`, end);
    totals.months += 1;
    totals.storedDays += result.storedDays;
    totals.fetchedDays += result.fetchedDays;
    totals.recentDays += result.recentDays;
    totals.firstDay ??= result.firstDay;
    if (result.lastStoredDay) totals.lastStoredDay = result.lastStoredDay;
  }
  if (totals.complete) await redis([["SET", KEY_BACKFILL_DONE, new Date().toISOString(), "EX", 6 * 3600]]);
  return totals;
}

/*
 * Verificacao de paradas, chamada a cada 5 minutos pelo GitHub Actions
 * (.github/workflows/monitor.yml). E publica de proposito, para nao exigir
 * segredos: so le o SEMS+, tem trava de 55 s contra chamadas repetidas e
 * nao devolve dados da usina alem de contagens.
 */
async function handle() {
  if (!isStorageConfigured()) {
    return NextResponse.json(
      { ok: false, error: "Armazenamento nao configurado. Conecte o Upstash Redis ao projeto na Vercel." },
      { status: 503 },
    );
  }

  try {
    const result = await runMonitor();
    let history: unknown;
    if (!("skipped" in result && result.skipped === "recent")) {
      history = await backfill().catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    }
    return NextResponse.json({ ...result, history });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Falha na verificacao." },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const POST = handle;
