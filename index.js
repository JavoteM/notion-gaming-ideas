import OpenAI from "openai";
import { Client as NotionClient } from "@notionhq/client";

const { OPENAI_API_KEY, NOTION_API_KEY, NOTION_DATABASE_ID } = process.env;

if (!OPENAI_API_KEY || !NOTION_API_KEY || !NOTION_DATABASE_ID) {
  console.error(
    "Faltan variables de entorno: OPENAI_API_KEY, NOTION_API_KEY, NOTION_DATABASE_ID"
  );
  process.exit(1);
}

function toNotionId(id) {
  const clean = (id || "").trim().replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) return null;
  return clean.replace(
    /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
    "$1-$2-$3-$4-$5"
  );
}

const NOTION_DB = toNotionId(NOTION_DATABASE_ID);
if (!NOTION_DB) {
  console.error(
    "NOTION_DATABASE_ID inválido. Debe ser 32 hex (con o sin guiones). Valor recibido:",
    JSON.stringify(NOTION_DATABASE_ID)
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_API_KEY });

// Cuántos juegos recientes lee de Notion para evitar repetidos
const DEDUPE_LOOKBACK = 60;

async function getRecentGamesFromNotion(limit = 50) {
  const res = await notion.databases.query({
    database_id: NOTION_DB,
    page_size: Math.min(limit, 100),
    sorts: [{ property: "Fecha", direction: "descending" }],
  });

  const names = [];
  for (const page of res.results) {
    const title = page?.properties?.["Juego"]?.title;
    const text = Array.isArray(title)
      ? title.map((t) => t?.plain_text || "").join("").trim()
      : "";
    if (text) names.push(text);
  }
  return [...new Set(names)];
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {}
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
  return fallback;
}

function ensureOneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function truncate(str, max = 1800) {
  const s = (str ?? "").toString();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function createNotionItem(idea) {
  const properties = {
    Juego: { title: [{ text: { content: idea.juego } }] },
    Tipo: { select: { name: idea.tipo } },
    Popularidad: { select: { name: idea.popularidad } },
    Resumen: { rich_text: [{ text: { content: truncate(idea.resumen) } }] },
    Gancho: { rich_text: [{ text: { content: truncate(idea.gancho) } }] },
    "Por qué tiene potencial": {
      rich_text: [{ text: { content: truncate(idea.por_que_tiene_potencial) } }],
    },
    "Idea Short": {
      rich_text: [{ text: { content: truncate(idea.idea_short) } }],
    },
    Emoción: { select: { name: idea.emocion } },
    "Score viral": { number: clampNumber(idea.score_viral, 1, 10, 7) },
    Fecha: { date: { start: new Date().toISOString() } },

    // PRO (deben existir en Notion)
    "Título SEO": {
      rich_text: [{ text: { content: truncate(idea.titulo_seo, 500) } }],
    },
    "Guion 60s": {
      rich_text: [{ text: { content: truncate(idea.guion_60s) } }],
    },
    "Guion 8 min": {
      rich_text: [{ text: { content: truncate(idea.guion_8min) } }],
    },
  };

  return notion.pages.create({
    parent: { database_id: NOTION_DB },
    properties,
  });
}

async function main() {
  console.log("Leyendo últimos juegos de Notion para evitar repetidos...");
  const recentGames = await getRecentGamesFromNotion(DEDUPE_LOOKBACK);
  const bannedList = recentGames.length ? recentGames.join(" | ") : "(vacío)";

  const PROMPT = `
Actúa como un analista experto en contenido viral de videojuegos para YouTube (España).
Objetivo: proponer 3 videojuegos POCO CONOCIDOS con ALTO POTENCIAL de storytelling + 3 backups.

RESTRICCIONES (ACTUALIDAD + STORY):
- Evita AAA súper famosos y franquicias mainstream (Zelda, GTA, Elden Ring, The Last of Us, etc.).
- NO repitas nada de esta lista (juegos ya usados recientemente): ${bannedList}
- Prioriza juegos ACTUALES o recientes: lanzados en los últimos 3-4 años, o en early access / anunciados con fuerte tracción (2025–2026).
- Se permiten "semi-famosos" SI cumplen: historia potente + gancho narrativo claro + algo raro/único (ejemplos válidos: Mewgenics, Starsand Island).
- Prioriza indies, AA, juegos de culto modernos, joyas ocultas recientes, y proyectos prometedores.
- Deben tener ALGO DE HISTORIA o lore narrable (mínimo 1): misterio, giro, tragedia, terror, shock, nostalgia, conspiración, “qué pasó aquí”, personaje con arco, mundo con secretos.
- Cada propuesta debe dar material para:
  (1) un vídeo largo ~8 min (historia/explicación) y/o
  (2) un short ~60s (gancho + 1 revelación/curiosidad).
- Puntúa score_viral 1-10 pensando en: hook + claridad del conflicto + rareza + actualidad (trend potential).

CALIDAD (ANTI-GENÉRICO):
- Nada de listas obvias o “lo de siempre”. Si es conocido, justifica por qué AÚN ASÍ es buen vídeo hoy.
- Gancho en 1 frase estilo YouTube (emocional + específico).
- Resumen claro (spoiler-free o marcando “con spoilers”).
- “Por qué tiene potencial” debe ser concreto: qué misterio/conflicto, qué revelación, qué tema humano, qué escena “wow”.
- Incluye una razón de actualidad: update reciente, early access, anuncio, resurgimiento, o comunidad en crecimiento.


Devuelve SOLO un JSON válido (sin markdown, sin texto extra) con este formato EXACTO:

{
  "ideas": [
    {
      "juego": "",
      "tipo": "Historia|Short|Ambos",
      "popularidad": "Muy poco conocido|Nicho",
      "resumen": "",
      "gancho": "",
      "por_que_tiene_potencial": "",
      "idea_short": "",
      "emocion": "Misterio|Tragedia|Shock|Terror|Nostalgia|Asombro",
      "score_viral": 1,
      "titulo_seo": "",
      "guion_60s": "Estructura en bullets: HOOK (0-3s), CONTEXTO (3-10s), GIRO (10-40s), REMATE/CTA (40-60s).",
      "guion_8min": "Estructura en bullets con timestamps aproximados: 0:00 hook, 0:20 contexto, 1:30 personajes/mundo, 3:00 conflicto/misterio, 5:30 giro/revelación, 7:00 cierre/reflexión, 7:40 CTA."
    }
  ],
  "backups": [
    {
      "juego": "",
      "tipo": "Historia|Short|Ambos",
      "popularidad": "Muy poco conocido|Nicho",
      "resumen": "",
      "gancho": "",
      "por_que_tiene_potencial": "",
      "idea_short": "",
      "emocion": "Misterio|Tragedia|Shock|Terror|Nostalgia|Asombro",
      "score_viral": 1,
      "titulo_seo": "",
      "guion_60s": "",
      "guion_8min": ""
    }
  ]
}
`.trim();

  console.log("Generando ideas con IA...");

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: PROMPT }],
    temperature: 0.85,
  });

  const content = (resp.choices?.[0]?.message?.content || "").trim();
  const data = safeJsonParse(content);

  const ideas = Array.isArray(data?.ideas) ? data.ideas : [];
  const backups = Array.isArray(data?.backups) ? data.backups : [];

  if (ideas.length < 1) {
    console.error("La IA no devolvió ideas en el formato esperado:", content);
    process.exit(1);
  }

  const allowedTipo = ["Historia", "Short", "Ambos"];
  const allowedPop = ["Muy poco conocido", "Nicho"];
  const allowedEmo = ["Misterio", "Tragedia", "Shock", "Terror", "Nostalgia", "Asombro"];

  const recentSet = new Set(recentGames.map(normalizeGameName));
  const seen = new Set();

  function cleanItem(x) {
    const item = { ...x };
    item.juego = (item.juego || "").toString().trim();
    item.tipo = ensureOneOf(item.tipo, allowedTipo, "Ambos");
    item.popularidad = ensureOneOf(item.popularidad, allowedPop, "Nicho");
    item.emocion = ensureOneOf(item.emocion, allowedEmo, "Misterio");
    item.score_viral = clampNumber(item.score_viral, 1, 10, 7);

    item.resumen = (item.resumen || "").toString().trim();
    item.gancho = (item.gancho || "").toString().trim();
    item.por_que_tiene_potencial = (item.por_que_tiene_potencial || "").toString().trim();
    item.idea_short = (item.idea_short || "").toString().trim();
    item.titulo_seo = (item.titulo_seo || "").toString().trim();
    item.guion_60s = (item.guion_60s || "").toString().trim();
    item.guion_8min = (item.guion_8min || "").toString().trim();

    return item;
  }

  const merged = [...ideas.map((i) => cleanItem(i)), ...backups.map((i) => cleanItem(i))];

  // Filtra repetidos (contra Notion y dentro del batch)
  const finalToSave = [];
  for (const item of merged) {
    const key = normalizeGameName(item.juego);
    if (!item.juego) continue;
    if (recentSet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    finalToSave.push(item);
  }

  // Guarda máximo 6 (3+3)
  const capped = finalToSave.slice(0, 6);

  console.log(`Guardando ${capped.length} items en Notion...`);
  for (const item of capped) {
    await createNotionItem(item);
    console.log("✅ Guardada:", item.juego);
  }

  console.log("Hecho.");
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
