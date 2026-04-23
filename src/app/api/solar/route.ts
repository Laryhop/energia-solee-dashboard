import { NextResponse } from "next/server";

import {
  SolarDashboardConfigError,
  SolarDashboardUpstreamError,
  getSolarDashboardData,
} from "@/lib/solar-dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const data = await getSolarDashboardData();

    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "private, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    if (error instanceof SolarDashboardConfigError) {
      return NextResponse.json(
        {
          error: "Configuracao invalida do dashboard.",
          detail: error.message,
        },
        { status: 500 },
      );
    }

    if (error instanceof SolarDashboardUpstreamError) {
      return NextResponse.json(
        {
          error: "Falha ao consultar o SEMS Portal.",
          detail: error.message,
        },
        { status: 502 },
      );
    }

    return NextResponse.json(
      {
        error: "Erro inesperado ao buscar dados da usina.",
      },
      { status: 500 },
    );
  }
}
