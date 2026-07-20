// scripts/backfill-mailroom-from-sheet.mjs
//
// One-time migration: pull every row out of the legacy Mailroom Google
// Sheet (Jotform-fed, the same gviz endpoint /mailroom.html has always
// read from) and land it in the new native mail_items table so history
// isn't lost when the old tool is retired.
//
// What can't be recovered: per-browser localStorage state (done/archived/
// notes) from the old tool was never synced anywhere, so it's gone.
// Free-text "Send To" / "Processed by" values are preserved as text in
// the notes field (best-effort matched against profiles by name/email
// first) since they were never real SILO user references.
//
// Required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// Run:
//   node scripts/backfill-mailroom-from-sheet.mjs
//
// Optional:
//   MAILROOM_SHEET_ID   (defaults to the sheet /mailroom.html already reads)
//   MAILROOM_GID        (defaults to 0)
//   MAILROOM_COMPANY_ENTITY_ID  (defaults to Baseballism)
//   MAILROOM_BACKFILL_DRY_RUN=true

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SHEET_ID = process.env.MAILROOM_SHEET_ID || "12cuw5LrkFvwjcR33m8zwiWIPEov6P6t72rMSIrKq-Ck";
const GID = Number(process.env.MAILROOM_GID || 0);
const COMPANY_ENTITY_ID = process.env.MAILROOM_COMPANY_ENTITY_ID || "3bd934c9-4cdd-429b-9076-f8f6b45d4eb7";
const DRY_RUN = process.env.MAILROOM_BACKFILL_DRY_RUN === "true";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function safe(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}
function nullish(v) {
  const x = safe(v);
  return x || null;
}

// Same parsing rules as /mailroom.html's fetchSheet()/parsePriority(), so
// the imported rows match what the old tool showed.
function parsePriority(p) {
  const t = safe(p).toUpperCase();
  if (t.startsWith("P0")) return "P0";
  if (t.startsWith("P1")) return "P1";
  if (t.startsWith("P2")) return "P2";
  if (t.startsWith("P3")) return "P3";
  return "P2";
}

