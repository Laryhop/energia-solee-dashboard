import { NextResponse } from "next/server";

import { isAuthenticated } from "@/lib/auth";
import {
  SolarDashboardConfigError,
  getSolarHistoryData,
} from "@/lib/solar-dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = { day: 400, month: 366 * 6 };

/**
 * GET /api/solar/history?dimension=day&start=2026-09-01&end=2026-09-30
 * GET /api/solar/history?dimension=month&start=2026-01-01&end=2026-10-31
 */
export async function GET(request: Request) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const dimension = params.get("dimension") === "month" ? "month" : "day";
  const start = params.get("start") ?? "";
  const end = params.get("end") ?? "";

  if (!DATE_RE.test(start) || !DATE_RE.test(end) || start > end) {
    return NextResponse.json(
      { error: "Periodo invalido.", detail: "Use start e end no formato AAAA-MM-DD, com start <= end." },
      { status: 400 },
    );
  }

  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  if (days > MAX_DAYS[dimension]) {
    return NextResponse.json(
      { error: "Periodo muito longo.", detail: `Limite de ${MAX_DAYS[dimension]} dias para esta consulta.` },
      { status: 400 },
    );
  }

  try {
    const data = await getSolarHistoryData(dimension, start, end);
    return NextResponse.json(data, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Erro desconhecido.";
    return NextResponse.json(
      {
        error:
          error instanceof SolarDashboardConfigError
            ? "Configuracao invalida do dashboard."
            : "Falha ao consultar o historico no SEMS+.",
        detail,
      },
      { status: error instanceof SolarDashboardConfigError ? 500 : 502 },
    );
  }
}
