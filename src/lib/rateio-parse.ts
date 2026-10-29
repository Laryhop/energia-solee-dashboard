/*
 * Leitura da planilha de rateio da Equatorial (.xlsx) no navegador.
 *
 * O modelo da distribuidora tem formulas preenchidas em ~1 milhao de linhas
 * (planilha de ~80 MB descompactada). Para nao travar o navegador, o arquivo e
 * lido em partes e a leitura da aba para logo depois da ultima UC preenchida.
 */

import { Unzip, UnzipInflate } from "fflate";

export type ParsedRateioEntry = {
  uc: string;
  doc: string;
  /** Fracao do excedente (0,0054 = 0,54%); null na modalidade "Ordem de Prioridade". */
  pct: number | null;
  order: number;
};

/** Uma lista de rateio encontrada numa aba da planilha. */
export type ParsedRateioList = {
  sheet: string;
  ugUc: string | null;
  requestDate: string | null;
  enquadramento: string | null;
  forma: string | null;
  entries: ParsedRateioEntry[];
  totalPct: number;
  warnings: string[];
};

export type ParsedRateio = {
  /** Todas as listas encontradas (a primeira e a sugerida). */
  lists: ParsedRateioList[];
  /** Aba da lista sugerida. */
  sheet: string;
  /** Nome do cliente por UC (chave = so os digitos da UC), lido de qualquer aba da planilha. */
  names: Record<string, string>;
  /** Abas de onde os nomes foram lidos. */
  namesFrom: string[];
  ugUc: string | null;
  requestDate: string | null;
  enquadramento: string | null;
  forma: string | null;
  entries: ParsedRateioEntry[];
  totalPct: number;
  warnings: string[];
};

type RawCell = { sheet: string; col: string; row: number; type: string; value: string };

const MAX_ROWS = 20_000;
/** Para de ler uma aba depois de tantas linhas seguidas sem nenhum valor. */
const EMPTY_ROWS_TO_STOP = 200;
const MAX_SHEETS = 15;

function decodeXml(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml: string) {
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const parts = [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    strings.push(parts.join(""));
  }
  return strings;
}

function parseCells(rowXml: string, rowNumber: number, sheet: string): RawCell[] {
  const cells: RawCell[] = [];
  for (const match of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, attrs, inner = ""] = match;
    const type = /\st="([^"]+)"/.exec(attrs)?.[1] ?? "n";
    let value = "";
    if (type === "inlineStr") {
      value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
    } else {
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
      value = v ? decodeXml(v[1]) : "";
    }
    if (value !== "") cells.push({ sheet, col, row: rowNumber, type, value });
  }
  return cells;
}

const colIndex = (col: string) => [...col].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0);
const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function excelDate(value: string) {
  const serial = Number(value);
  if (Number.isFinite(serial) && serial > 20_000 && serial < 80_000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
  }
  const br = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return iso ? iso[0] : null;
}

