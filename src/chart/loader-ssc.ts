// The .ssc loader. Port of NotesLoaderSSC.cpp (SSCLoader::LoadFromSimfile and what it calls).
//
// Not ported: backgrounds, foreground changes, keysounds, attacks, instrument tracks and the
// tags that only matter in StepMania's song cache. Those tags are accepted and ignored.

import { cString, formatF, stringToFloat, stringToInt, type WarnFn } from './cnum.ts';
import { beatToNoteRow, f32 } from './f32.ts';
import {
  LoadContext,
  processDelays,
  processFakes,
  processSpeeds,
  processTickcounts,
  processTimeSignatures,
  setSelectable,
  setSongDisplayBpm,
} from './loader-sm.ts';
import { param } from './msd.ts';
import { DISPLAY_BPM_RANDOM, DISPLAY_BPM_SPECIFIED, Song, Steps, STEPFILE_VERSION } from './song.ts';
import { stringToDifficulty, stringToStepsType } from './steps-types.ts';
import { hhmmssToSeconds, makeUpper, split, trim, trimRight } from './text.ts';
import { bpmSegment, rangeSegment, TimingData } from './timing.ts';

/** From this file version on, a chart can have timing of its own. */
const VERSION_SPLIT_TIMING = f32(0.7);
/** Before this file version, #DESCRIPTION held what is now the chart name. */
const VERSION_CHART_NAME_TAG = f32(0.74);

function invalidPair(ctx: LoadContext, tag: string, expression: string): void {
  ctx.titleLog(`has an invalid #${tag} value "${cString(expression)}" (must have exactly one '='), ignored.`);
}

function processBpms(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'BPMS', expression);
      continue;
    }
    const beat = stringToFloat(values[0]!);
    const bpm = stringToFloat(values[1]!);
    if (beat >= 0 && bpm > 0) out.addBpm(bpmSegment(beatToNoteRow(beat), bpm));
    else ctx.titleLog(`has an invalid BPM at beat ${formatF(beat)}, BPM ${formatF(bpm)}.`);
  }
}

function processStops(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'STOPS', expression);
      continue;
    }
    const beat = stringToFloat(values[0]!);
    const seconds = stringToFloat(values[1]!);
    if (beat >= 0 && seconds > 0) out.addStop({ row: beatToNoteRow(beat), seconds });
    else ctx.titleLog(`has an invalid Stop at beat ${formatF(beat)}, length ${formatF(seconds)}.`);
  }
}

function processWarps(ctx: LoadContext, out: TimingData, line: string, version: number): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'WARPS', expression);
      continue;
    }
    const beat = stringToFloat(values[0]!);
    const newBeat = stringToFloat(values[1]!);
    // Early files gave the beat to jump to; later ones give the length of the jump.
    if (version < VERSION_SPLIT_TIMING && newBeat > beat) {
      out.addWarp(rangeSegment(beatToNoteRow(beat), f32(newBeat - beat)));
    } else if (newBeat > 0) {
      out.addWarp(rangeSegment(beatToNoteRow(beat), newBeat));
    } else {
      ctx.titleLog(`has an invalid Warp at beat ${formatF(beat)}, BPM ${formatF(newBeat)}.`);
    }
  }
}

function processLabels(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'LABELS', expression);
      continue;
    }
    const beat = stringToFloat(values[0]!);
    const label = trimRight(values[1]!);
    if (beat >= 0) out.addLabel({ row: beatToNoteRow(beat), label });
    else ctx.titleLog(`has an invalid Label at beat ${formatF(beat)} called ${cString(label)}.`);
  }
}

function processCombos(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length < 2) {
      ctx.titleLog(`has an invalid #COMBOS value "${cString(expression)}" (must have at least one '='), ignored.`);
      continue;
    }
    const beat = stringToFloat(values[0]!);
    const combo = stringToInt(values[1]!, ctx.warn);
    const missCombo = values.length === 2 ? combo : stringToInt(values[2]!, ctx.warn);
    out.addCombo({ row: beatToNoteRow(beat), combo, missCombo });
  }
}

