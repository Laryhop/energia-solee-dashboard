import { NextResponse } from "next/server";

import { runMonitor } from "@/lib/monitor";
import { getStationToday, syncProductionStore, type ProductionSyncResult } from "@/lib/sems/client";
import { isStorageConfigured, redis } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** O banco guarda a geracao diaria desde 1º de janeiro do ano anterior. */
const BACKFILL_BUDGET_MS = 25_000;
/** No maximo 4 meses buscados na API por chamada, com pausa entre eles (o SEMS+ bloqueia rajadas). */
const MAX_MONTHS_FETCHED = 4;
const PAUSE_MS = 2_000;
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
  const [done, lock] = await redis([
    ["GET", KEY_BACKFILL_DONE],
    ["SET", "solee:backfill:lock", "1", "NX", "EX", 90],
  ]);
  if (done) return { complete: true, checkedAt: done };
  const [cooldown] = await redis([["GET", "solee:backfill:cooldown"]]);
  if (cooldown) return { complete: false, waiting: "SEMS+ limitou as requisicoes; retoma na proxima verificacao." };
  if (lock !== "OK") return { complete: false, running: true, ownsLock: false };

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

  let fetchedMonths = 0;
  for (let month = from; month <= today.slice(0, 7); month = addMonths(month, 1)) {
    if (Date.now() - started > BACKFILL_BUDGET_MS) {
      totals.complete = false;
      break;
    }
    const [year, value] = month.split("-").map(Number);
    const end = new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10);
    let result: ProductionSyncResult;
    try {
      result = await syncProductionStore(`${month}-01`, end);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("429") || message.includes("limitou")) {
        await redis([["SET", "solee:backfill:cooldown", "1", "EX", 600]]);
      }
      return { ...totals, complete: false, stoppedAt: month, error: message };
    }
    totals.months += 1;
    totals.storedDays += result.storedDays;
    totals.fetchedDays += result.fetchedDays;
    totals.recentDays += result.recentDays;
    totals.firstDay ??= result.firstDay;
    if (result.lastStoredDay) totals.lastStoredDay = result.lastStoredDay;
    if (result.fetchedDays > 0) {
      fetchedMonths += 1;
      if (fetchedMonths >= MAX_MONTHS_FETCHED) {
        totals.complete = month >= today.slice(0, 7);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
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
    // O preenchimento do banco tem trava propria: roda mesmo se a verificacao foi pulada.
    const history = await backfill()
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
      .then(async (value) => {
        if (!(value && typeof value === "object" && "ownsLock" in value)) {
          await redis([["DEL", "solee:backfill:lock"]]).catch(() => undefined);
        }
        return value;
      });
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
