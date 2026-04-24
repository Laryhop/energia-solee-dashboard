import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  SolarDashboardConfigError,
  SolarDashboardUpstreamError,
  getSolarDashboardData,
} from "@/lib/solar-dashboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  if (cookieStore.get("solee_auth")?.value !== "1") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