function processScrolls(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length < 2) {
      ctx.titleLog(`has an scroll change with ${values.length} values.`);
      continue;
    }
    const beat = stringToFloat(values[0]!);
    const ratio = stringToFloat(values[1]!);
    if (beat < 0) {
      ctx.titleLog(`has an scroll change with beat ${formatF(beat)}.`);
      continue;
    }
    out.addScroll({ row: beatToNoteRow(beat), ratio });
  }
}

/**
 * The timing tags, which a song and (from version 0.7) a chart can both have.
 * Returns false when the tag is not one of them.
 */
function timingTag(ctx: LoadContext, timing: TimingData, name: string, value: string, version: number): boolean {
  switch (name) {
    case 'BPMS':
      processBpms(ctx, timing, value);
      return true;
    case 'STOPS':
      processStops(ctx, timing, value);
      return true;
    case 'DELAYS':
      processDelays(ctx, timing, value);
      return true;
    case 'WARPS':
      processWarps(ctx, timing, value, version);
      return true;
    case 'LABELS':
      processLabels(ctx, timing, value);
      return true;
    case 'TIMESIGNATURES':
      processTimeSignatures(ctx, timing, value);
      return true;
    case 'TICKCOUNTS':
      processTickcounts(ctx, timing, value);
      return true;
    case 'COMBOS':
      processCombos(ctx, timing, value);
      return true;
    case 'SPEEDS':
      processSpeeds(ctx, timing, value);
      return true;
    case 'SCROLLS':
      processScrolls(ctx, timing, value);
      return true;
    case 'FAKES':
      processFakes(ctx, timing, value);
      return true;
    case 'OFFSET':
      timing.beat0OffsetSeconds = stringToFloat(value);
      return true;
    default:
      return false;
  }
}

function songTag(ctx: LoadContext, song: Song, name: string, params: readonly string[]): void {
  const p1 = param(params, 1);
  switch (name) {
    case 'VERSION':
      song.version = stringToFloat(p1);
      break;
    case 'TITLE':
      song.title = p1;
      ctx.songTitle = p1;
      break;
    case 'SUBTITLE':
      song.subtitle = p1;
      break;
    case 'ARTIST':
      song.artist = p1;
      break;
    case 'TITLETRANSLIT':
      song.titleTranslit = p1;
      break;
    case 'SUBTITLETRANSLIT':
      song.subtitleTranslit = p1;
      break;
    case 'ARTISTTRANSLIT':
      song.artistTranslit = p1;
      break;
    case 'GENRE':
      song.genre = p1;
      break;
    case 'ORIGIN':
      song.origin = p1;
      break;
    case 'CREDIT':
      song.credit = trim(p1);
      break;
    case 'BANNER':
      song.banner = p1;
      break;
    case 'BACKGROUND':
      song.background = p1;
      break;
    case 'JACKET':
      song.jacket = p1;
      break;
    case 'LYRICSPATH':
      song.lyricsPath = p1;
      break;
    case 'CDTITLE':
      song.cdTitle = p1;
      break;
    case 'MUSIC':
      song.music = p1;
      break;
    case 'PREVIEW':
      song.preview = p1;
      break;
    case 'SAMPLESTART':
      song.sampleStartSeconds = hhmmssToSeconds(p1, ctx.warn);
      break;
    case 'SAMPLELENGTH':
      song.sampleLengthSeconds = hhmmssToSeconds(p1, ctx.warn);
      break;
    case 'DISPLAYBPM':
      setSongDisplayBpm(song, params);
      break;
    case 'SELECTABLE':
      setSelectable(ctx, song, p1);
      break;
    default:
      // Everything else a song can have is either timing or not ported.
      timingTag(ctx, song.timing, name, p1, song.version);
      break;
  }
}

