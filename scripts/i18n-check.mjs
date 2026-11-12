// The language check (spec B8.1). Fails when:
//   1. a key used in web/src (t("…"), tk("…"), tp(n, "…", "…"), plural(n, "…"), tmap({…}) values, tlist(…, [fields]))
//      has no entry in hi-IN, id-ID or pt-BR;
//   2. a translation drops or invents a {placeholder};
//   3. visible English is written straight into JSX instead of going through t().
// Usage: node scripts/i18n-check.mjs [--keys out.json] [--missing out.json]
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "web", "src");
const ts = createRequire(join(ROOT, "web", "package.json"))("typescript");
const LOCALES = ["hi-IN", "id-ID", "pt-BR"];
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

// Words that stay as they are in every language: brand, product and protocol names.
const KEEP = /^(Callback|PayPal|MCP|Telegram|WhatsApp|SMS|OpenAI|GPT-Live|axe-core|Render|GitHub|Twilio|JSON|CSV|API|URL|OK|ID|Ask|n\/a|vs|AI)$/;
const SKIP_TAGS = new Set(["code", "kbd", "pre", "samp"]);

function files(d) {
  const out = [];
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) { if (f !== "ui") out.push(...files(p)); }
    else if (/\.(tsx?|mts)$/.test(p) && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const keys = new Map(); // key -> first place
const raw = [];
const add = (k, where) => { if (k && /[A-Za-z]/.test(k) && !keys.has(k)) keys.set(k, where); };
const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);

for (const file of files(SRC)) {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const rel = file.slice(ROOT.length + 1);
  const where = (n) => `${rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const f = n.expression.getText(sf);
      const a = n.arguments;
      if (f === "t" || f === "tk" || f === "tr") add(lit(a[0]), where(n));
      if (f === "tp") { add(lit(a[1]), where(n)); add(lit(a[2]), where(n)); }
      if (f === "plural") {
        const one = lit(a[1]);
        if (one) { add(`{n} ${one}`, where(n)); add(`{n} ${lit(a[2]) ?? `${one}s`}`, where(n)); }
      }
      if (f === "tmap" && a[0] && ts.isObjectLiteralExpression(a[0])) for (const p of a[0].properties) if (ts.isPropertyAssignment(p)) add(lit(p.initializer), where(p));
      if (f === "tlist" && a[0] && ts.isArrayLiteralExpression(a[0]) && a[1] && ts.isArrayLiteralExpression(a[1])) {
        const fields = new Set(a[1].elements.map(lit));
        for (const el of a[0].elements) if (ts.isObjectLiteralExpression(el)) for (const p of el.properties) if (ts.isPropertyAssignment(p) && fields.has(p.name.getText(sf))) add(lit(p.initializer), where(p));
      }
    }
    if (ts.isVariableDeclaration(n) && n.name.getText(sf) === "SERVER_KEYS" && n.initializer && ts.isArrayLiteralExpression(n.initializer)) for (const e of n.initializer.elements) add(lit(e), where(e));
    if (ts.isJsxText(n) && /[A-Za-z]{2,}/.test(n.text)) {
      let p = n.parent;
      while (p && !ts.isJsxElement(p)) p = p.parent;
      const tag = p ? p.openingElement.tagName.getText(sf) : "";
      const words = n.text.trim().split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w));
      if (!SKIP_TAGS.has(tag) && words.some((w) => !KEEP.test(w.replace(/[^\w/-]/g, "")))) raw.push(`${where(n)}: ${n.text.trim().slice(0, 80)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const problems = [];
const missing = {};
for (const l of LOCALES) {
  const d = JSON.parse(readFileSync(join(SRC, "i18n", `${l}.json`), "utf8"));
  missing[l] = [];
  for (const k of keys.keys()) {
    if (typeof d[k] !== "string" || !d[k].trim()) missing[l].push(k);
    else if (ph(d[k]) !== ph(k)) problems.push(`${l}: placeholders differ for "${k}" -> "${d[k]}"`);
  }
  const unused = Object.keys(d).filter((k) => !keys.has(k));
  if (unused.length) console.log(`${l}: ${unused.length} translations no longer used (fine; remove when convenient)`);
}

if (arg("--keys")) writeFileSync(arg("--keys"), JSON.stringify(Object.fromEntries(keys), null, 1));
if (arg("--missing")) writeFileSync(arg("--missing"), JSON.stringify(missing, null, 1));
console.log(`${keys.size} keys in web/src`);
for (const l of LOCALES) console.log(`${l}: ${keys.size - missing[l].length}/${keys.size} translated${missing[l].length ? `; missing e.g. "${missing[l][0]}"` : ""}`);
for (const r of raw) console.log(`untranslated JSX text: ${r}`);
for (const p of problems) console.log(p);
const bad = raw.length + problems.length + LOCALES.reduce((s, l) => s + missing[l].length, 0);
if (bad) { console.error(`i18n check FAILED: ${raw.length} hard-coded, ${problems.length} placeholder problems, ${LOCALES.map((l) => `${missing[l].length} ${l}`).join(", ")} missing`); process.exit(1); }
console.log("i18n check passed");
