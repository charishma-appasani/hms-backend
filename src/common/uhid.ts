/** "UH{seq:08}" → "UH00000001". Supports an optional zero-pad width. */
export function formatUhid(format: string, seq: bigint): string {
  return format.replace(/\{seq(?::0(\d+))?\}/, (_m, pad?: string) =>
    pad ? String(seq).padStart(Number(pad), '0') : String(seq),
  );
}

/** Default org UHID format when none is configured. */
export const DEFAULT_UHID_FORMAT = 'UH{seq:08}';
