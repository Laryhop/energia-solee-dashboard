import { cookies } from "next/headers";
import { NextResponse } from "next/server";

type ForecastResponse = {
  current?: {
    temperature_2m: number;
    wind_speed_10m: number;
    weather_code: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    weather_code: number[];
  };
};

const MARAVILHA_AL = {
  latitude: -9.22305,
  longitude: -37.37936,
  label: "Maravilha, AL",
};

const WEATHER_LABELS: Record<number, string> = {
  0: "Ceu limpo",
  1: "Predominantemente limpo",
  2: "Parcialmente nublado",
  3: "Nublado",
  45: "Neblina",
  48: "Neblina com geada",
  51: "Garoa fraca",
  53: "Garoa moderada",
  55: "Garoa intensa",
  61: "Chuva fraca",
  63: "Chuva moderada",
  65: "Chuva intensa",
  71: "Neve fraca",
  80: "Pancadas fracas",
  81: "Pancadas moderadas",
  82: "Pancadas intensas",
  95: "Trovoadas",
};

function getWeatherLabel(code: number) {
  return WEATHER_LABELS[code] || "Condicao variavel";
}

function formatLabel(date: string, index: number) {
  if (index === 0) return "Hoje";
  if (index === 1) return "Amanha";

  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
  }).format(new Date(date));
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const cookieStore = await cookies();
  if (cookieStore.get("solee_auth")?.value !== "1") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const forecastResponse = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${MARAVILHA_AL.latitude}&longitude=${MARAVILHA_AL.longitude}&current=temperature_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=3&timezone=America%2FMaceio`,
      { next: { revalidate: 3600 } },
    );

    if (!forecastResponse.ok) {
      throw new Error("Falha ao consultar previsao.");
    }

    const forecast = (await forecastResponse.json()) as ForecastResponse;
    const currentRainChance = forecast.daily?.precipitation_probability_max?.[0] ?? 0;

    return NextResponse.json(
      {
        location: MARAVILHA_AL.label,
        current: {
          temperatureC: forecast.current?.temperature_2m ?? 0,
          windKph: forecast.current?.wind_speed_10m ?? 0,
          precipitationProbabilityPct: currentRainChance,
          weatherLabel: getWeatherLabel(forecast.current?.weather_code ?? 0),
        },
        daily:
          forecast.daily?.time.map((date, index) => ({
            date,
            label: formatLabel(date, index),
            tempMaxC: forecast.daily?.temperature_2m_max[index] ?? 0,
            tempMinC: forecast.daily?.temperature_2m_min[index] ?? 0,
            precipitationProbabilityMaxPct:
              forecast.daily?.precipitation_probability_max[index] ?? 0,
            weatherLabel: getWeatherLabel(forecast.daily?.weather_code[index] ?? 0),
          })) ?? [],
        updatedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Falha ao buscar previsao do tempo.",
        detail: error instanceof Error ? error.message : "Erro desconhecido.",
      },
      { status: 500 },
    );
  }
}
