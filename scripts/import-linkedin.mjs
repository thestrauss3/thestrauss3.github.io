#!/usr/bin/env node
// One-time (safe to rerun) import of original public LinkedIn posts into _linkedin/.
//
//   node scripts/import-linkedin.mjs <path/to/Shares.csv> [options]
//
//   --dry-run            show what would happen; write nothing
//   --include <ids>      also import these "needs review" rows (comma-separated URNs or numbers)
//   --exclude <ids>      never import these rows
//
// Already-imported posts are left untouched, so hand edits (title, summary) survive reruns.
// Keep the export ZIP and Shares.csv outside this repository.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsvObjects } from "./lib/csv.mjs";
import { parseFrontMatter, stringifyFrontMatter } from "./lib/frontmatter.mjs";
import { classifyRow, fileNameFor } from "./lib/linkedin-import.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runImport({ csvPath, outDir, include = [], exclude = [], dryRun = false, log = console.log }) {
  const rows = parseCsvObjects(fs.readFileSync(csvPath, "utf8"));
  const header = rows.length ? Object.keys(rows[0]) : [];
  for (const col of ["Date", "ShareLink", "ShareCommentary", "Visibility"]) {
    if (rows.length && !header.includes(col)) {
      throw new Error(`${path.basename(csvPath)} has no "${col}" column. Is it LinkedIn's Shares.csv?`);
    }
  }

  const matches = (list, urn) => list.some((id) => id && (urn === id || urn.endsWith(`:${id}`)));
  const existing = new Map();
  if (fs.existsSync(outDir)) {
    for (const f of fs.readdirSync(outDir).filter((f) => f.endsWith(".md"))) {
      const { data } = parseFrontMatter(fs.readFileSync(path.join(outDir, f), "utf8"));
      if (data.linkedin_id) existing.set(data.linkedin_id, f);
    }
  }

  const report = { imported: [], already: [], excluded: [], review: [], duplicates: 0 };
  const seen = new Set();
  for (const row of rows) {
    let { decision, reason, urn, entry } = classifyRow(row);
    if (urn && seen.has(urn)) { report.duplicates++; continue; }
    if (urn) seen.add(urn);

    if (urn && matches(exclude, urn)) { decision = "exclude"; reason = "--exclude"; }
    else if (decision === "review" && matches(include, urn)) { decision = "import"; reason = `--include (${reason})`; }

    if (decision === "import" && existing.has(urn)) {
      report.already.push({ urn, file: existing.get(urn) });
      continue;
    }
    if (decision !== "import") {
      report[decision === "review" ? "review" : "excluded"].push({ urn, reason, date: entry?.date, summary: entry?.summary });
      continue;
    }
    const file = fileNameFor(urn);
    if (!dryRun) {
      fs.mkdirSync(outDir, { recursive: true });
      const { text, visibility, ...front } = entry;
      // The body stays empty because Jekyll would run Liquid on it; the full text lives in `text`.
      fs.writeFileSync(path.join(outDir, file), stringifyFrontMatter({ ...front, text }));
    }
    existing.set(urn, file);
    report.imported.push({ urn, file, date: entry.date });
  }

  const line = (r) => {
    const summary = r.summary ? `\n      "${r.summary.slice(0, 110)}${r.summary.length > 110 ? "…" : ""}"` : "";
    return `  ${r.urn ?? "(no id)"}  ${r.date ?? ""}  ${r.reason ?? r.file ?? ""}${summary}`;
  };
  log(`${dryRun ? "[dry run] " : ""}Read ${rows.length} rows from ${path.basename(csvPath)}.`);
  log(`Imported: ${report.imported.length}   Already imported: ${report.already.length}   ` +
      `Excluded: ${report.excluded.length}   Needs review: ${report.review.length}   Duplicate rows: ${report.duplicates}`);
  if (report.imported.length) log(`\nImported:\n${report.imported.map(line).join("\n")}`);
  if (report.review.length) log(`\nNeeds review (not imported; rerun with --include <id> to add):\n${report.review.map(line).join("\n")}`);
  if (report.excluded.length) log(`\nExcluded:\n${report.excluded.map(line).join("\n")}`);
  return report;
}

function parseArgs(argv) {
  const args = { include: [], exclude: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--include" || a === "--exclude") {
      args[a.slice(2)].push(...String(argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    } else if (a === "--out") args.outDir = path.resolve(argv[++i]);
    else if (a === "-h" || a === "--help") args.help = true;
    else if (!args.csvPath) args.csvPath = path.resolve(a);
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.csvPath) {
      console.log("Usage: node scripts/import-linkedin.mjs <path/to/Shares.csv> [--dry-run] [--include ids] [--exclude ids]");
      process.exit(args.help ? 0 : 1);
    }
    const rel = path.relative(repoRoot, args.csvPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      throw new Error("Shares.csv is inside the repository. Move it (and the export ZIP) outside the repo so it can't be committed or published.");
    }
    runImport({ ...args, outDir: args.outDir ?? path.join(repoRoot, "_linkedin") });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