/** Le o arquivo .xlsx e devolve a lista de rateio. */
export async function parseRateioXlsx(file: Blob): Promise<ParsedRateio> {
  const cells: RawCell[] = [];
  let sharedStringsXml = "";
  let workbookXml = "";
  let relsXml = "";
  let sheetCount = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  await new Promise<void>((resolve, reject) => {
    unzip.onfile = (entry) => {
      const name = entry.name;
      const isSheet = /^xl\/worksheets\/sheet\d+\.xml$/.test(name) && sheetCount < MAX_SHEETS;
      const target =
        name === "xl/sharedStrings.xml"
          ? "shared"
          : name === "xl/workbook.xml"
            ? "workbook"
            : name === "xl/_rels/workbook.xml.rels"
              ? "rels"
              : null;
      if (!isSheet && !target) return;
      if (isSheet) sheetCount += 1;

      const decoder = new TextDecoder();
      // Estado da leitura desta aba
      const sheetFile = name.replace(/^xl\//, "");
      let pending = "";
      let lastFilledRow = 0;
      let done = false;

      entry.ondata = (error, chunk, final) => {
        if (error) {
          reject(error);
          return;
        }
        const text = decoder.decode(chunk, { stream: !final });
        if (target === "shared") sharedStringsXml += text;
        if (target === "workbook") workbookXml += text;
        if (target === "rels") relsXml += text;
        if (!isSheet || done) return;

        pending += text;
        let close: number;
        while ((close = pending.indexOf("</row>")) !== -1) {
          const rowXml = pending.slice(0, close + 6);
          pending = pending.slice(close + 6);
          const rowMatch = /<row[^>]*\sr="(\d+)"/.exec(rowXml);
          if (!rowMatch) continue;
          const rowNumber = Number(rowMatch[1]);
          const rowCells = parseCells(rowXml, rowNumber, sheetFile);
          if (rowCells.length) {
            cells.push(...rowCells);
            lastFilledRow = rowNumber;
          }
          if (rowNumber > MAX_ROWS || (lastFilledRow > 0 && rowNumber - lastFilledRow > EMPTY_ROWS_TO_STOP)) {
            done = true;
            break;
          }
        }
        if (done) {
          pending = "";
          try {
            entry.terminate();
          } catch {
            // ja terminado
          }
        }
      };
      entry.start();
    };

    // Le o arquivo em partes e entrega ao descompactador.
    const reader = file.stream().getReader();
    const pump = (): Promise<void> =>
      reader.read().then(({ done, value }) => {
        if (done) {
          unzip.push(new Uint8Array(0), true);
          resolve();
          return;
        }
        unzip.push(value);
        return pump();
      });
    pump().catch(reject);
  });

  if (!sheetCount) throw new Error("Não encontrei nenhuma aba na planilha.");

  // Nome de cada aba (worksheets/sheetN.xml -> "Lista de Rateio"); a ordem dos atributos varia.
  const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? "";
  const relTargets = new Map(
    [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((match) => [
      attr(match[0], "Id"),
      attr(match[0], "Target").replace(/^\/?xl\//, ""),
    ]),
  );
  const sheetNames = new Map<string, string>();
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*>/g)) {
    const target = relTargets.get(attr(match[0], "r:id"));
    if (target) sheetNames.set(target, decodeXml(attr(match[0], "name")));
  }
  const sheetLabel = (sheet: string) => sheetNames.get(sheet) ?? sheet;

  // Resolve textos compartilhados
  const shared = parseSharedStrings(sharedStringsXml);
  const resolved = cells.map((cell) => ({
    ...cell,
    text: cell.type === "s" ? shared[Number(cell.value)] ?? "" : cell.value,
  }));
  type Resolved = (typeof resolved)[number];
  const sheets = new Map<string, Map<number, Resolved[]>>();
  for (const cell of resolved) {
    if (!sheets.has(cell.sheet)) sheets.set(cell.sheet, new Map());
    const rows = sheets.get(cell.sheet)!;
    if (!rows.has(cell.row)) rows.set(cell.row, []);
    rows.get(cell.row)!.push(cell);
  }
  for (const rows of sheets.values()) for (const list of rows.values()) list.sort((a, b) => colIndex(a.col) - colIndex(b.col));

  const NAME_HEADER = /^(nome|cliente|nome do cliente|nome cliente|titular|nome do titular|razao social|beneficiario|consumidor)\b/;
  const UC_HEADER = /^(uc|u\.c\.?|unidade consumidora|unid\.? consumidora|conta contrato|instalacao|codigo da uc|numero da uc|n. ?(da )?uc)\b/;
  const PCT_HEADER = /%|percentual|excedente|rateio/;
  const isUcHeader = (text: string) => UC_HEADER.test(normalize(text)) && !/geradora/.test(normalize(text));
  const sortedRows = (rows: Map<number, Resolved[]>) => [...rows.entries()].sort((a, b) => a[0] - b[0]);

  // ---------- uma lista candidata por aba (aba com coluna de UC e de %) ----------
  type Candidate = {
    sheet: string;
    label: string;
    entries: ParsedRateioEntry[];
    totalPct: number;
    duplicates: string[];
    meta: { ugUc: string | null; requestDate: string | null; enquadramento: string | null; forma: string | null };
  };

  const candidates: Candidate[] = [];
  for (const [sheet, rows] of sheets) {
    let header: { row: number; uc: string; doc: string | null; pct: string; order: string | null } | null = null;
    for (const [row, list] of sortedRows(rows)) {
      const textCells = list.filter((cell) => cell.type !== "n");
      const ucCell = textCells.find((cell) => isUcHeader(cell.text));
      const pctCell = textCells.find((cell) => cell !== ucCell && PCT_HEADER.test(normalize(cell.text)) && normalize(cell.text).length < 40);
      if (!ucCell || !pctCell) continue;
      const doc = textCells.find((cell) => /cpf|cnpj/.test(normalize(cell.text)));
      const order = textCells.find((cell) => /^(ordem|item|n[ºo°.]?)$/.test(normalize(cell.text)));
      header = { row, uc: ucCell.col, doc: doc?.col ?? null, pct: pctCell.col, order: order?.col ?? null };
      break;
    }
    if (!header) continue;

    const raw: Array<{ uc: string; doc: string; pct: number | null; order: number }> = [];
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const [row, list] of sortedRows(rows)) {
      if (row <= header.row) continue;
      const get = (col: string | null) => (col ? list.find((cell) => cell.col === col)?.text.trim() ?? "" : "");
      const uc = get(header.uc).replace(/\s+/g, "");
      const digits = uc.replace(/\D/g, "");
      if (digits.length < 5 || /#ref|#n\/a|#valor/i.test(uc)) continue; // linhas vazias, "0", totais e erros
      if (seen.has(digits)) {
        duplicates.push(uc);
        continue;
      }
      seen.add(digits);
      const rawPct = get(header.pct).replace(",", ".").replace("%", "").trim();
      const pct = rawPct === "" || !Number.isFinite(Number(rawPct)) ? null : Number(rawPct);
      raw.push({ uc, doc: get(header.doc), pct, order: Number(get(header.order)) || raw.length + 1 });
    }
    if (!raw.length) continue;

    // Unidade do %: fracao (0,0054) ou pontos percentuais (0,54). Decide pela coluna inteira.
    const sum = raw.reduce((total, item) => total + (item.pct ?? 0), 0);
    const factor = sum > 1.5 ? 0.01 : 1;
    const entries = raw.map((item) => ({ ...item, pct: item.pct === null ? null : Number((item.pct * factor).toFixed(8)) }));

    /** Valor da primeira celula preenchida a direita do rotulo, nesta aba. */
    const valueAfter = (label: RegExp) => {
      for (const list of rows.values()) {
        const index = list.findIndex((cell) => label.test(normalize(cell.text)));
        if (index >= 0) {
          const next = list.slice(index + 1).find((cell) => cell.text.trim() && colIndex(cell.col) <= 20);
          if (next) return next;
        }
      }
      return null;
    };
    const dateCell = valueAfter(/^data (da )?solicitacao/);
    candidates.push({
      sheet,
      label: sheetLabel(sheet),
      entries,
      totalPct: entries.reduce((total, item) => total + (item.pct ?? 0), 0),
      duplicates,
      meta: {
        ugUc: valueAfter(/^(unidade consumidora|conta contrato) da (uc |unidade )?(unidade )?geradora/)?.text.trim() ?? null,
        requestDate: dateCell ? excelDate(dateCell.text) : null,
        enquadramento: valueAfter(/^enquadramento/)?.text.trim() ?? null,
        forma: valueAfter(/^forma de alocacao/)?.text.trim() ?? null,
      },
    });
  }
  if (!candidates.length) {
    throw new Error("Não encontrei nenhuma aba com as colunas de UC (ou Conta Contrato) e percentual.");
  }

  // Sugestao: a lista cuja soma fica mais perto de 100% (empate: mais UCs, depois a que tem CPF/CNPJ).
  const score = (candidate: Candidate) =>
    Math.abs(candidate.totalPct - 1) * 1000 - candidate.entries.length * 0.01 - (candidate.entries.some((entry) => entry.doc) ? 0.001 : 0);
  candidates.sort((a, b) => score(a) - score(b));

  // CPF/CNPJ que faltar numa lista vem de outra aba da mesma planilha.
  const docs = new Map<string, string>();
  for (const candidate of candidates) {
    for (const entry of candidate.entries) {
      const digits = entry.uc.replace(/\D/g, "");
      if (entry.doc && !docs.has(digits)) docs.set(digits, entry.doc);
    }
  }
  for (const candidate of candidates) {
    candidate.entries = candidate.entries.map((entry) => ({ ...entry, doc: entry.doc || docs.get(entry.uc.replace(/\D/g, "")) || "" }));
  }
  // Dados da solicitacao: da propria lista ou de outra aba com as mesmas UCs.
  for (const candidate of candidates) {
    const keys = new Set(candidate.entries.map((entry) => entry.uc.replace(/\D/g, "")));
    const donor = candidates
      .filter((other) => other.meta.requestDate || other.meta.ugUc)
      .sort(
        (a, b) =>
          b.entries.filter((entry) => keys.has(entry.uc.replace(/\D/g, ""))).length -
          a.entries.filter((entry) => keys.has(entry.uc.replace(/\D/g, ""))).length,
      )[0];
    if (donor && donor !== candidate) {
      candidate.meta = {
        ugUc: candidate.meta.ugUc ?? donor.meta.ugUc,
        requestDate: candidate.meta.requestDate ?? donor.meta.requestDate,
        enquadramento: candidate.meta.enquadramento ?? donor.meta.enquadramento,
        forma: candidate.meta.forma ?? donor.meta.forma,
      };
    }
  }

  // ---------- nomes dos clientes: qualquer aba com coluna de nome/cliente e de UC ----------
  const ucKeys = [...new Set(candidates.flatMap((candidate) => candidate.entries.map((entry) => entry.uc.replace(/\D/g, ""))))];
  const names: Record<string, string> = {};
  const namesFrom = new Set<string>();
  for (const [sheet, rows] of sheets) {
    let nameCol: string | null = null;
    let ucCol: string | null = null;
    for (const [, list] of sortedRows(rows)) {
      const textCells = list.filter((cell) => cell.type !== "n");
      const nameHeader = textCells.find((cell) => NAME_HEADER.test(normalize(cell.text)));
      const ucHeader = textCells.find((cell) => isUcHeader(cell.text));
      if (nameHeader && ucHeader) {
        nameCol = nameHeader.col;
        ucCol = ucHeader.col;
        continue;
      }
      if (!nameCol || !ucCol) continue;
      const ucDigits = (list.find((cell) => cell.col === ucCol)?.text ?? "").replace(/\D/g, "");
      const nameText = (list.find((cell) => cell.col === nameCol)?.text ?? "").replace(/\s+/g, " ").trim();
      if (!ucDigits || !nameText || /^\d[\d.\-/ ]*$/.test(nameText)) continue;
      // Aceita a UC com ou sem pontuacao e com zeros a esquerda.
      const match = ucKeys.find((key) => key === ucDigits || key.replace(/^0+/, "") === ucDigits.replace(/^0+/, ""));
      if (match && !names[match]) {
        names[match] = nameText.slice(0, 80);
        namesFrom.add(sheetLabel(sheet));
      }
    }
  }

  const lists: ParsedRateioList[] = candidates.map((candidate) => ({
    sheet: candidate.label,
    entries: candidate.entries,
    totalPct: candidate.totalPct,
    ...candidate.meta,
    warnings: listWarnings(candidate, candidates, names),
  }));
  const chosen = lists[0];
  return { names, namesFrom: [...namesFrom], lists, ...chosen };
}

/** Avisos de uma lista: soma, % vazio, UCs repetidas e diferencas com outras abas da planilha. */
function listWarnings(
  candidate: { label: string; entries: ParsedRateioEntry[]; totalPct: number; duplicates: string[]; meta: { forma: string | null; ugUc: string | null } },
  all: Array<{ label: string; entries: ParsedRateioEntry[]; meta: { ugUc: string | null } }>,
  names: Record<string, string>,
) {
  const warnings: string[] = [];
  const pct = (value: number) => `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 3 })}%`;
  const isPercent = !candidate.meta.forma || /percentual/i.test(candidate.meta.forma);
  if (isPercent && candidate.entries.some((entry) => entry.pct === null)) warnings.push("Há UCs sem percentual preenchido.");
  if (isPercent && Math.abs(candidate.totalPct - 1) > 0.001) {
    warnings.push(`A soma dos percentuais desta lista é ${pct(candidate.totalPct)} (o esperado é 100%).`);
  }
  for (const uc of candidate.duplicates) warnings.push(`A UC ${uc} aparece mais de uma vez; mantive a primeira.`);

  const mine = new Map(candidate.entries.map((entry) => [entry.uc.replace(/\D/g, ""), entry]));
  for (const other of all) {
    if (other.label === candidate.label) continue;
    // Lista de outra usina (UC geradora diferente): nao compara.
    const ugA = candidate.meta.ugUc?.replace(/\D/g, "");
    const ugB = other.meta.ugUc?.replace(/\D/g, "");
    if (ugA && ugB && ugA !== ugB) continue;
    const shared = other.entries.filter((entry) => mine.has(entry.uc.replace(/\D/g, "")));
    if (shared.length < Math.min(5, candidate.entries.length / 2)) continue; // outra lista, sem relacao
    for (const entry of shared) {
      const key = entry.uc.replace(/\D/g, "");
      const a = mine.get(key)?.pct ?? 0;
      const b = entry.pct ?? 0;
      if (Math.abs(a - b) > 0.00001) {
        warnings.push(`${names[key] ? `${names[key]} (${entry.uc})` : entry.uc}: ${pct(a)} nesta lista, mas ${pct(b)} na aba “${other.label}”.`);
      }
    }
  }
  return warnings;
}

