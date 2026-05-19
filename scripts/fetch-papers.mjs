import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const PUBMED_SEARCH =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const PUBMED_FETCH =
  "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

const FETCH_DAYS = Number.parseInt(process.env.FETCH_DAYS || "7", 10);
const FETCH_MAX = Number.parseInt(process.env.FETCH_MAX || "40", 10);
const OUTPUT = resolve("papers.json");

const JOURNALS = [
  "International Journal of Eating Disorders",
  "Eating Behaviors",
  "European Eating Disorders Review",
  "Journal of Eating Disorders",
  "Appetite",
  "Behaviour Research and Therapy",
  "Journal of Anxiety Disorders",
  "Clinical Psychology Review",
  "Journal of Clinical Child & Adolescent Psychology",
  "Child Psychiatry & Human Development",
  "Journal of Child Psychology and Psychiatry",
  "Frontiers in Psychiatry",
  "Journal of Pediatric Gastroenterology and Nutrition",
  "The Journal of Pediatrics",
  "Pediatrics",
  "Journal of Pediatric Psychology",
  "Neuroscience & Biobehavioral Reviews",
  "Behavioral Neuroscience",
  "Learning & Memory",
  "Neurobiology of Learning and Memory",
  "Frontiers in Behavioral Neuroscience",
  "Chemical Senses",
  "Physiology & Behavior",
  "Hormones and Behavior",
  "Journal of Autism and Developmental Disorders",
  "Autism",
  "Autism Research",
  "Journal of Sensory Studies",
  "Food Quality and Preference",
  "Obstetrics & Gynecology",
  "American Journal of Obstetrics & Gynecology",
  "BMC Pregnancy and Childbirth",
  "Supportive Care in Cancer",
  "Psycho-Oncology",
  "Nutrients",
  "Journal of the Academy of Nutrition and Dietetics",
  "Public Health Nutrition",
  "Frontiers in Nutrition",
  "PLOS ONE",
  "Scientific Reports",
  "Frontiers in Psychology",
  "Frontiers in Pediatrics",
  "JAMA Network Open",
  "BMJ Open",
  "BMC Medicine",
];

const SEARCH_TERMS = [
  '"food aversion"[Title/Abstract]',
  '"food aversions"[Title/Abstract]',
  '"food avoidance"[Title/Abstract]',
  '"food refusal"[Title/Abstract]',
  '"oral aversion"[Title/Abstract]',
  '"taste aversion"[Title/Abstract]',
  '"odor aversion"[Title/Abstract]',
  '"texture aversion"[Title/Abstract]',
  '"avoidant restrictive food intake disorder"[Title/Abstract]',
  '"avoidant/restrictive food intake disorder"[Title/Abstract]',
  "ARFID[Title/Abstract]",
  '"conditioned taste aversion"[Title/Abstract]',
  '"learned taste aversion"[Title/Abstract]',
  '"food neophobia"[Title/Abstract]',
  '"picky eating"[Title/Abstract]',
  '"selective eating"[Title/Abstract]',
  '"food selectivity"[Title/Abstract]',
  '"sensory food aversion"[Title/Abstract]',
  '"pregnancy food aversion"[Title/Abstract]',
  '"nausea and vomiting of pregnancy"[Title/Abstract]',
  "hyperemesis gravidarum[Title/Abstract]",
  '"chemotherapy-induced taste aversion"[Title/Abstract]',
  "dysgeusia[Title/Abstract]",
  "emetophobia[Title/Abstract]",
  "phagophobia[Title/Abstract]",
  '"food disgust"[Title/Abstract]',
  "food taboo[Title/Abstract]",
];

function buildQuery(days) {
  const since = new Date(Date.now() - days * 86400000);
  const y = since.getFullYear();
  const m = String(since.getMonth() + 1).padStart(2, "0");
  const d = String(since.getDate()).padStart(2, "0");
  const datePart = `"${y}/${m}/${d}"[Date - Publication] : "3000"[Date - Publication]`;
  const termPart = SEARCH_TERMS.join(" OR ");
  return `(${termPart}) AND ${datePart}`;
}

async function searchPapers(query, retmax) {
  const url = new URL(PUBMED_SEARCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("term", query);
  url.searchParams.set("retmax", String(retmax));
  url.searchParams.set("sort", "date");
  url.searchParams.set("retmode", "json");
  try {
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "FoodAversionBot/1.0" },
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = new URL(PUBMED_FETCH);
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("id", pmids.join(","));
  url.searchParams.set("retmode", "xml");
  try {
    const resp = await fetch(url.toString(), {
      headers: { "User-Agent": "FoodAversionBot/1.0" },
      signal: AbortSignal.timeout(60000),
    });
    const xml = await resp.text();
    return parseXmlPapers(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXmlPapers(xml) {
  const papers = [];
  const articleRe =
    /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRe.exec(xml)) !== null) {
    const block = match[1];
    const title = extractXml(block, "ArticleTitle");
    const journal = extractXml(block, "Title");

    const abstractParts = [];
    const absRe =
      /<AbstractText[^>]*Label="([^"]*)"[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = absRe.exec(block)) !== null) {
      const label = absMatch[1];
      const text = absMatch[2].replace(/<[^>]+>/g, "").trim();
      if (text) abstractParts.push(label ? `${label}: ${text}` : text);
    }
    const abstractRawRe =
      /<AbstractText>([\s\S]*?)<\/AbstractText>/g;
    if (!abstractParts.length) {
      while ((absMatch = abstractRawRe.exec(block)) !== null) {
        const text = absMatch[1].replace(/<[^>]+>/g, "").trim();
        if (text) abstractParts.push(text);
      }
    }
    const abstract = abstractParts.join(" ").slice(0, 2000);

    const pmid = extractXml(block, "PMID");
    const url = pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
      : "";

    const year = extractXml(block, "Year");
    const month = extractXml(block, "Month");
    const day = extractXml(block, "Day");
    const dateStr = [year, month, day].filter(Boolean).join(" ");

    const keywords = [];
    const kwRe = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRe.exec(block)) !== null) {
      const kw = kwMatch[1].trim();
      if (kw) keywords.push(kw);
    }

    papers.push({
      pmid,
      title,
      journal,
      date: dateStr,
      abstract,
      url,
      keywords,
    });
  }
  return papers;
}

function extractXml(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = block.match(re);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : "";
}

function getTaipeiDate() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" })
  )
    .toISOString()
    .slice(0, 10);
}

async function main() {
  const query = buildQuery(FETCH_DAYS);
  console.error(
    `[INFO] Searching PubMed for food aversion papers (last ${FETCH_DAYS} days)...`
  );

  const pmids = await searchPapers(query, FETCH_MAX);
  console.error(`[INFO] Found ${pmids.length} papers`);

  if (!pmids.length) {
    const empty = { date: getTaipeiDate(), count: 0, papers: [] };
    writeFileSync(OUTPUT, JSON.stringify(empty, null, 2), "utf-8");
    console.error("[WARN] No papers found");
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const output = {
    date: getTaipeiDate(),
    count: papers.length,
    papers,
  };
  writeFileSync(OUTPUT, JSON.stringify(output, null, 2), "utf-8");
  console.error(`[INFO] Saved to ${OUTPUT}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  const empty = { date: getTaipeiDate(), count: 0, papers: [] };
  writeFileSync(OUTPUT, JSON.stringify(empty, null, 2), "utf-8");
});
