import OpenAI from "openai";
import { Client as NotionClient } from "@notionhq/client";
import Parser from "rss-parser";

const {
  OPENAI_API_KEY,
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  RSS_DAYS,
  RSS_URLS
} = process.env;

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
    "NOTION_DATABASE_ID inválido. Valor recibido:",
    JSON.stringify(NOTION_DATABASE_ID)
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const notion = new NotionClient({ auth: NOTION_API_KEY });
const parser = new Parser({ timeout: 15000 });

const DAYS = Number(RSS_DAYS || 7);
const MAX_ITEMS_FOR_MODEL = 28;
const MAX_PER_FEED = 20;

const DEFAULT_FEEDS = [
  "https://www.rockpapershotgun.com/feed",
  "https://www.pcgamer.com/rss/",
  "https://www.gamesradar.com/feeds/all/",
  "https://www.eurogamer.net/feed",
  "https://www.destructoid.com/feed/",
  "https://www.polygon.com/rss/index.xml",
  "https://kotaku.com/rss",
  "https://www.gematsu.com/feed"
];

const KEYWORDS = [
  "announce",
  "announced",
  "announcement",
  "reveal",
  "revealed",
  "trailer",
  "demo",
  "playtest",
  "early access",
  "launch",
  "release",
  "beta",
  "mmo",
  "mmorpg",
  "online",
  "season",
  "live service",
  "presentación",
  "anunciado",
  "anuncio",
  "revelado",
  "tráiler",
  "trailer",
  "prueba",
  "acceso anticipado",
  "lanzamiento",
  "beta",
  "online"
];

function includesKeyword(text) {
  const t = (text || "").toLowerCase();
  return KEYWORDS.some((k) => t.includes(k));
}

function parseDate(item) {
  const d = item.isoDate || item.pubDate || item.published || item.updated || null;
  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : null;
}

