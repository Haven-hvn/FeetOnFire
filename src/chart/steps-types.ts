// Steps types (GameManager.cpp g_StepsTypeInfos) and difficulties (Difficulty.cpp).

import { equalsNoCase, makeLower } from './text.ts';

export type StepsTypeCategory = 'Single' | 'Double' | 'Couple' | 'Routine';

export interface StepsTypeInfo {
  name: string;
  tracks: number;
  category: StepsTypeCategory;
}

const TABLE: readonly (readonly [string, number, StepsTypeCategory])[] = [
  ['dance-single', 4, 'Single'],
  ['dance-double', 8, 'Double'],
  ['dance-couple', 8, 'Couple'],
  ['dance-solo', 6, 'Single'],
  ['dance-threepanel', 3, 'Single'],
  ['dance-routine', 8, 'Routine'],
  ['pump-single', 5, 'Single'],
  ['pump-halfdouble', 6, 'Double'],
  ['pump-double', 10, 'Double'],
  ['pump-couple', 10, 'Couple'],
  ['pump-routine', 10, 'Routine'],
  ['kb7-single', 7, 'Single'],
  ['kb7-small', 7, 'Single'],
  ['ez2-single', 5, 'Single'],
  ['ez2-double', 10, 'Double'],
  ['ez2-real', 7, 'Single'],
  ['para-single', 5, 'Single'],
  ['ds3ddx-single', 8, 'Single'],
  ['bm-single5', 6, 'Single'],
  ['bm-versus5', 6, 'Single'],
  ['bm-double5', 12, 'Double'],
  ['bm-single7', 8, 'Single'],
  ['bm-versus7', 8, 'Single'],
  ['bm-double7', 16, 'Double'],
  ['maniax-single', 4, 'Single'],
  ['maniax-double', 8, 'Double'],
  ['techno-single4', 4, 'Single'],
  ['techno-single5', 5, 'Single'],
  ['techno-single8', 8, 'Single'],
  ['techno-double4', 8, 'Double'],
  ['techno-double5', 10, 'Double'],
  ['techno-double8', 16, 'Double'],
  ['pnm-five', 5, 'Single'],
  ['pnm-nine', 9, 'Single'],
  ['lights-cabinet', 6, 'Single'],
  ['kickbox-human', 4, 'Single'],
  ['kickbox-quadarm', 4, 'Single'],
  ['kickbox-insect', 6, 'Single'],
  ['kickbox-arachnid', 8, 'Single'],
];

const BY_NAME = new Map<string, StepsTypeInfo>(
  TABLE.map(([name, tracks, category]) => [name, { name, tracks, category }]),
);

/** GameManager::StringToStepsType: lower-cased exact match; null for an unknown type. */
export function stringToStepsType(s: string): StepsTypeInfo | null {
  return BY_NAME.get(makeLower(s)) ?? null;
}

export const DIFFICULTIES = ['Beginner', 'Easy', 'Medium', 'Hard', 'Challenge', 'Edit'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** StringToDifficulty: case-insensitive match on the names; null when it is none of them. */
export function stringToDifficulty(s: string): Difficulty | null {
  for (const d of DIFFICULTIES) {
    if (equalsNoCase(s, d)) return d;
  }
  return null;
}

const OLD_STYLE: Readonly<Record<string, Difficulty>> = {
  beginner: 'Beginner',
  easy: 'Easy',
  basic: 'Easy',
  light: 'Easy',
  medium: 'Medium',
  another: 'Medium',
  trick: 'Medium',
  standard: 'Medium',
  difficult: 'Medium',
  hard: 'Hard',
  ssr: 'Hard',
  maniac: 'Hard',
  heavy: 'Hard',
  smaniac: 'Challenge',
  challenge: 'Challenge',
  expert: 'Challenge',
  oni: 'Challenge',
  edit: 'Edit',
};

/** OldStyleStringToDifficulty: the names older .sm files use. */
export function oldStyleStringToDifficulty(s: string): Difficulty | null {
  const key = makeLower(s);
  return Object.hasOwn(OLD_STYLE, key) ? OLD_STYLE[key]! : null;
}
