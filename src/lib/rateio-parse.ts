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
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
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

  // Aba do rateio: a que tem o cabecalho "Unidade Consumidora" + CPF/CNPJ (modelo da Equatorial).
  const isListHeader = (list: Resolved[]) =>
    list.some((cell) => normalize(cell.text) === "unidade consumidora") && list.some((cell) => /cpf|cnpj/.test(normalize(cell.text)));
  const mainSheet = [...sheets.entries()].find(([, rows]) => [...rows.values()].some(isListHeader))?.[0] ?? [...sheets.keys()][0];
  const byRow = sheets.get(mainSheet) ?? new Map<number, Resolved[]>();

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

  // Nomes dos clientes: qualquer aba com uma coluna de nome/cliente e uma de UC.
  const ucKeys = [...new Set(entries.map((entry) => entry.uc.replace(/\D/g, "")))];
  const names: Record<string, string> = {};
  const namesFrom = new Set<string>();
  const NAME_HEADER = /^(nome|cliente|nome do cliente|nome cliente|titular|nome do titular|razao social|beneficiario|consumidor)\b/;
  const UC_HEADER = /^(uc|u\.c\.?|unidade consumidora|unid\.? consumidora|conta contrato|instalacao|codigo da uc|numero da uc|n. ?(da )?uc)\b/;
  for (const [sheet, rows] of sheets) {
    let nameCol: string | null = null;
    let ucCol: string | null = null;
    for (const [, list] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
      const textCells = list.filter((cell) => cell.type === "s" || cell.type === "str" || cell.type === "inlineStr");
      const nameHeader = textCells.find((cell) => NAME_HEADER.test(normalize(cell.text)));
      const ucHeader = textCells.find((cell) => UC_HEADER.test(normalize(cell.text)) && !/geradora/.test(normalize(cell.text)));
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
  const totalPct = entries.reduce((sum, entry) => sum + (entry.pct ?? 0), 0);
  const isPercent = !forma || /percentual/i.test(forma);
  if (isPercent && entries.some((entry) => entry.pct === null)) {
    warnings.push("Há UCs sem percentual preenchido.");
  }
  if (isPercent && Math.abs(totalPct - 1) > 0.001) {
    warnings.push(`A soma dos percentuais é ${(totalPct * 100).toFixed(3)}% (o esperado é 100%).`);
  }

  const found = Object.keys(names).length;
  if (found && found < entries.length) warnings.push(`Encontrei o nome do cliente de ${found} das ${entries.length} UCs.`);

  return { names, namesFrom: [...namesFrom], ugUc, requestDate, enquadramento, forma, entries, totalPct, warnings };
}
