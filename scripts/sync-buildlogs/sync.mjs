// Sync a Notion "Build Logs" database into Jekyll _logs/*.md files.
// Non-destructive: writes/overwrites one .md per published Notion row by slug,
// downloads page images into assets/logs/<slug>/, and never deletes other files.
//
// Env:
//   NOTION_TOKEN         - Notion internal integration secret
//   NOTION_DATABASE_ID   - the Build Logs database id
//   (optional) LOGS_DIR, ASSETS_DIR  - override output paths

import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from "node:fs/promises";
import path from "node:path";

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DATABASE_ID;
// Optional explicit data source id. Notion's 2025-09-03+ API exposes one or more
// "data sources" per database; this workspace is on that model. If left blank we
// resolve it automatically from the database. See queryAll().
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || "";
if (!TOKEN || !DB_ID) {
  console.error("Missing NOTION_TOKEN or NOTION_DATABASE_ID");
  process.exit(1);
}

// Resolve repo root whether run from repo root or from scripts/sync-buildlogs/
const REPO_ROOT = process.env.GITHUB_WORKSPACE
  || path.resolve(process.cwd(), process.cwd().includes("scripts") ? "../.." : ".");
const LOGS_DIR  = path.join(REPO_ROOT, process.env.LOGS_DIR  || "_logs");
const ASSETS_DIR = path.join(REPO_ROOT, process.env.ASSETS_DIR || "assets/logs");
const ASSETS_WEB = "/" + (process.env.ASSETS_DIR || "assets/logs"); // site-root path; layout adds baseurl

const notion = new Client({ auth: TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Same slug rule as the Build Index, so log filenames match the kit cards.
const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---- property readers (tolerant of missing/renamed fields) ----
const plain = (rich) => (rich || []).map((r) => r.plain_text).join("").trim();
function prop(props, name) { return props[name]; }
function readText(props, name) {
  const p = prop(props, name); if (!p) return "";
  if (p.type === "title") return plain(p.title);
  if (p.type === "rich_text") return plain(p.rich_text);
  if (p.type === "select") return p.select ? p.select.name : "";
  if (p.type === "number") return p.number ?? "";
  if (p.type === "date") return p.date ? p.date.start : "";
  if (p.type === "checkbox") return p.checkbox;
  return "";
}
function findTitleKey(props) {
  for (const k in props) if (props[k].type === "title") return k;
  return "Kit";
}

const STATUS_MAP = {
  built: "done", done: "done",
  "in progress": "wip", wip: "wip", building: "wip",
  backlog: "backlog", planned: "backlog",
};
const normStatus = (s) => STATUS_MAP[(s || "").toLowerCase()] || "";

// ---- image download ----
async function download(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
}
function extFromUrl(u) {
  const clean = u.split("?")[0];
  const m = clean.match(/\.(jpe?g|png|webp|gif)$/i);
  return m ? "." + m[1].toLowerCase().replace("jpeg", "jpg") : ".png";
}

function yamlScalar(v) {
  if (v === "" || v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // dates pass through unquoted; everything else JSON-quoted (valid YAML)
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return JSON.stringify(v);
}

// Resolve the data source id for the database (2025-09-03+ API). Prefers an
// explicit NOTION_DATA_SOURCE_ID; otherwise reads the database's data_sources
// list. Returns null for legacy single-source workspaces where databases.query
// is the right call.
async function resolveDataSourceId() {
  if (DATA_SOURCE_ID) return DATA_SOURCE_ID;
  try {
    const db = await notion.databases.retrieve({ database_id: DB_ID });
    const sources = db.data_sources || [];
    if (sources.length === 0) return null;
    if (sources.length > 1) {
      console.warn(
        `  ! Database has ${sources.length} data sources; using the first ("${sources[0].name}"). ` +
        `Set NOTION_DATA_SOURCE_ID to pin a specific one.`
      );
    }
    return sources[0].id;
  } catch {
    return null; // older SDK/API: fall back to databases.query
  }
}

async function queryAll() {
  const dsId = await resolveDataSourceId();
  const useDataSource = dsId && notion.dataSources && typeof notion.dataSources.query === "function";
  let results = [], cursor;
  do {
    const r = useDataSource
      ? await notion.dataSources.query({ data_source_id: dsId, start_cursor: cursor, page_size: 100 })
      : await notion.databases.query({ database_id: DB_ID, start_cursor: cursor, page_size: 100 });
    results = results.concat(r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function main() {
  const pages = await queryAll();
  let written = 0;

  for (const page of pages) {
    const props = page.properties || {};
    // Publish gate (skip if a Publish checkbox exists and is false)
    if (props.Publish && props.Publish.type === "checkbox" && props.Publish.checkbox === false) continue;

    const titleKey = findTitleKey(props);
    const kit = plain(props[titleKey]?.title);
    if (!kit) continue;
    const sg = readText(props, "Slug") || slugify(kit);

    const front = {
      layout: "buildlog",
      kit,
      grade: readText(props, "Grade"),
      scale: readText(props, "Scale"),
      status: normStatus(readText(props, "Status")),
      build_time: readText(props, "Build Time"),
      difficulty: readText(props, "Difficulty"),
      rating: readText(props, "Rating"),
      started: readText(props, "Started"),
      finished: readText(props, "Finished"),
    };

    // body -> markdown
    const blocks = await n2m.pageToMarkdown(page.id);
    let body = (n2m.toMarkdownString(blocks).parent || "").trim();

    // pull images out of the body, download them, collect into a gallery grid
    const gallery = [];
    const imgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
    const urls = [];
    let m;
    while ((m = imgRe.exec(body)) !== null) urls.push(m[1]);
    let idx = 0;
    for (const url of urls) {
      idx++;
      const file = String(idx).padStart(2, "0") + extFromUrl(url);
      try {
        await download(url, path.join(ASSETS_DIR, sg, file));
        gallery.push(`${ASSETS_WEB}/${sg}/${file}`);
      } catch (e) {
        console.warn(`  ! image skipped (${e.message})`);
      }
    }
    // strip image markdown lines from the body (they live in the gallery now)
    body = body.replace(/^\s*!\[[^\]]*\]\([^)]+\)\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

    if (gallery.length) {
      front.cover = gallery[0];
      front.gallery = gallery;
    }

    // emit YAML front matter
    let fm = "---\n";
    for (const [k, v] of Object.entries(front)) {
      if (k === "gallery") continue;
      const s = yamlScalar(v);
      if (s !== "") fm += `${k}: ${s}\n`;
    }
    if (front.gallery) {
      fm += "gallery:\n";
      for (const g of front.gallery) fm += `  - ${g}\n`;
    }
    fm += "---\n\n";

    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.writeFile(path.join(LOGS_DIR, `${sg}.md`), fm + body + "\n");
    written++;
    console.log(`  wrote _logs/${sg}.md  (${gallery.length} image${gallery.length === 1 ? "" : "s"})`);
  }
  console.log(`Done. ${written} log(s) synced from ${pages.length} row(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
