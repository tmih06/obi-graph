/**
 * Regenerates `src/demo/animal-data.ts` from Wikidata.
 *
 *   bun scripts/fetch-taxonomy.ts
 *
 * The demo graph is real Wikipedia data, not invented fixtures: animal species
 * come from Wikidata (P31 taxon, P105 rank, P171 parent taxon) and every one
 * has an English Wikipedia article. Species are ranked by how many Wikipedia
 * language editions carry them, so the demo shows recognisable animals.
 *
 * The demo draws a readable tree, so the crawl keeps only the ranks below and
 * re-parents each taxon to its nearest kept ancestor: species → genus →
 * family → order → class. Intermediate clades are skipped.
 *
 * Output is a plain module, so the demo works offline and its node count never
 * drifts between builds.
 */

const ENDPOINT = "https://qlever.dev/api/wikidata";

const PREFIXES = `PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX schema: <http://schema.org/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
`;

/**
 * Animal classes the demo samples. `exclude` drops species owned by another
 * sampled class: Wikidata treats birds as reptiles, so the reptile query has to
 * skip them or the aviary appears twice.
 */
const CLASSES = [
  { qid: "Q7377", label: "Mammals", species: 300, exclude: [] },
  { qid: "Q5113", label: "Birds", species: 300, exclude: [] },
  { qid: "Q10811", label: "Reptiles", species: 200, exclude: ["Q5113"] },
  { qid: "Q10908", label: "Amphibians", species: 140, exclude: [] },
  { qid: "Q127282", label: "Ray-finned fish", species: 220, exclude: [] },
  { qid: "Q1390", label: "Insects", species: 260, exclude: [] },
] as const;

const CLASS_LABEL: Record<string, string> = Object.fromEntries(
  CLASSES.map((entry) => [entry.qid, entry.label]),
);

/** Wikidata item for kingdom Animalia: the root every sampled class reaches. */
const ANIMALIA = "Q729";

/** Wikidata rank items (P105), kept in the sample. */
const KEPT_RANKS: Record<string, string> = {
  Q7432: "genus",
  Q34740: "genus",
  Q35409: "family",
  Q164280: "subfamily",
  Q36602: "order",
  Q37517: "class",
  // Ranks above class. The animal classes are separate trees in Wikidata until
  // their shared trunk, so keeping these is what joins the six clusters.
  Q38348: "phylum",
  Q1153785: "subphylum",
  Q5867051: "subclass",
  Q2136103: "superfamily",
  Q5868144: "superorder",
  Q5867959: "suborder",
};

interface Binding {
  value: string;
}

type Row = Record<string, Binding | undefined>;

