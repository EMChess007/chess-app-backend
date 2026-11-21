/**
 * The ONE place that knows the 2-player variant flags as a set: the wire keys (`isChess960`, ...), the room keys (`chess960`, ...), how a
 * payload becomes a flag record, and which combinations are impossible. Tournaments (tournaments.ts) use it so a tournament game is built
 * from exactly the same flags as a normal online game of that variant - no per-variant copy of the list.
 * Keep in step with the app's `OnlineVariantFlags` / `variantWireFlags` (src/logic/onlineVariants.ts).
 */

/** Wire key -> room key (the `RoomManager.createRoom` parameter). Order = the order the error message names a variant in. */
export const VARIANT_FLAGS = {
  isChess960: 'chess960',
  isKingOfTheHill: 'kingOfTheHill',
  isThreeCheck: 'threeCheck',
  isSetupChess: 'setupChess',
  isFogOfWar: 'fogOfWar',
  isGiveaway: 'giveaway',
  isAtomic: 'atomic',
  isDuckChess: 'duckChess',
  isSpellChess: 'spellChess',
  isHorde: 'horde',
  isRacingKings: 'racingKings',
  isTorpedo: 'torpedo',
  isKnightmate: 'knightmate',
  isCrazyhouse: 'crazyhouse',
} as const;

export type VariantWireKey = keyof typeof VARIANT_FLAGS;
export type VariantRoomKey = (typeof VARIANT_FLAGS)[VariantWireKey];
export type VariantWireFlags = Record<VariantWireKey, boolean>;
export type VariantRoomFlags = Record<VariantRoomKey, boolean>;

export const VARIANT_WIRE_KEYS = Object.keys(VARIANT_FLAGS) as VariantWireKey[];

/** Display name per wire key, for the "cannot be combined" message. Chess960 / KotH / 3-check combine with each other (not with the rest). */
const NAMES: Record<VariantWireKey, string> = {
  isChess960: 'Chess960',
  isKingOfTheHill: 'King of the Hill',
  isThreeCheck: '3-check',
  isSetupChess: 'Setup Chess',
  isFogOfWar: 'Fog of War',
  isGiveaway: 'Giveaway',
  isAtomic: 'Atomic',
  isDuckChess: 'Duck Chess',
  isSpellChess: 'Spell Chess',
  isHorde: 'Horde',
  isRacingKings: 'Racing Kings',
  isTorpedo: 'Torpedo',
  isKnightmate: 'Knightmate',
  isCrazyhouse: 'Crazyhouse',
};

/** The three classic flags that may be combined with one another; every other variant is exclusive. */
const COMBINABLE: ReadonlySet<VariantWireKey> = new Set<VariantWireKey>(['isChess960', 'isKingOfTheHill', 'isThreeCheck']);

/** A payload (anything a client sent) -> a strict boolean per wire key. */
export function variantWireFlagsFrom(payload: unknown): VariantWireFlags {
  const source = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
  const flags = {} as VariantWireFlags;
  for (const key of VARIANT_WIRE_KEYS) flags[key] = Boolean(source[key]);
  return flags;
}

/** Wire flags -> the room flags `createRoom` takes. */
export function roomFlagsFrom(wire: VariantWireFlags): VariantRoomFlags {
  const room = {} as VariantRoomFlags;
  for (const key of VARIANT_WIRE_KEYS) room[VARIANT_FLAGS[key]] = wire[key];
  return room;
}

/** null when the flag set is playable; otherwise the error text. An exclusive variant combined with ANY other flag is impossible. */
export function variantConflictError(wire: VariantWireFlags): string | null {
  const on = VARIANT_WIRE_KEYS.filter((key) => wire[key]);
  const exclusive = on.find((key) => !COMBINABLE.has(key));
  if (!exclusive || on.length < 2) return null;
  return `${NAMES[exclusive]} cannot be combined with another variant.`;
}

/** The active variant's display name, or null for a plain / combined-classic game. */
export function variantDisplayName(wire: VariantWireFlags): string | null {
  const exclusive = VARIANT_WIRE_KEYS.find((key) => wire[key] && !COMBINABLE.has(key));
  return exclusive ? NAMES[exclusive] : null;
}
