import type {Trail} from '../../lib/content';
/** Reference routes come from content.ts. No production database snapshot is embedded. */
export async function getPublishedTrails(): Promise<Trail[]> {return [];}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- The static adapter keeps the server signature without embedding private database data.
export async function getPublishedTrail(_id: string): Promise<Trail | undefined> {return undefined;}
