"use client";

import {
  addDays,
  cf,
  dayLabel,
  daysInMonth,
  median,
  monthLabel,
  nf,
  stationHour,
} from "@/lib/format";

type Point = { date: string; generationKwh: number };
type Inverter = { id: string; name: string; status: string; powerKw?: number };

type Props = {
  today: string;
  todayKwh: number;
  monthKwh: number;
  tariff: number;
  targetDailyKwh: number;
  dailyHistory: Point[];
  monthlyHistory: Point[];
  inverters: Inverter[];
  plantStatus: string;
  errorLog?: string;
  tomorrow?: { label: string; weatherLabel: string; precipitationProbabilityMaxPct: number } | null;
};

type Alert = { level: "danger" | "warning" | "info" | "ok"; title: string; detail: string };

const LEVEL_STYLE: Record<Alert["level"], string> = {
  danger: "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800/60 dark:bg-rose-900/20 dark:text-rose-200",
  warning: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-200",
  info: "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800/60 dark:bg-sky-900/20 dark:text-sky-200",
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-900/20 dark:text-emerald-200",
};
const LEVEL_ICON: Record<Alert["level"], string> = { danger: "⛔", warning: "⚠️", info: "ℹ️", ok: "✅" };

function buildAlerts(props: Props, recent: Array<{ date: string; value: number | null }>): Alert[] {
  const alerts: Alert[] = [];
  const hour = stationHour();
  const daylight = hour >= 7 && hour < 17;

  // 1. Inversores parados durante o dia
  // Parado = offline/falha, ou sem potencia nenhuma em horario de sol.
  // Um codigo de status desconhecido com potencia > 0 nao e tratado como problema.
  const stopped = props.inverters.filter(
    (inv) => inv.status === "Offline" || inv.status === "Falha" || !((inv.powerKw ?? 0) > 0),
  );
  if (daylight && stopped.length) {
    alerts.push({
      level: "danger",
      title: `${stopped.length} inversor${stopped.length > 1 ? "es" : ""} sem gerar agora`,
      detail: `${stopped.map((inv) => `${inv.name} (${inv.status}, ${nf.format(inv.powerKw ?? 0)} kW)`).join(", ")}. Em horário de sol, confira disjuntores, alarmes no SEMS+ e a conexão do inversor.`,
    });
  } else if (daylight && props.plantStatus === "Offline") {
    alerts.push({
      level: "danger",
      title: "Usina offline no SEMS+",
      detail: "O portal não está recebendo dados agora. Pode ser queda de internet no local ou desligamento.",
    });
  }

  // 2. Dias sem registro (falha de comunicacao)
  const missing = recent.filter((day) => day.value === null);
  if (missing.length) {
    alerts.push({
      level: "warning",
      title: `${missing.length} dia${missing.length > 1 ? "s" : ""} sem registro nos últimos 30`,
      detail: `${missing.slice(-6).map((day) => dayLabel(day.date)).join(", ")}${missing.length > 6 ? "…" : ""}. Sem dados, a geração pode estar subestimada; verifique a internet do inversor.`,
    });
  }

  // 3. Dias com geracao muito abaixo do normal
  const values = recent.filter((day) => day.value !== null).map((day) => day.value as number);
  const typical = median(values);
  const veryLow = recent.filter((day) => day.value !== null && typical > 0 && (day.value as number) < typical * 0.5);
  if (veryLow.length) {
    alerts.push({
      level: veryLow.length >= 4 ? "warning" : "info",
      title: `${veryLow.length} dia${veryLow.length > 1 ? "s" : ""} com menos da metade do normal`,
      detail: `${veryLow.slice(-6).map((day) => `${dayLabel(day.date)} (${nf.format(day.value as number)} kWh)`).join(", ")}. Dia típico: ${nf.format(typical)} kWh. Se não choveu nesses dias, investigue desligamentos.`,
    });
  }

  // 4. Tendencia: ultimas 2 semanas vs. 2 semanas anteriores
  const lastTwoWeeks = recent.slice(-14).filter((day) => day.value !== null).map((day) => day.value as number);
  const previousTwoWeeks = recent.slice(-28, -14).filter((day) => day.value !== null).map((day) => day.value as number);
  if (lastTwoWeeks.length >= 7 && previousTwoWeeks.length >= 7) {
    const avg = (list: number[]) => list.reduce((sum, value) => sum + value, 0) / list.length;
    const change = ((avg(lastTwoWeeks) - avg(previousTwoWeeks)) / avg(previousTwoWeeks)) * 100;
    if (change <= -15) {
      alerts.push({
        level: "warning",
        title: `Geração caiu ${nf.format(Math.abs(change))}% nas últimas 2 semanas`,
        detail: "Comparado às 2 semanas anteriores. Se o tempo esteve parecido, pode ser sujeira nos painéis, sombreamento ou um inversor rendendo menos — vale agendar uma limpeza/inspeção.",
      });
    }
  }

  // 5. Comunicacao parcial com o SEMS+
  if (props.errorLog) {
    alerts.push({
      level: "info",
      title: "Parte dos dados não veio do SEMS+",
      detail: props.errorLog,
    });
  }

  // 6. Previsao para amanha
  if (props.tomorrow && props.tomorrow.precipitationProbabilityMaxPct >= 60) {
    alerts.push({
      level: "info",
      title: `Amanhã: ${props.tomorrow.weatherLabel.toLowerCase()} (${props.tomorrow.precipitationProbabilityMaxPct}% de chuva)`,
      detail: "Espere geração abaixo da média. Bom dia para lavagem natural dos painéis; evite agendar manutenção externa.",
    });
  }

  if (!alerts.length) {
    alerts.push({
      level: "ok",
      title: "Tudo funcionando normalmente",
      detail: "Inversores gerando, sem falhas de comunicação e geração dentro do esperado nos últimos 30 dias.",
    });
  }
  return alerts;
}

