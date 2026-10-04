/**
 * Clé de rapprochement d'une entreprise entre sources : nom sans accents, casse,
 * ponctuation ni forme juridique (« Alan SAS » et « alan » donnent la même clé).
 */
export function companyKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(sas|sasu|sarl|sa|inc|ltd|gmbh|group|groupe|france)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}
