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

export type ParsedRateio = {
  ugUc: string | null;
  requestDate: string | null;
  enquadramento: string | null;
  forma: string | null;
  entries: ParsedRateioEntry[];
  totalPct: number;
  warnings: string[];
};

type RawCell = { col: string; row: number; type: string; value: string };

const MAX_ROWS = 20_000;
const EMPTY_ROWS_TO_STOP = 60;

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

function parseCells(rowXml: string, rowNumber: number): RawCell[] {
  const cells: RawCell[] = [];
  for (const match of rowXml.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, col, attrs, inner = ""] = match;
    const type = /\st="([^"]+)"/.exec(attrs)?.[1] ?? "n";
    let value = "";
    if (type === "inlineStr") {
      value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
    } else {
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      value = v ? decodeXml(v[1]) : "";
    }
    if (value !== "") cells.push({ col, row: rowNumber, type, value });
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
  let sheetFound = false;
  let sheetDone = false;

  // Estado da leitura da aba
  let pending = "";
  let headerRow: number | null = null;
  let ucCol: string | null = null;
  let lastUcRow = 0;

  const unzip = new Unzip();
  unzip.register(UnzipInflate);

  const handleRows = (final: boolean) => {
    let end: number;
    while ((end = pending.indexOf("</row>")) !== -1) {
      const rowXml = pending.slice(0, end + 6);
      pending = pending.slice(end + 6);
      const rowMatch = /<row[^>]*\sr="(\d+)"/.exec(rowXml);
      if (!rowMatch) continue;
      const rowNumber = Number(rowMatch[1]);
      const rowCells = parseCells(rowXml, rowNumber);
      cells.push(...rowCells);

      // Descobre a linha de cabecalho para saber quando a lista terminou.
      if (headerRow === null) {
        const header = rowCells.find((cell) => cell.type !== "s" && normalize(cell.value) === "unidade consumidora");
        // (cabecalhos em texto compartilhado sao resolvidos depois; aqui usamos so a posicao da coluna C como padrao)
        if (header) {
          headerRow = rowNumber;
          ucCol = header.col;
        }
      }
      if (rowCells.some((cell) => cell.col === (ucCol ?? "C") && rowNumber > (headerRow ?? 9) && cell.value.trim())) {
        lastUcRow = rowNumber;
      }
      if (rowNumber > MAX_ROWS || (lastUcRow > 0 && rowNumber - lastUcRow > EMPTY_ROWS_TO_STOP)) {
        sheetDone = true;
        return;
      }
    }
    if (final) sheetDone = true;
  };

  await new Promise<void>((resolve, reject) => {
    unzip.onfile = (entry) => {
      const name = entry.name;
      const isSheet = !sheetFound && /^xl\/worksheets\/sheet\d+\.xml$/.test(name);
      const isShared = name === "xl/sharedStrings.xml";
      if (!isSheet && !isShared) return;
      if (isSheet) sheetFound = true;

      const decoder = new TextDecoder();
      entry.ondata = (error, chunk, final) => {
        if (error) {
          reject(error);
          return;
        }
        const text = decoder.decode(chunk, { stream: !final });
        if (isShared) {
          sharedStringsXml += text;
          return;
        }
        if (sheetDone) return;
        pending += text;
        handleRows(final);
        if (sheetDone) {
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

  if (!sheetFound) throw new Error("Não encontrei nenhuma aba na planilha.");

  // Resolve textos compartilhados
  const shared = parseSharedStrings(sharedStringsXml);
  const resolved = cells.map((cell) => ({
    ...cell,
    text: cell.type === "s" ? shared[Number(cell.value)] ?? "" : cell.value,
  }));
  const byRow = new Map<number, typeof resolved>();
  for (const cell of resolved) {
    if (!byRow.has(cell.row)) byRow.set(cell.row, []);
    byRow.get(cell.row)!.push(cell);
  }
  for (const list of byRow.values()) list.sort((a, b) => colIndex(a.col) - colIndex(b.col));

  /** Valor da primeira celula preenchida a direita do rotulo. */
  const valueAfter = (label: RegExp) => {
    for (const list of byRow.values()) {
      const index = list.findIndex((cell) => label.test(normalize(cell.text)));
      if (index >= 0) {
        const next = list.slice(index + 1).find((cell) => cell.text.trim() && colIndex(cell.col) <= 12);
        if (next) return next;
      }
    }
    return null;
  };

  const warnings: string[] = [];
  const ugUc = valueAfter(/^unidade consumidora da unidade geradora/)?.text.trim() ?? null;
  const dateCell = valueAfter(/^data (da )?solicitacao/);
  const requestDate = dateCell ? excelDate(dateCell.text) : null;
  const enquadramento = valueAfter(/^enquadramento/)?.text.trim() ?? null;
  const forma = valueAfter(/^forma de alocacao/)?.text.trim() ?? null;

  // Cabecalho da lista
  let header: { row: number; uc: string; doc: string | null; pct: string | null; order: string | null } | null = null;
  for (const [row, list] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    const ucCell = list.find((cell) => normalize(cell.text) === "unidade consumidora");
    if (!ucCell) continue;
    const doc = list.find((cell) => /cpf|cnpj/.test(normalize(cell.text)));
    const pct = list.find((cell) => /%|excedente|percentual/.test(normalize(cell.text)) && cell !== ucCell);
    const order = list.find((cell) => normalize(cell.text) === "ordem");
    header = { row, uc: ucCell.col, doc: doc?.col ?? null, pct: pct?.col ?? null, order: order?.col ?? null };
    break;
  }
  if (!header) throw new Error("Não encontrei a coluna “Unidade Consumidora” na planilha.");
  const pctCol = header.pct ?? (header.doc ? String.fromCharCode(header.doc.charCodeAt(0) + 1) : null);

  const entries: ParsedRateioEntry[] = [];
  const seen = new Set<string>();
  for (const [row, list] of [...byRow.entries()].sort((a, b) => a[0] - b[0])) {
    if (row <= header.row) continue;
    const get = (col: string | null) => (col ? list.find((cell) => cell.col === col)?.text.trim() ?? "" : "");
    const uc = get(header.uc).replace(/\s+/g, "");
    if (!uc) continue;
    const key = uc.replace(/\D/g, "");
    if (seen.has(key)) {
      warnings.push(`A UC ${uc} aparece mais de uma vez (linha ${row}); mantive a primeira.`);
      continue;
    }
    seen.add(key);
    const rawPct = get(pctCol).replace(",", ".").replace("%", "");
    let pct: number | null = rawPct === "" ? null : Number(rawPct);
    if (pct !== null && !Number.isFinite(pct)) pct = null;
    if (pct !== null && pct > 1) pct /= 100; // escrito como 5,4 em vez de 0,054
    entries.push({ uc, doc: get(header.doc), pct, order: Number(get(header.order)) || entries.length + 1 });
  }

  if (!entries.length) throw new Error("A planilha não tem nenhuma UC na lista de rateio.");
  const totalPct = entries.reduce((sum, entry) => sum + (entry.pct ?? 0), 0);
  const isPercent = !forma || /percentual/i.test(forma);
  if (isPercent && entries.some((entry) => entry.pct === null)) {
    warnings.push("Há UCs sem percentual preenchido.");
  }
  if (isPercent && Math.abs(totalPct - 1) > 0.001) {
    warnings.push(`A soma dos percentuais é ${(totalPct * 100).toFixed(3)}% (o esperado é 100%).`);
  }

  return { ugUc, requestDate, enquadramento, forma, entries, totalPct, warnings };
}
