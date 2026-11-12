import 'server-only';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

// Reads an uploaded payroll sheet (.xlsx or .csv) into its columns and rows, as HR wrote them.
// The header row is found by itself (sheets often have a title and a blank row above it);
// every row under it with any value becomes one employee row, its cells kept under c1…cN.

export type Column = { key: string; header: string; visible: boolean };
export type Parsed = { sheetName: string; columns: Column[]; rows: { rowNo: number; cells: Record<string, unknown> }[] };
export type IdentityMap = Partial<Record<'full_name' | 'national_id' | 'work_id' | 'phone', string>>;

function plain(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim() || null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') {
    if ('result' in v) return plain((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('richText' in v) return plain((v as ExcelJS.CellRichTextValue).richText.map((p) => p.text).join(''));
    if ('text' in v) return plain(String((v as ExcelJS.CellHyperlinkValue).text));
    if ('error' in v) return null;
  }
  return String(v);
}

export async function readWorkbook(buf: Buffer, fileName: string): Promise<Parsed> {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(fileName)) await wb.csv.read(Readable.from(buf));
  else await wb.xlsx.load(buf as unknown as ArrayBuffer);

  // the first worksheet that holds a table
  for (const ws of wb.worksheets) {
    const grid: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: unknown[] = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(plain(row.getCell(c).value));
      grid[n - 1] = vals;
    });
    // the header: within the first 15 rows, the row with the most text cells (at least two)
    let headerIdx = -1, best = 1;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const textCells = (grid[i] || []).filter((v) => typeof v === 'string' && v.length > 0).length;
      if (textCells > best) { best = textCells; headerIdx = i; }
    }
    if (headerIdx < 0) continue;

    const header = grid[headerIdx];
    const seen = new Map<string, number>();
    const columns: (Column & { index: number })[] = [];
    header.forEach((h, i) => {
      let name = h == null ? '' : String(h).trim();
      // a blank header with data under it still gets a column
      const hasData = grid.slice(headerIdx + 1).some((r) => r && r[i] != null);
      if (!name && !hasData) return;
      if (!name) name = `#${i + 1}`;
      const k = seen.get(name) || 0;
      seen.set(name, k + 1);
      if (k) name = `${name} (${k + 1})`;
      columns.push({ key: `c${columns.length + 1}`, header: name, visible: true, index: i });
    });

    const rows: Parsed['rows'] = [];
    for (let r = headerIdx + 1; r < grid.length; r++) {
      const line = grid[r];
      if (!line || line.every((v) => v == null)) continue;
      const cells: Record<string, unknown> = {};
      for (const col of columns) if (line[col.index] != null) cells[col.key] = line[col.index];
      // a totals line at the bottom ("الإجمالي" with numbers only) is not an employee
      const texts = Object.values(cells).filter((v) => typeof v === 'string') as string[];
      if (texts.length <= 1 && texts.some((s) => /^(الإجمالي|الاجمالي|المجموع|إجمالي|total|totals|sum)$/i.test(s))) continue;
      rows.push({ rowNo: r + 1, cells });
    }
    if (rows.length) return { sheetName: ws.name, columns: columns.map(({ index, ...c }) => c), rows };
  }
  throw new Error('no-rows');
}

// Which column is which, guessed from the headers (Arabic or English) and, for the
// national id, from the cells themselves (a column of 14-digit numbers).
const PATTERNS: [keyof IdentityMap, RegExp][] = [
  ['national_id', /(الرقم|رقم)\s*(ال)?قوم[يى]|national|\bnid\b|id\s*(no|number)/i],
  ['phone', /موبايل|محمول|تليفون|هاتف|جوال|phone|mobile|\btel\b/i],
  ['work_id', /كود|الرقم الوظيف[يى]|رقم الموظف|رقم وظيف[يى]|employee\s*(id|code|no)|emp\s*(id|code|no)|staff\s*(id|no)|\bcode\b/i],
  ['full_name', /^(ال)?اسم|اسم الموظف|الاسم بالكامل|full\s*name|employee\s*name|^name$/i]
];
export function guessIdentity(p: Parsed): IdentityMap {
  const out: IdentityMap = {};
  const used = new Set<string>();
  for (const [field, re] of PATTERNS) {
    const col = p.columns.find((c) => !used.has(c.key) && re.test(c.header));
    if (col) { out[field] = col.key; used.add(col.key); }
  }
  if (!out.national_id) {
    const col = p.columns.find((c) => !used.has(c.key) && p.rows.slice(0, 20).filter((r) => /^\d{14}$/.test(String(r.cells[c.key] ?? '').replace(/\D/g, ''))).length >= Math.min(3, p.rows.length));
    if (col) out.national_id = col.key;
  }
  return out;
}
