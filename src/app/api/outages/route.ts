import { NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import { getOutageHistory, updateOutage } from "@/lib/monitor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/outages?year=2026 -> paradas do ano, paradas em andamento e status do monitoramento. */
export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const year = new URL(request.url).searchParams.get("year") ?? "";
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "Ano invalido." }, { status: 400 });
  }

  try {
    return NextResponse.json(await getOutageHistory(year), { headers: { "Cache-Control": "no-store" } });
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
    const outage = await updateOutage(body.id, {
      note: typeof body.note === "string" ? body.note : undefined,
      ignored: typeof body.ignored === "boolean" ? body.ignored : undefined,
    });
    return NextResponse.json(outage);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao salvar." },
      { status: 400 },
    );
  }
}
