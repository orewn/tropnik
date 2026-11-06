import type {Trail} from '../../lib/content';
/** Reference routes come from content.ts. No production database snapshot is embedded. */
export async function getPublishedTrails(): Promise<Trail[]> {return [];}
export async function getPublishedTrail(_id: string): Promise<Trail | undefined> {return undefined;}
