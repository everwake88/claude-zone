// Replays n8n 2.x tool-input validation ($fromAI → zod 3.25) on the built Main, for the call
// shapes the model really sends. Needs zod@3.25.76 and zod-to-json-schema@3.23.3:
//   node test/n8n-schema-check.mjs dist/everwake-main.json test/n8n-schema-cases.json
// n8n 2.x: $fromAI → zod (copied from packages/workflow/src/from-ai-parse-utils.ts and
// packages/@n8n/ai-utilities/src/utils/fromai-helpers.ts, types stripped)
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { readFileSync } from 'node:fs';
const jsonParse = (s) => JSON.parse(s);
function parseDefaultValue(value, type = 'string') {
  if (value === undefined) return value;
  const lowerValue = value.toLowerCase();
  if (type === 'string') return value.toString();
  if (type === 'boolean' && (lowerValue === 'true' || lowerValue === 'false')) return lowerValue === 'true';
  if (type === 'number' && !isNaN(Number(value))) return Number(value);
  try { return jsonParse(value); } catch { return value; }
}
function parseArguments(argsString) {
  const args = []; let currentArg = ''; let inQuotes = false; let quoteChar = ''; let escapeNext = false;
  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];
    if (escapeNext) { currentArg += char; escapeNext = false; continue; }
    if (char === '\\') { escapeNext = true; continue; }
    if (['"', "'", '`'].includes(char)) {
      if (!inQuotes) { inQuotes = true; quoteChar = char; currentArg += char; }
      else if (char === quoteChar) { inQuotes = false; quoteChar = ''; currentArg += char; }
      else currentArg += char;
      continue;
    }
    if (char === ',' && !inQuotes) { args.push(currentArg.trim()); currentArg = ''; continue; }
    currentArg += char;
  }
  if (currentArg) args.push(currentArg.trim());
  const cleanArgs = args.map((arg) => {
    const t = arg.trim();
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('`') && t.endsWith('`')) || (t.startsWith('"') && t.endsWith('"')))
      return t.slice(1, -1).replace(/\\'/g, "'").replace(/\\`/g, '`').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return t;
  });
  const type = (cleanArgs?.[2] ?? 'string').toLowerCase();
  if (!['string', 'number', 'boolean', 'json'].includes(type)) throw new Error('Invalid type: ' + type);
  return { key: cleanArgs[0] || '', description: cleanArgs[1], type, defaultValue: parseDefaultValue(cleanArgs[3], type) };
}
function extractFromAICalls(str) {
  const out = []; const pattern = /\$fromAI\s*\(\s*/gi; let match;
  while ((match = pattern.exec(str)) !== null) {
    let current = match.index + match[0].length, inQuotes = false, quoteChar = '', depth = 1, argsString = '';
    while (current < str.length && depth > 0) {
      const char = str[current];
      if (inQuotes) {
        if (char === '\\' && current + 1 < str.length) { argsString += char + str[current + 1]; current += 2; continue; }
        if (char === quoteChar) { inQuotes = false; quoteChar = ''; }
        argsString += char;
      } else {
        if (['"', "'", '`'].includes(char)) { inQuotes = true; quoteChar = char; }
        else if (char === '(') depth++; else if (char === ')') depth--;
        if (depth > 0 || char !== ')') argsString += char;
      }
      current++;
    }
    out.push(parseArguments(argsString));
  }
  return out;
}
function generateZodSchema(p) {
  let schema;
  switch (p.type?.toLowerCase()) {
    case 'string': schema = z.string(); break;
    case 'number': schema = z.number(); break;
    case 'boolean': schema = z.boolean(); break;
    case 'json': {
      const c = z.custom((data) => {
        if (data === null || typeof data !== 'object') return false;
        if (Array.isArray(data)) return data.length > 0;
        return Object.keys(data).length > 0;
      }, { message: 'Value must be a non-empty object or a non-empty array' });
      c._def.jsonSchema = { anyOf: [{ type: 'object', minProperties: 1, additionalProperties: true }, { type: 'array', minItems: 1 }] };
      schema = c; break;
    }
    default: schema = z.string();
  }
  if (p.description) schema = schema.describe(`${schema.description ?? ''} ${p.description}`.trim());
  if (p.defaultValue !== undefined) schema = schema.default(p.defaultValue);
  return schema;
}
const createZodSchemaFromArgs = (args) => z.object(Object.fromEntries(args.map(a => [a.key, generateZodSchema(a)]))).required();

const wf = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cases = JSON.parse(readFileSync(process.argv[3], 'utf8'));
for (const n of wf.nodes.filter(n => n.type.endsWith('toolWorkflow'))) {
  const args = Object.values(n.parameters.workflowInputs.value).flatMap(v => extractFromAICalls(String(v)));
  const schema = createZodSchemaFromArgs(args);
  const js = zodToJsonSchema(schema);
  console.log(`\n== ${n.name}: fields ${args.map(a => `${a.key}:${a.type}${a.defaultValue !== undefined ? '=' + JSON.stringify(a.defaultValue) : ''}`).join(' ')} · model must send: ${JSON.stringify(js.required || [])}`);
  for (const c of cases[n.name] || []) {
    const r = schema.safeParse(c);
    console.log(`${r.success ? 'OK  ' : 'FAIL'} ${JSON.stringify(c).slice(0, 90)}${r.success ? '  → ' + JSON.stringify(r.data).slice(0, 80) : '  ✖ ' + r.error.issues.map(i => i.path.join('.') + ': ' + i.message).join('; ')}`);
  }
}