function normalizeKey(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function truncate(str, max = 1800) {
  const s = (str ?? "").toString();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function clampNumber(n, min, max, fallback) {
  const x = Number(n);
  if (Number.isFinite(x)) return Math.max(min, Math.min(max, x));
  return fallback;
}

function ensureOneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

async function getDatabasePropertyNames() {
  const db = await notion.databases.retrieve({ database_id: NOTION_DB });
  return new Set(Object.keys(db?.properties || {}));
}

async function fetchRecentRssItems() {
  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  const feeds = RSS_URLS
    ? RSS_URLS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_FEEDS;

  const all = [];
  for (const feedUrl of feeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      const source = feed?.title || feedUrl;

      const items = (feed?.items || []).slice(0, MAX_PER_FEED);
      for (const it of items) {
        const dt = parseDate(it);
        if (!dt) continue;
        if (dt.getTime() < cutoff) continue;

        const title = (it.title || "").trim();
        const link = (it.link || "").trim();
        const content = (
          it.contentSnippet ||
          it.content ||
          it.summary ||
          ""
        ).toString();

        const textBlob = `${title} ${content}`.toLowerCase();
        if (!includesKeyword(textBlob)) continue;

        all.push({
          title,
          link,
          source,
          date: dt.toISOString(),
          snippet: truncate(content.replace(/\s+/g, " "), 280)
        });
      }
    } catch (e) {
      console.log("RSS fail:", feedUrl, "-", e?.message || e);
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const x of all) {
    const key = x.link
      ? `L:${normalizeKey(x.link)}`
      : `T:${normalizeKey(x.title)}|${normalizeKey(x.source)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(x);
  }

  deduped.sort((a, b) => (a.date < b.date ? 1 : -1));
  return deduped.slice(0, MAX_ITEMS_FOR_MODEL);
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {}
  const start = str.indexOf("{");
  const end = str.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return JSON.parse(str.slice(start, end + 1));
  }
  throw new Error("No se pudo parsear JSON.");
}

async function createNotionItem(idea, dbProps) {
  const props = {};

  function setIfExists(name, value) {
    if (dbProps.has(name) && value !== undefined && value !== null) props[name] = value;
  }

  // Notion NO acepta date.start = null (ni string vacío). Solo setea si es fecha válida.
  function setDateIfValid(name, isoLike) {
    if (!dbProps.has(name)) return;
    const v = (isoLike ?? "").toString().trim();
    if (!v) return;
    const dt = new Date(v);
    if (Number.isNaN(dt.getTime())) return;
    props[name] = { date: { start: dt.toISOString() } };
  }

  // Base
  setIfExists("Juego", { title: [{ text: { content: idea.juego } }] });
  setIfExists("Tipo", { select: { name: idea.tipo } });
  setIfExists("Popularidad", { select: { name: idea.popularidad } });
  setIfExists("Emoción", { select: { name: idea.emocion } });
  setIfExists("Score viral", { number: clampNumber(idea.score_viral, 1, 10, 7) });

  // Fecha de creación del item (siempre válida)
  setDateIfValid("Fecha", new Date().toISOString());

  setIfExists("Resumen", { rich_text: [{ text: { content: truncate(idea.resumen) } }] });
  setIfExists("Gancho", { rich_text: [{ text: { content: truncate(idea.gancho) } }] });
  setIfExists("Por qué tiene potencial", {
    rich_text: [{ text: { content: truncate(idea.por_que_tiene_potencial) } }]
  });
  setIfExists("Idea Short", { rich_text: [{ text: { content: truncate(idea.idea_short) } }] });

  // PRO
  setIfExists("Título SEO", {
    rich_text: [{ text: { content: truncate(idea.titulo_seo, 500) } }]
  });
  setIfExists("Guion 60s", { rich_text: [{ text: { content: truncate(idea.guion_60s) } }] });
  setIfExists("Guion 8 min", { rich_text: [{ text: { content: truncate(idea.guion_8min) } }] });

  // Nuevas
  setIfExists("Link", { url: idea.link || null });
  setIfExists("Fuente", { rich_text: [{ text: { content: truncate(idea.fuente, 300) } }] });

  // ✅ FIX REAL: no se setea si viene vacío (evita start:null)
  setDateIfValid("Fecha anuncio", idea.fecha_anuncio);

  // Campos de tu DB
  setIfExists("Tipo de juego", { select: { name: idea.tipo_de_juego } });
  setIfExists("Estado lanzamiento", { select: { name: idea.estado_lanzamiento } });
  setIfExists("Año", { number: idea.ano ?? null });

  return notion.pages.create({
    parent: { database_id: NOTION_DB },
    properties: props
  });
}

async function main() {
  console.log(`RSS: buscando anuncios de los últimos ${DAYS} días...`);
  const items = await fetchRecentRssItems();

  if (!items.length) {
    console.log(
      "No se encontraron items recientes en RSS con keywords. (Sube RSS_DAYS o añade RSS_URLS)"
    );
    return;
  }

  const feedBlock = items
    .map((x, i) => {
      return `${i + 1}) [${x.date}] (${x.source}) ${x.title}\nLINK: ${x.link}\nSNIP: ${x.snippet}`;
    })
    .join("\n\n");

  const PROMPT = `
Eres un analista de tendencias gaming para YouTube (España).
Te paso noticias RSS recientes (últimos ${DAYS} días). Tu tarea es elegir los MEJORES candidatos para contenido.

OBJETIVO:
- Devuelve 3 "ideas" + 3 "backups".
- Deben ser juegos actuales o próximos (anuncio, demo, playtest, early access, beta, MMO, live service).
- Priorización: potencial de repercusión/hype/debate + facilidad de explicarlo + novedad.

REGLAS:
- No inventes: si el feed no confirma algo, no lo afirmes como hecho.
- Elige preferentemente items con LINK claro a la fuente.
- Si hay MMOs prometedores en la lista, incluye al menos 1 entre ideas/backups (siempre que sea relevante).
- Score_viral 1-10: novedad + hype + gancho + facilidad de narrar.

CAMPOS IMPORTANTES (NO INVENTAR):
- "estado_lanzamiento" debe ser UNO de: Recién lanzado | Demo disponible | Early Access | Próximo lanzamiento | Anunciado
- "tipo_de_juego" debe ser UNO de: Live Service | Otro | Sandbox | Estrategia | Simulador | RPG | Roguelike | MMO | AA | Indie
- "ano" (Año) si NO se conoce por la noticia, pon null.
- "fecha_anuncio": si no está clara, pon "" (vacío). No inventes.

DEVUELVE SOLO JSON válido (sin markdown, sin texto extra) con este formato EXACTO:

{
  "ideas": [
    {
      "juego": "",
      "tipo": "Historia|Short|Ambos",
      "popularidad": "Muy poco conocido|Nicho",
      "tipo_de_juego": "Live Service|Otro|Sandbox|Estrategia|Simulador|RPG|Roguelike|MMO|AA|Indie",
      "estado_lanzamiento": "Recién lanzado|Demo disponible|Early Access|Próximo lanzamiento|Anunciado",
      "ano": null,
      "resumen": "",
      "gancho": "",
      "por_que_tiene_potencial": "",
      "idea_short": "",
      "emocion": "Misterio|Tragedia|Shock|Terror|Nostalgia|Asombro",
      "score_viral": 1,
      "titulo_seo": "",
      "guion_60s": "",
      "guion_8min": "",
      "fuente": "",
      "link": "",
      "fecha_anuncio": ""
    }
  ],
  "backups": [
    {
      "juego": "",
      "tipo": "Historia|Short|Ambos",
      "popularidad": "Muy poco conocido|Nicho",
      "tipo_de_juego": "Live Service|Otro|Sandbox|Estrategia|Simulador|RPG|Roguelike|MMO|AA|Indie",
      "estado_lanzamiento": "Recién lanzado|Demo disponible|Early Access|Próximo lanzamiento|Anunciado",
      "ano": null,
      "resumen": "",
      "gancho": "",
      "por_que_tiene_potencial": "",
      "idea_short": "",
      "emocion": "Misterio|Tragedia|Shock|Terror|Nostalgia|Asombro",
      "score_viral": 1,
      "titulo_seo": "",
      "guion_60s": "",
      "guion_8min": "",
      "fuente": "",
      "link": "",
      "fecha_anuncio": ""
    }
  ]
}

NOTICIAS RSS:
${feedBlock}
`.trim();

  console.log("Generando selección con IA...");
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: PROMPT }],
    temperature: 0.6
  });

  const content = (resp.choices?.[0]?.message?.content || "").trim();
  const data = safeJsonParse(content);

  const ideas = Array.isArray(data?.ideas) ? data.ideas : [];
  const backups = Array.isArray(data?.backups) ? data.backups : [];
  const merged = [...ideas, ...backups].slice(0, 6);

  if (!merged.length) {
    console.error("La IA no devolvió ideas en el formato esperado.");
    console.log("RAW:", content);
    process.exit(1);
  }

  const allowedTipo = ["Historia", "Short", "Ambos"];
  const allowedPop = ["Muy poco conocido", "Nicho"];
  const allowedEmo = ["Misterio", "Tragedia", "Shock", "Terror", "Nostalgia", "Asombro"];

  const allowedEstadoLanzamiento = [
    "Recién lanzado",
    "Demo disponible",
    "Early Access",
    "Próximo lanzamiento",
    "Anunciado"
  ];

  const allowedTipoJuego = [
    "Live Service",
    "Otro",
    "Sandbox",
    "Estrategia",
    "Simulador",
    "RPG",
    "Roguelike",
    "MMO",
    "AA",
    "Indie"
  ];

  const cleaned = merged
    .map((x) => ({
      juego: (x.juego || "").toString().trim(),
      tipo: ensureOneOf(x.tipo, allowedTipo, "Ambos"),
      popularidad: ensureOneOf(x.popularidad, allowedPop, "Nicho"),
      emocion: ensureOneOf(x.emocion, allowedEmo, "Asombro"),
      score_viral: clampNumber(x.score_viral, 1, 10, 7),

      estado_lanzamiento: ensureOneOf(
        (x.estado_lanzamiento || "").toString().trim(),
        allowedEstadoLanzamiento,
        "Anunciado"
      ),
      tipo_de_juego: ensureOneOf(
        (x.tipo_de_juego || "").toString().trim(),
        allowedTipoJuego,
        "Otro"
      ),
      ano:
        x.ano === null || x.ano === undefined || x.ano === ""
          ? null
          : clampNumber(x.ano, 1980, 2100, null),

      resumen: (x.resumen || "").toString().trim(),
      gancho: (x.gancho || "").toString().trim(),
      por_que_tiene_potencial: (x.por_que_tiene_potencial || "").toString().trim(),
      idea_short: (x.idea_short || "").toString().trim(),
      titulo_seo: (x.titulo_seo || "").toString().trim(),
      guion_60s: (x.guion_60s || "").toString().trim(),
      guion_8min: (x.guion_8min || "").toString().trim(),
      fuente: (x.fuente || "").toString().trim(),
      link: (x.link || "").toString().trim(),
      fecha_anuncio: (x.fecha_anuncio || "").toString().trim()
    }))
    .filter((x) => x.juego);

  const dbProps = await getDatabasePropertyNames();

  console.log(`Guardando ${cleaned.length} items en Notion...`);
  for (const idea of cleaned) {
    await createNotionItem(idea, dbProps);
    console.log("✅ Guardada:", idea.juego);
  }

  console.log("Hecho.");
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