async function query(body: string): Promise<Row[]> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt) await Bun.sleep(1500 * attempt);
    const response = await fetch(`${ENDPOINT}?query=${encodeURIComponent(PREFIXES + body)}`, {
      headers: { Accept: "application/sparql-results+json" },
    });
    const text = await response.text();
    // The public endpoint rate-limits bursts; the same query succeeds later.
    if (response.status === 429 || response.status >= 500) continue;
    let payload: { exception?: unknown; results?: { bindings: Row[] } };
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Wikidata returned ${response.status}: ${text.slice(0, 300)}`);
    }
    if (payload.exception) {
      throw new Error(
        typeof payload.exception === "string"
          ? payload.exception
          : JSON.stringify(payload.exception).slice(0, 500),
      );
    }
    return payload.results?.bindings ?? [];
  }
  throw new Error("Wikidata kept rate-limiting the taxonomy crawl; retry later.");
}

const value = (row: Row, key: string): string | undefined => row[key]?.value;
const qid = (row: Row, key: string): string | undefined => value(row, key)?.split("/").pop();

/** Notable species of one class, ordered by how many wikis carry them. */
async function fetchSpecies(
  classQid: string,
  exclude: readonly string[],
  wanted: number,
): Promise<Row[]> {
  const skip = exclude.map((id) => `FILTER NOT EXISTS { ?s wdt:P171+ wd:${id} }`).join(" ");
  return query(`SELECT ?s ?sci ?name ?desc ?genus ?links WHERE {
  ?s wdt:P31 wd:Q16521 ; wdt:P105 wd:Q7432 ; wdt:P171+ wd:${classQid} ;
     wdt:P225 ?sci ; wikibase:sitelinks ?links ; wdt:P171 ?genus .
  ?s rdfs:label ?name . FILTER(lang(?name)="en")
  ?s schema:description ?desc . FILTER(lang(?desc)="en")
  ?a schema:about ?s ; schema:isPartOf <https://en.wikipedia.org/> .
  ${skip}
} ORDER BY DESC(?links) ?s LIMIT ${wanted + 30}`);
}

/** Label, rank and parent for a chunk of taxon ids; labels stay optional. */
async function fetchTaxa(ids: string[]): Promise<Row[]> {
  const rows: Row[] = [];
  const CHUNK = 120;
  for (let index = 0; index < ids.length; index += CHUNK) {
    const values = ids
      .slice(index, index + CHUNK)
      .map((id) => `wd:${id}`)
      .join(" ");
    rows.push(
      ...(await query(`SELECT ?t ?tname ?trank ?parent ?article WHERE {
  VALUES ?t { ${values} }
  OPTIONAL { ?t rdfs:label ?tname . FILTER(lang(?tname)="en") }
  OPTIONAL { ?t wdt:P105 ?trank }
  OPTIONAL { ?t wdt:P171 ?parent }
  OPTIONAL { ?article schema:about ?t ; schema:isPartOf <https://en.wikipedia.org/> }
}`)),
    );
  }
  return rows;
}

interface Species {
  id: string;
  scientific: string;
  common: string;
  description: string;
  genus: string;
  links: number;
  group: string;
}

interface Taxon {
  id: string;
  name: string;
  rank: string;
  parent: string | null;
  group: string;
}

async function main() {
  const species: Species[] = [];
  const seenSpecies = new Set<string>();
  const genusGroup = new Map<string, string>();
  for (const animalClass of CLASSES) {
    let taken = 0;
    for (const row of await fetchSpecies(
      animalClass.qid,
      animalClass.exclude,
      animalClass.species,
    )) {
      const id = qid(row, "s");
      const scientific = value(row, "sci");
      const genus = qid(row, "genus");
      if (!id || !scientific || !genus || seenSpecies.has(id)) continue;
      seenSpecies.add(id);
      genusGroup.set(genus, animalClass.label);
      species.push({
        id,
        scientific,
        common: value(row, "name") ?? scientific,
        description: value(row, "desc") ?? "",
        genus,
        links: Number(value(row, "links") ?? 0),
        group: animalClass.label,
      });
      taken += 1;
      if (taken >= animalClass.species) break;
    }
    console.log(`${animalClass.label}: ${taken} species`);
  }

  // Crawl each genus up to its class. Every taxon on the way is recorded so the
  // sample can be re-parented later; unlabelled taxa are kept in the raw map
  // only, as stepping stones.
  interface RawTaxon {
    name?: string;
    rank?: string;
    parent: string | null;
    /** Enwiki article: named clades above class are usually only visible this way. */
    article?: boolean;
  }
  const raw = new Map<string, RawTaxon>();
  const visited = new Set<string>();
  let frontier = [...genusGroup.keys()];
  for (let depth = 0; depth < 60 && frontier.length; depth += 1) {
    // Keep walking past the sampled classes: their common ancestors are the
    // only real links between the six trees.
    const pending = frontier.filter((id) => !visited.has(id) && id !== ANIMALIA);
    if (!pending.length) break;
    for (const id of pending) visited.add(id);
    const parents = new Set<string>();
    for (const row of await fetchTaxa(pending)) {
      const id = qid(row, "t");
      if (!id) continue;
      const parent = qid(row, "parent") ?? null;
      const entry = raw.get(id) ?? { parent: null };
      entry.name ??= value(row, "tname");
      entry.rank ??= qid(row, "trank");
      entry.parent ||= parent;
      entry.article ||= value(row, "article") !== undefined;
      raw.set(id, entry);
      if (parent) parents.add(parent);
    }
    frontier = [...parents];
  }
  console.log(`crawled ${raw.size} taxa`);

  /**
   * The drawn ancestors of a taxon, nearest first, ending at Animalia.
   *
   * `nextKept` answers "which drawn taxon does this raw chain reach first";
   * repeating it from that taxon's own parent walks the whole trunk. Memoising
   * the per-taxon lookup matters because genera share families, families share
   * orders, and all of it shares one phylum.
   */
  const nearestKept = new Map<string, Taxon | null>();
  const nextKept = (id: string, group: string): Taxon | null => {
    if (nearestKept.has(id)) return nearestKept.get(id)!;
    const skipped: string[] = [];
    let cursor: string | null = id;
    let found: Taxon | null = null;
    for (let guard = 0; cursor && guard < 64; guard += 1) {
      if (nearestKept.has(cursor)) {
        found = nearestKept.get(cursor)!;
        break;
      }
      const classLabel = CLASS_LABEL[cursor];
      if (classLabel) {
        found = { id: cursor, name: classLabel, rank: "class", parent: null, group: classLabel };
        break;
      }
      if (cursor === ANIMALIA) {
        found = {
          id: cursor,
          name: raw.get(cursor)?.name ?? "Animalia",
          rank: "kingdom",
          parent: null,
          group: "",
        };
        break;
      }
      const entry = raw.get(cursor);
      const rank = entry?.rank ? KEPT_RANKS[entry.rank] : undefined;
      // Unranked clades (Chordata's children, amniote, Bilateria…) are the real
      // rungs between class and kingdom. Keep the notable ones so the six
      // clusters hang off a visible trunk instead of six spokes to Animalia.
      const clade = !rank && entry?.article && entry?.name ? "clade" : undefined;
      if ((rank || clade) && entry?.name) {
        // Above the sampled classes a taxon has no single group: it is the
        // shared bridge, so it keeps the neutral colour instead of borrowing a
        // class's.
        const shared =
          clade === "clade" || rank === "phylum" || rank === "subphylum" || rank === "kingdom";
        found = {
          id: cursor,
          name: entry.name,
          rank: clade ?? rank!,
          parent: null,
          group: shared ? "" : group,
        };
        break;
      }
      skipped.push(cursor);
      cursor = entry?.parent ?? null;
    }
    nearestKept.set(id, found);
    for (const skippedId of skipped) nearestKept.set(skippedId, found);
    return found;
  };

  // Each kept node is one instance, so two genera in one family share it.
  const kept = new Map<string, Taxon>();
  const adopt = (taxon: Taxon, group: string): Taxon => {
    const existing = kept.get(taxon.id);
    if (existing) {
      if (!existing.group && group) existing.group = group;
      return existing;
    }
    taxon.group ||= group;
    kept.set(taxon.id, taxon);
    return taxon;
  };

  /**
   * Link `taxon` to its drawn ancestors, all the way to Animalia.
   *
   * A sampled class is a *drawn* node but not the top of the raw chain: birds
   * route through Reptilia, and the mammal chain passes through several ranks
   * the sample does not draw. So after linking to an ancestor, the walk always
   * resumes from that taxon's own raw parent rather than stopping at it.
   */
  const linkAncestors = (taxon: Taxon, rawParent: string | null, group: string): void => {
    if (!rawParent) return;
    let child = taxon;
    let cursor: string | null = rawParent;
    for (let guard = 0; cursor && guard < 64; guard += 1) {
      const ancestor = nextKept(cursor, child.group || group);
      if (!ancestor || ancestor.id === child.id) return;
      const node = adopt(ancestor, ancestor.group || child.group || group);
      // Never let a class node re-parent itself onto a descendant's group.
      child.parent = node.id;
      if (node.id === ANIMALIA) return;
      const step: string | null = raw.get(node.id)?.parent ?? null;
      if (!step || step === cursor) return;
      cursor = step;
      child = node;
    }
  };

  for (const [genus, group] of genusGroup) {
    const genusEntry = raw.get(genus);
    const self = adopt(
      { id: genus, name: genusEntry?.name ?? genus, rank: "genus", parent: null, group },
      group,
    );
    linkAncestors(self, genusEntry?.parent ?? null, group);
  }

  const taxa = [...kept.values()];
  // A parent id that was dropped (an unlabelled clade) ends the chain here.
  for (const taxon of taxa) {
    if (taxon.parent && !kept.has(taxon.parent)) taxon.parent = null;
  }
  for (const taxon of taxa) {
    if (taxon.parent && kept.get(taxon.parent)!.id === taxon.id) taxon.parent = null;
  }

  // Species hide behind a binary search of their genus, so the drawn graph is
  // one tree per class rather than six disconnected clusters.
  const unreached = species.filter((entry) => !kept.has(entry.genus));

  const module = `/**
 * Animal taxonomy sampled from Wikidata (CC0), sourced from Wikipedia.
 *
 * Generated by \`bun scripts/fetch-taxonomy.ts\`; do not edit by hand. Every
 * entry is a real taxon: \`parent\` is Wikidata's P171 (parent taxon), \`links\`
 * counts the Wikipedia language editions carrying the species article, and
 * \`description\` is the short Wikipedia description.
 */

export interface AnimalSpecies {
  id: string;
  scientific: string;
  common: string;
  description: string;
  genus: string;
  links: number;
  group: string;
}

export interface AnimalTaxon {
  id: string;
  name: string;
  rank: string;
  parent: string | null;
  group: string;
}

export const ANIMAL_SPECIES: readonly AnimalSpecies[] = ${JSON.stringify(species)};

export const ANIMAL_TAXA: readonly AnimalTaxon[] = ${JSON.stringify(taxa)};

/** Sampled class QID → the group name shared by every taxon below it. */
export const ANIMAL_CLASSES: Readonly<Record<string, string>> = ${JSON.stringify(
    Object.fromEntries(CLASSES.map((entry) => [entry.qid, entry.label])),
    null,
    2,
  )};
`;
  await Bun.write(new URL("../src/demo/animal-data.ts", import.meta.url), module);
  const byRank = new Map<string, number>();
  for (const taxon of taxa) byRank.set(taxon.rank, (byRank.get(taxon.rank) ?? 0) + 1);
  console.log(
    `species ${species.length}, taxa ${taxa.length} (${[...byRank].map(([rank, count]) => `${rank} ${count}`).join(", ")}), nodes ${species.length + taxa.length}`,
  );
  if (unreached.length) console.log(`warning: ${unreached.length} species have no drawn genus`);
}

await main();
