/**
 * "First ID / first creation" (ADR 0009, §5, item 6), without dependencies, so the code that
 * composes deduplication keys can use it anywhere. A row never rehydrated has neither field and
 * is its own origin; a rehydrated one carries the pair written in its first cycle.
 */
type Origin = {
  _id: string;
  _creationTime: number;
  originId?: string;
  originCreationTime?: number;
};
export const firstId = (row: Origin) => row.originId ?? row._id;
/** The instant listings, ordering and pagination use, so a rehydrated row never shows as new. */
export const firstCreation = (row: Origin) => row.originCreationTime ?? row._creationTime;
/**
 * `originalId` of a public resource (ADR 0009, §6): the first ID, only on a rehydrated row, so a
 * receiver that deduplicates by ID recognizes the resource it already knows. Absent otherwise.
 */
export const originalId = (row: Origin): { originalId?: string } =>
  row.originId === undefined ? {} : { originalId: row.originId };
/**
 * The pair to write on the row the rehydration recreates from `archived`, the row as the package
 * carries it: in the first cycle its own `_id` and `_creationTime`; in a later one the pair it
 * already had, unchanged.
 */
export const originFor = (archived: Origin) => ({
  originId: firstId(archived),
  originCreationTime: firstCreation(archived),
});
