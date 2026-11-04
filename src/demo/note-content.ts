/**
 * Demo-only note content: the markdown a node's note shows when selected.
 *
 * The engine never sees this. Notes are composed from the taxonomy already in
 * the bundle, so the note for `Panthera leo` links to its genus, its sibling
 * species and the ranks above it — the same shape a real Obsidian vault has,
 * without shipping a second dataset.
 *
 * Compose on demand: a note is only ever needed for the one node the user
 * opened.
 */

import { ANIMAL_CLASSES, ANIMAL_SPECIES, ANIMAL_TAXA, type AnimalSpecies } from "./animal-data.ts";

const TAXA_BY_ID = new Map(ANIMAL_TAXA.map((taxon) => [taxon.id, taxon]));

const SPECIES_BY_GENUS = new Map<string, AnimalSpecies[]>();
for (const species of ANIMAL_SPECIES) {
  const bucket = SPECIES_BY_GENUS.get(species.genus);
  if (bucket) bucket.push(species);
  else SPECIES_BY_GENUS.set(species.genus, [species]);
}

/** Species sharing a genus, most notable first. */
function siblingSpecies(genus: string, exclude: string, limit = 8): AnimalSpecies[] {
  const family = SPECIES_BY_GENUS.get(genus) ?? [];
  return family
    .filter((entry) => entry.id !== exclude)
    .sort((a, b) => b.links - a.links)
    .slice(0, limit);
}

/** Ancestor chain by id, nearest first. */
function ancestorChain(id: string | null, limit = 7): { id: string; name: string }[] {
  const chain: { id: string; name: string }[] = [];
  let cursor = id;
  for (let guard = 0; cursor && guard < limit; guard += 1) {
    const taxon = TAXA_BY_ID.get(cursor);
    if (!taxon) break;
    chain.push({ id: taxon.id, name: taxon.name });
    cursor = taxon.parent;
  }
  return chain;
}

/** Children of a higher taxon, so a family note lists its genera. */
function childrenOf(id: string, limit = 12) {
  return ANIMAL_TAXA.filter((taxon) => taxon.parent === id).slice(0, limit);
}

/** Markdown block for a species note. */
function speciesNote(species: AnimalSpecies): string {
  const genus = TAXA_BY_ID.get(species.genus);
  const genusName = genus?.name ?? species.genus;
  const chain = ancestorChain(genus?.parent ?? null);
  const siblings = siblingSpecies(species.genus, species.id);
  const sections = [
    `# ${species.scientific}`,
    "",
    `> ${species.links} Wikipedia language editions · ${species.group}`,
    "",
    `**${species.scientific}** is a species in the genus [[${genusName}]].`,
    "",
    "## Classification",
    "",
    `- Genus: [[${genusName}]]`,
    ...chain.map((entry) => `- ${entry.name}`),
    "",
  ];
  if (siblings.length) {
    sections.push(
      "## Related species",
      "",
      ...siblings.map((entry) => `- [[${entry.scientific}]]`),
      "",
    );
  }
  sections.push(
    "## Notes",
    "",
    `Species rank reached through the ${species.group.toLowerCase()} sample. ` +
      "Notability is measured by how many language editions of Wikipedia carry " +
      `this article, currently **${species.links}**.`,
    "",
    "```",
    `wikidata: ${species.id}`,
    `genus:    ${species.genus}`,
    "```",
  );
  return sections.join("\n");
}

/** Markdown block for a non-species node. */
function taxonNote(id: string, label: string): string {
  const taxon = TAXA_BY_ID.get(id);
  if (!taxon) return `# ${label}\n\nNo note content for \`${id}\`.\n`;
  const children = childrenOf(taxon.id);
  // A genus owns species directly, so list them; without this a genus note is
  // a dead end even though its species are the interesting part.
  const speciesChildren =
    taxon.rank === "genus"
      ? (SPECIES_BY_GENUS.get(taxon.id) ?? [])
          .slice()
          .sort((a, b) => b.links - a.links)
          .slice(0, 10)
      : [];
  const chain = ancestorChain(taxon.parent);
  const sections = [
    `# ${taxon.name}`,
    "",
    `> ${taxon.rank} · ${taxon.group || "shared trunk"}`,
    "",
    `**${taxon.name}** is a ${taxon.rank} in the ${taxon.group || "animal"} tree.`,
    "",
  ];
  if (speciesChildren.length) {
    sections.push(
      "## Species",
      "",
      ...speciesChildren.map((entry) => `- [[${entry.scientific}]]`),
      "",
    );
  }
  if (children.length) {
    sections.push(
      "## Contains",
      "",
      ...children.map((entry) => `- [[${entry.name}]] — *${entry.rank}*`),
      "",
    );
  }
  if (chain.length) {
    sections.push("## Classification", "", ...chain.map((entry) => `- ${entry.name}`), "");
  }
  sections.push(
    "## Notes",
    "",
    `Reached from the ${taxon.group || "shared"} sample. ` +
      "Unranked clades are kept where they carry an English Wikipedia article.",
    "",
    "```",
    `wikidata: ${taxon.id}`,
    `rank:     ${taxon.rank}`,
    "```",
  );
  return sections.join("\n");
}

/** Markdown for one node, keyed by the id the graph uses. */
export function noteFor(nodeId: string, label: string): string {
  const species = ANIMAL_SPECIES.find((entry) => entry.id === nodeId);
  return species ? speciesNote(species) : taxonNote(nodeId, label);
}

/**
 * Resolve a `[[wiki-link]]` target to a node id.
 *
 * Notes name taxa by display name, but the graph is keyed by QID, so this
 * lookup is what makes note links jump to the right node.
 */
export function resolveWikiLink(target: string): string | null {
  const wanted = target.trim().toLowerCase();
  if (!wanted) return null;
  const species = ANIMAL_SPECIES.find((entry) => entry.scientific.toLowerCase() === wanted);
  if (species) return species.id;
  const taxon = ANIMAL_TAXA.find((entry) => entry.name.toLowerCase() === wanted);
  if (taxon) return taxon.id;
  for (const [qid, name] of Object.entries(ANIMAL_CLASSES)) {
    if (name.toLowerCase() === wanted) return qid;
  }
  return null;
}
