/**
 * The scope every fixture read and write stays inside.
 *
 * It lives on its own so the reads, the posting setup and the seed can all name it without
 * importing one another. Nothing here is optional except the actor: a fixture run that could
 * not name its tenant and organization would be a fixture run that writes wherever it lands.
 */
export type PzFixtureScope = {
  tenantId: string
  organizationId: string
  userId?: string | null
}
