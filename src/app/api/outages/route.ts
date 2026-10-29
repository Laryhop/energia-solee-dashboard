import { NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import { getHistoricalOutages, updateHistoricalOutage } from "@/lib/historical-outages";
import { getOutageHistory, updateOutage } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/outages?year=2026 -> paradas do ano, paradas em andamento e status do monitoramento. */
export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const year = params.get("year") ?? "";
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "Ano invalido." }, { status: 400 });
  }
  const inverterCount = Math.min(50, Math.max(1, Number(params.get("inverters")) || 1));

  try {
    const live = await getOutageHistory(year);

    // Dias cobertos pelo monitoramento ao vivo (a maior parte do dia) nao sao reconstruidos.
    const monitoredDays = new Set(
      Object.entries(live.checksByDay)
        .filter(([, count]) => count >= 30)
        .map(([day]) => day),
    );
    let historical: Awaited<ReturnType<typeof getHistoricalOutages>>;
    try {
      historical = await getHistoricalOutages(year, monitoredDays, inverterCount);
    } catch (error) {
      historical = {
        outages: [],
        analyzedDays: [],
        method: null,
        error: `Nao foi possivel reconstruir as paradas antigas: ${error instanceof Error ? error.message : "erro"}`,
      };
    }

    return NextResponse.json(
      {
        ...live,
        historical: historical.outages,
        analyzedDays: historical.analyzedDays,
        historicalMethod: historical.method,
        historicalError: historical.error,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: "Falha ao ler o historico de paradas.", detail: error instanceof Error ? error.message : "" },
      { status: 502 },
    );
  }
}

/** PATCH /api/outages { id, note?, ignored? } -> observacao ou ignorar uma parada. */
export async function PATCH(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as { id?: unknown; note?: unknown; ignored?: unknown };
    if (typeof body.id !== "string") throw new Error("Informe o id da parada.");
    const changes = {
      note: typeof body.note === "string" ? body.note : undefined,
      ignored: typeof body.ignored === "boolean" ? body.ignored : undefined,
    };
    const outage = body.id.startsWith("hist-")
      ? await updateHistoricalOutage(body.id, changes)
      : await updateOutage(body.id, changes);
    return NextResponse.json(outage);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar." },
      { status: 400 },
    );
  }
}
