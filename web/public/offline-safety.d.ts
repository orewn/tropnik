export const LOCAL_SAFETY_KEY: string;
export const EMERGENCY_CARD_KEY: string;
export const MAX_SAFETY_STORAGE_LENGTH: number;
export function parseOfflineSafety(localRaw: string | null, serverRaw: string | null): Array<{id:string;recordId:string;source:'local'|'server';title:string;savedAt:string;notice:string;facts:string[][];message:string}>;
export function saveLocalSafetyPassports(storage: Pick<Storage,'setItem'>, passports: readonly unknown[]): void;
export function saveOfflineEmergencyCard(storage: Pick<Storage,'getItem'|'setItem'>, card: unknown, now?: Date): void;
