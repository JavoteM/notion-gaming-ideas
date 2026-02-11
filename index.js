import OpenAI from "openai";
import { Client as NotionClient } from "@notionhq/client";

const {
  OPENAI_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID
} = process.env;

if (!OPENAI_API_KEY || !NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error("Faltan variables de entorno: OPENAI_API_KEY, NOTION_API_KEY, NOTION_DATABASE_ID");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_API_KEY });

// Cuántos juegos recientes lee de Notion para evitar repetidos
const DEDUPE_LOOKBACK = 60;

async function getRecentGamesFromNotion(limit = 50) {
  const res = await notion.databases.query({
    database_id: NOTION_DATABASE_ID,
    page_size: Math.min(limit, 100),
    sorts: [{ property: "Fecha", direction: "descending" }]
  });

  const names = [];
  for (const page of res.results) {
    const title = page?.properties?.["Juego"]?.title;
    const text = Array.isArray(title) ? title.map(t => t?.plain_text || "").join("").trim() : "";
    if (text) names.push(text);
  }
  return [...new Set(names)];
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch {}
  const start = str.indexOf("{");
  const end = str.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    const sliced = str.slice(start, end + 1);
    return JSON.parse(sliced);
  }
  throw new Error("No se pudo parsear JSON.");
}

function normalizeGameName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s:.-]/gu, "")
    .trim();
}

function clampNumber(n, min, max, fallback) {
  const x = Number(n);
  if (Number.isFinite(x)) return Math.max(min, Math.min(max, x));