function toISODate(s) {
  const x = safe(s);
  if (!x || /^Date\(/.test(x)) return null;
  const a = x.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (a) return `${a[1]}-${a[2]}-${a[3]}`;
  const b = x.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (b) return `${b[3]}-${String(b[1]).padStart(2, "0")}-${String(b[2]).padStart(2, "0")}`;
  const c = new Date(x);
  if (!isNaN(c.getTime())) {
    return `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, "0")}-${String(c.getDate()).padStart(2, "0")}`;
  }
  return null;
}

function gvizUrl(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?gid=${gid}&tqx=out:json`;
}

function parseGViz(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Unexpected Google Sheet response.");
  return JSON.parse(text.substring(start, end + 1));
}

async function fetchSheetRows() {
  const res = await fetch(gvizUrl(SHEET_ID, GID), { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const json = parseGViz(await res.text());
  const cols = json.table.cols.map((c) => safe(c.label));
  const rows = json.table.rows || [];

  return rows.map((r) => {
    const cells = (r.c || []).map((c) => (!c ? "" : c.f !== undefined && c.f !== null ? c.f : c.v));
    const obj = {};
    cols.forEach((k, i) => (obj[k] = cells[i] ?? ""));
    return obj;
  });
}

function buildProfileLookup(profiles) {
  const byKey = new Map();
  for (const p of profiles) {
    if (p.email) byKey.set(String(p.email).trim().toLowerCase(), p.id);
    if (p.name) byKey.set(String(p.name).trim().toLowerCase(), p.id);
  }
  return byKey;
}

function resolveUserId(lookup, freeText) {
  const key = safe(freeText).toLowerCase();
  return key ? lookup.get(key) || null : null;
}

async function main() {
  console.log(`[mailroom-backfill] mode=${DRY_RUN ? "dry-run" : "live"} sheet=${SHEET_ID} gid=${GID}`);

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, name, email");
  if (profilesError) throw new Error(`profiles load failed: ${profilesError.message}`);
  const profileLookup = buildProfileLookup(profiles || []);

  const { data: existing, error: existingError } = await supabase
    .from("mail_items")
    .select("legacy_submission_id")
    .not("legacy_submission_id", "is", null);
  if (existingError) throw new Error(`existing mail_items load failed: ${existingError.message}`);
  const alreadyImported = new Set((existing || []).map((r) => r.legacy_submission_id));

  const sheetRows = await fetchSheetRows();
  console.log(`[mailroom-backfill] ${sheetRows.length} rows in sheet, ${alreadyImported.size} already imported`);

  const toInsert = [];
  const activityRows = [];
  let skippedNoId = 0;
  let skippedDuplicate = 0;

  for (const obj of sheetRows) {
    const submissionId = safe(obj["Submission ID"] || obj["SubmissionID"] || obj["ID"]);
    if (!submissionId) { skippedNoId += 1; continue; }
    if (alreadyImported.has(submissionId)) { skippedDuplicate += 1; continue; }

    const sendTo = safe(obj["Send To (Notify Internally)"]);
    const processedByRaw = safe(obj["Processed by:"] || obj["Processed by"]);
    const processedRaw = safe(obj["File Received & Processed"]);
    const fileProcessed = /^(yes|y|true|processed|done|complete|completed)$/i.test(processedRaw);

    const noteParts = [];
    const rawNotes = nullish(obj["Notes / Questions"]);
    if (rawNotes) noteParts.push(rawNotes);
    if (sendTo && !resolveUserId(profileLookup, sendTo)) noteParts.push(`Originally sent to (from Jotform): ${sendTo}`);
    if (processedByRaw && !resolveUserId(profileLookup, processedByRaw)) noteParts.push(`Originally processed by (from Jotform): ${processedByRaw}`);
    const attachmentUrls = safe(obj["Upload Scanned Document (PDF)"]).match(/https?:\/\/[^\s"\]]+/g) || [];
    if (attachmentUrls.length) noteParts.push(`Original attachment link(s): ${attachmentUrls.join(" ")}`);

    const itemId = crypto.randomUUID();

    toInsert.push({
      id: itemId,
      company_entity_id: COMPANY_ENTITY_ID,
      subject: nullish(obj["Subject / What is this about?"]) || `Imported mail item ${submissionId}`,
      sender: nullish(obj["Received From (Sender)"]),
      document_type: nullish(obj["Document Type"]),
      priority: parsePriority(obj["Priority"]),
      received_date: toISODate(obj["Received Date"]),
      due_date: toISODate(obj["Due Date (if any)"]),
      action_needed: nullish(obj["Action Needed"]),
      notes: noteParts.length ? noteParts.join("\n\n") : null,
      assigned_to: resolveUserId(profileLookup, sendTo),
      processed_by: resolveUserId(profileLookup, processedByRaw),
      status: fileProcessed ? "done" : "open",
      legacy_submission_id: submissionId,
      legacy_source: "jotform_sheet_backfill",
    });

    activityRows.push({
      mail_item_id: itemId,
      company_entity_id: COMPANY_ENTITY_ID,
      activity_type: "imported",
      message: `Imported from legacy Mailroom Google Sheet (submission ${submissionId}).`,
    });
  }

  console.log(`[mailroom-backfill] ${toInsert.length} new rows to import, ${skippedDuplicate} already present, ${skippedNoId} skipped (no submission id)`);

  if (DRY_RUN) {
    console.log("[mailroom-backfill] dry run — no writes made. Sample:", toInsert.slice(0, 3));
    return;
  }

  if (!toInsert.length) {
    console.log("[mailroom-backfill] nothing new to import.");
    return;
  }

  const chunkSize = 500;
  for (let i = 0; i < toInsert.length; i += chunkSize) {
    const chunk = toInsert.slice(i, i + chunkSize);
    const { error } = await supabase.from("mail_items").insert(chunk);
    if (error) throw new Error(`mail_items insert failed: ${error.message}`);
  }
  for (let i = 0; i < activityRows.length; i += chunkSize) {
    const chunk = activityRows.slice(i, i + chunkSize);
    const { error } = await supabase.from("mail_item_activity").insert(chunk);
    if (error) throw new Error(`mail_item_activity insert failed: ${error.message}`);
  }

  console.log(`[mailroom-backfill] imported ${toInsert.length} mail items.`);
}

main().catch((err) => {
  console.error("[mailroom-backfill] fatal", err);
  process.exit(1);
});