/** Returns false when the tag is not one a chart can have. */
function stepsTag(ctx: LoadContext, song: Song, steps: Steps, name: string, params: readonly string[]): boolean {
  const p1 = param(params, 1);
  switch (name) {
    case 'VERSION':
      song.version = stringToFloat(p1);
      return true;
    case 'CHARTNAME':
      steps.chartName = trim(p1);
      return true;
    case 'STEPSTYPE':
      steps.stepsType = stringToStepsType(p1);
      steps.stepsTypeStr = p1;
      return true;
    case 'CHARTSTYLE':
      steps.chartStyle = p1;
      return true;
    case 'DESCRIPTION': {
      const text = trim(p1);
      if (song.version < VERSION_CHART_NAME_TAG) steps.chartName = text;
      else steps.setDescription(text);
      return true;
    }
    case 'DIFFICULTY':
      steps.setDifficulty(stringToDifficulty(p1));
      return true;
    case 'METER':
      steps.meter = stringToInt(p1, ctx.warn);
      return true;
    case 'CREDIT':
      steps.credit = p1;
      return true;
    case 'MUSIC':
      steps.music = p1;
      return true;
    case 'DISPLAYBPM':
      if (p1 === '*') {
        steps.displayBpmType = DISPLAY_BPM_RANDOM;
      } else if (p1 !== '') {
        steps.displayBpmType = DISPLAY_BPM_SPECIFIED;
        steps.displayBpmMin = stringToFloat(p1);
        const p2 = param(params, 2);
        steps.displayBpmMax = p2 === '' ? steps.displayBpmMin : stringToFloat(p2);
      }
      return true;
    case 'RADARVALUES': // recomputed rather than read
    case 'ATTACKS': // not ported
      return true;
    default:
      return false;
  }
}

const STEPS_TIMING_TAGS = new Set([
  'BPMS',
  'STOPS',
  'DELAYS',
  'TIMESIGNATURES',
  'TICKCOUNTS',
  'COMBOS',
  'WARPS',
  'SPEEDS',
  'SCROLLS',
  'FAKES',
  'LABELS',
  'OFFSET',
]);

/** SSCLoader::LoadFromSimfile. `path` is only used in warnings. */
export function loadSsc(values: readonly (readonly string[])[], path: string, warn: WarnFn): Song {
  const ctx = new LoadContext(path, warn);
  const song = new Song();
  song.timing.file = path;
  song.fileName = path;

  // Between #NOTEDATA and #NOTES the tags belong to a chart.
  let steps: Steps | null = null;
  let stepsTiming = new TimingData();
  let hasOwnTiming = false;

  for (const params of values) {
    const name = makeUpper(param(params, 0));

    if (steps === null) {
      if (name === 'NOTEDATA') {
        steps = new Steps();
        stepsTiming = new TimingData(song.timing.beat0OffsetSeconds);
        hasOwnTiming = false;
      } else {
        songTag(ctx, song, name, params);
      }
      continue;
    }

    if (stepsTag(ctx, song, steps, name, params)) continue;

    if (STEPS_TIMING_TAGS.has(name)) {
      // Older files repeat the song's timing in each chart; it is not the chart's own.
      if (song.version >= VERSION_SPLIT_TIMING) {
        timingTag(ctx, stepsTiming, name, param(params, 1), song.version);
        hasOwnTiming = true;
      }
      continue;
    }

    if (name === 'NOTES' || name === 'NOTES2') {
      if (hasOwnTiming) steps.timing = stepsTiming.copy(); // a C++ assignment: see copy()
      steps.noteText = param(params, 1);
      steps.tidyUp(song.fileName, warn);
      steps.filename = path;
      song.addSteps(steps);
      steps = null;
    } else if (name === 'STEPFILENAME') {
      // The notes are in another file (StepMania's cache does this). Kept without notes.
      if (hasOwnTiming) steps.timing = stepsTiming.copy(); // a C++ assignment: see copy()
      steps.filename = param(params, 1);
      song.addSteps(steps);
      steps = null;
    }
    // Any other tag inside a chart is ignored; a chart without #NOTES is dropped.
  }

  song.version = STEPFILE_VERSION;
  return song;
}