export function PlantHealth(props: Props) {
  const { today, todayKwh, monthKwh, tariff, targetDailyKwh, dailyHistory, monthlyHistory } = props;

  // Ultimos 30 dias fechados (sem hoje); null = sem registro.
  const byDate = new Map(dailyHistory.map((point) => [point.date.slice(0, 10), point.generationKwh]));
  const recent = Array.from({ length: 30 }, (_, index) => {
    const date = addDays(today, index - 30);
    return { date, value: byDate.has(date) ? (byDate.get(date) as number) : null };
  });
  const alerts = buildAlerts(props, recent);

  // Meta mensal
  const month = today.slice(0, 7);
  const totalDays = daysInMonth(month);
  const dayOfMonth = Number(today.slice(8, 10));
  const remaining = totalDays - dayOfMonth;
  const monthTarget = targetDailyKwh * totalDays;
  const closedValues = recent.filter((day) => day.value !== null).map((day) => day.value as number);
  const average = closedValues.length ? closedValues.reduce((sum, value) => sum + value, 0) / closedValues.length : 0;
  const projection = monthKwh + average * remaining;
  const progress = monthTarget ? Math.min(100, (monthKwh / monthTarget) * 100) : 0;
  const projectionPct = monthTarget ? Math.min(100, (projection / monthTarget) * 100) : 0;
  const neededPerDay = remaining > 0 ? Math.max(0, (monthTarget - monthKwh) / remaining) : 0;
  const expectedSoFar = targetDailyKwh * (dayOfMonth - 1) + Math.min(todayKwh, targetDailyKwh);
  const onTrack = monthKwh >= expectedSoFar * 0.97;

  // Ano corrente
  const year = today.slice(0, 4);
  const yearKwh = monthlyHistory
    .filter((point) => point.date.startsWith(year))
    .reduce((sum, point) => sum + point.generationKwh, 0);
  // Mesmo periodo do ano passado: meses fechados + fracao proporcional do mes atual.
  const lastYearMonth = (key: string) =>
    monthlyHistory.find((point) => point.date.startsWith(key))?.generationKwh ?? 0;
  const previousYear = String(Number(year) - 1);
  let lastYearSamePeriod = 0;
  for (let m = 1; m < Number(month.slice(5, 7)); m += 1) {
    lastYearSamePeriod += lastYearMonth(`${previousYear}-${String(m).padStart(2, "0")}`);
  }
  lastYearSamePeriod += lastYearMonth(`${previousYear}-${month.slice(5, 7)}`) * (dayOfMonth / totalDays);
  const lastYearComplete = Array.from({ length: Number(month.slice(5, 7)) }, (_, i) =>
    lastYearMonth(`${previousYear}-${String(i + 1).padStart(2, "0")}`),
  ).every((value) => value > 0);

  return (
    <div className="grid gap-8 lg:grid-cols-5">
      <section className="rounded-[2.5rem] border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-900/30 dark:bg-[#0f1d15] sm:p-8 lg:col-span-3">
        <h2 className="mb-1 text-xl font-black text-[#052e16] dark:text-white">Alertas e saúde da usina</h2>
        <p className="mb-5 text-xs font-bold text-slate-500 dark:text-emerald-400/50">
          Análise automática dos inversores e dos últimos 30 dias de geração.
        </p>
        <ul className="space-y-3">
          {alerts.map((alert) => (
            <li key={alert.title} className={`rounded-2xl border p-4 ${LEVEL_STYLE[alert.level]}`}>
              <p className="text-sm font-black">
                <span aria-hidden className="mr-2">{LEVEL_ICON[alert.level]}</span>
                {alert.title}
              </p>
              <p className="mt-1 break-words text-xs font-semibold opacity-80">{alert.detail}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-[2.5rem] border border-slate-200 bg-white p-5 shadow-sm dark:border-emerald-900/30 dark:bg-[#0f1d15] sm:p-8 lg:col-span-2">
        <h2 className="mb-1 text-xl font-black text-[#052e16] dark:text-white">Meta de {monthLabel(month, true).toLowerCase()}</h2>
        <p className="mb-5 text-xs font-bold text-slate-500 dark:text-emerald-400/50">
          {nf.format(monthTarget)} kWh no mês ({nf.format(targetDailyKwh)} kWh/dia)
        </p>

        <div className="relative mb-2 h-5 overflow-hidden rounded-full bg-slate-100 dark:bg-white/5">
          <div className="absolute inset-y-0 left-0 rounded-full bg-amber-200/70 dark:bg-amber-500/20" style={{ width: `${projectionPct}%` }} />
          <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-500 to-amber-400" style={{ width: `${progress}%` }} />
        </div>
        <div className="mb-6 flex justify-between text-[11px] font-black text-slate-500 dark:text-emerald-300/60">
          <span>{nf.format((monthKwh / (monthTarget || 1)) * 100)}% gerado</span>
          <span>projeção {nf.format((projection / (monthTarget || 1)) * 100)}%</span>
        </div>

        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="font-bold text-slate-500 dark:text-emerald-300/60">Gerado no mês</dt>
            <dd className="font-black dark:text-white">{nf.format(monthKwh)} kWh</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="font-bold text-slate-500 dark:text-emerald-300/60">Projeção (média 30 dias)</dt>
            <dd className="font-black dark:text-white">{nf.format(projection)} kWh</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="font-bold text-slate-500 dark:text-emerald-300/60">Necessário por dia</dt>
            <dd className={`font-black ${neededPerDay > average * 1.1 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}`}>
              {remaining > 0 ? `${nf.format(neededPerDay)} kWh` : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="font-bold text-slate-500 dark:text-emerald-300/60">Ritmo</dt>
            <dd className={`font-black ${onTrack ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
              {onTrack ? "Dentro da meta" : "Abaixo da meta"}
            </dd>
          </div>
          <div className="border-t border-slate-100 pt-3 dark:border-emerald-900/30" />
          <div className="flex justify-between gap-4">
            <dt className="font-bold text-slate-500 dark:text-emerald-300/60">Acumulado em {year}</dt>
            <dd className="text-right font-black dark:text-white">
              {nf.format(yearKwh)} kWh
              <span className="block text-xs text-emerald-600 dark:text-emerald-400">{cf.format(yearKwh * tariff)}</span>
            </dd>
          </div>
          {lastYearSamePeriod > 0 && (
            <div className="flex justify-between gap-4">
              <dt className="font-bold text-slate-500 dark:text-emerald-300/60">
                Mesmo período de {previousYear}
                {!lastYearComplete && <span className="block text-[10px]">dados incompletos naquele ano</span>}
              </dt>
              <dd className="text-right font-black dark:text-white">
                {nf.format(lastYearSamePeriod)} kWh
                {lastYearComplete && (
                  <span className={`block text-xs ${yearKwh >= lastYearSamePeriod ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                    {yearKwh >= lastYearSamePeriod ? "▲" : "▼"} {nf.format(Math.abs(((yearKwh - lastYearSamePeriod) / lastYearSamePeriod) * 100))}% em {year}
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
