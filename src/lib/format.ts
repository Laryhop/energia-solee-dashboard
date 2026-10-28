// Formatadores e utilitarios de data usados no cliente.
// As datas sao strings "AAAA-MM-DD" no fuso da usina (America/Maceio).

export const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
export const nf0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
export const cf = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const cp = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
export const pf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1, signDisplay: "exceptZero" });

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const MONTHS_LONG = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-10" + n meses */
export function addMonths(month: string, months: number) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 7);
}

export function daysInMonth(month: string) {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthEnd(month: string) {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function monthLabel(month: string, long = false) {
  const [y, m] = month.split("-").map(Number);
  return long ? capitalize(`${MONTHS_LONG[m - 1]} de ${y}`) : `${MONTHS[m - 1]}/${String(y).slice(2)}`;
}

export function dayLabel(date: string) {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

export function dayLongLabel(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  const [y, m, day] = date.split("-").map(Number);
  return capitalize(`${WEEKDAYS[d.getUTCDay()]}, ${day} de ${MONTHS_LONG[m - 1]} de ${y}`);
}

/** Variacao percentual; null quando nao ha base de comparacao. */
export function variation(current: number, previous: number) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

export function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Hora atual no fuso da usina. */
export function stationHour() {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Maceio", hour: "2-digit", hourCycle: "h23" }).format(new Date()),
  );
}

/** Baixa um CSV que abre direto no Excel em portugues (separador ";" e virgula decimal). */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number>>) {
  const format = (value: string | number) =>
    typeof value === "number" ? value.toFixed(2).replace(".", ",") : `"${value.replace(/"/g, '""')}"`;
  const content = [header.map(format), ...rows.map((row) => row.map(format))].map((row) => row.join(";")).join("\r\n");
  const blob = new Blob([`﻿${content}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
