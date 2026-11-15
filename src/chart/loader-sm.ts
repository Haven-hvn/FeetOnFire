// The .sm loader. Port of NotesLoaderSM.cpp (SMLoader::LoadFromSimfile and what it calls).
//
// Not ported: backgrounds, foreground changes, keysounds, attacks and instrument tracks.
// Those tags are accepted and ignored, including the warnings they can produce.

import { atoi, cString, formatF, stringToFloat, stringToInt, type WarnFn } from './cnum.ts';
import { beatToNoteRow, f32, ROWS_PER_BEAT } from './f32.ts';
import { param } from './msd.ts';
import { DISPLAY_BPM_RANDOM, DISPLAY_BPM_SPECIFIED, Song, Steps } from './song.ts';
import { oldStyleStringToDifficulty, stringToStepsType } from './steps-types.ts';
import { equalsNoCase, hhmmssToSeconds, makeUpper, split, trim } from './text.ts';
import { bpmSegment, rangeSegment, SPEED_UNIT_BEATS, SPEED_UNIT_SECONDS, type TimeSignatureSegment, type TimingData } from './timing.ts';

/** What a loader carries around: where warnings go, and the names they mention. */
export class LoadContext {
  /** Path of the file, as the caller named it. */
  readonly path: string;
  readonly warn: WarnFn;
  /** The #TITLE read so far; most warnings name the song by it. */
  songTitle = '';

  constructor(path: string, warn: WarnFn) {
    this.path = path;
    this.warn = warn;
  }

  /** RageLog::UserLog("Song file", element, ...) */
  userLog(element: string, message: string): void {
    this.warn(`Song file "${cString(element)}" ${message}`);
  }

  /** A warning that names the song by its title. */
  titleLog(message: string): void {
    this.userLog(this.songTitle, message);
  }

  /** A warning that names the song by its file path. */
  pathLog(message: string): void {
    this.userLog(this.path, message);
  }
}

/** A BPM change or stop before conversion: [beat, value]. */
export type BeatValue = [beat: number, value: number];

/**
 * SMLoader::RowToBeat as .sm and .ssc call it (rowsPerBeat -1): a beat number. A value with
 * an `r` or `R` at either end is divided by -1, as in the original.
 */
export function rowToBeat(line: string): number {
  const stripped = trim(trim(line, 'r'), 'R');
  if (stripped !== line) return f32(stringToFloat(stripped) / -1);
  return stringToFloat(line);
}

function invalidPair(ctx: LoadContext, tag: string, expression: string): void {
  ctx.titleLog(`has an invalid #${tag} value "${cString(expression)}" (must have exactly one '='), ignored.`);
}

export function parseBpms(ctx: LoadContext, out: BeatValue[], line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'BPMs', expression);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const bpm = stringToFloat(values[1]!);
    if (bpm === 0) {
      ctx.titleLog('has a zero BPM; ignored.');
      continue;
    }
    out.push([beat, bpm]);
  }
}

export function parseStops(ctx: LoadContext, out: BeatValue[], line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'STOPS', expression);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const seconds = stringToFloat(values[1]!);
    if (seconds === 0) {
      ctx.titleLog('has a zero-length stop; ignored.');
      continue;
    }
    out.push([beat, seconds]);
  }
}

/** A BPM above this is treated like a negative one: the start of a warp. */
const FAST_BPM_WARP = 9999999;

const byBeat = (a: BeatValue, b: BeatValue): number => (a[0] < b[0] ? -1 : b[0] < a[0] ? 1 : 0);

/**
 * SMLoader::ProcessBPMsAndStops: turns the .sm BPM changes and stops into segments.
 * Negative BPMs and negative stops (which made old versions jump forward in the chart)
 * become warps.
 */
export function processBpmsAndStops(ctx: LoadContext, out: TimingData, bpms: BeatValue[], stops: BeatValue[]): void {
  // Current BPM (positive or negative).
  let bpm = 0;
  // Beat of the previous change.
  let prevBeat = 0;
  // Start and end beat of the warp being built; -1 when there is none.
  let warpStart = -1;
  let warpEnd = -1;
  // BPM before the warp started.
  let preWarpBpm = 0;
  // Seconds since the warp started; negative while still jumping.
  let timeOfs = 0;

  bpms.sort(byBeat);
  stops.sort(byBeat);

  // Stops before beat 0 only move the start of the song.
  let istop = 0;
  for (; istop < stops.length && stops[istop]![0] < 0; istop++) {
    out.beat0OffsetSeconds = f32(out.beat0OffsetSeconds - stops[istop]![1]);
  }

  // BPM changes up to beat 0: the last one is the starting BPM.
  let ibpm = 0;
  for (; ibpm < bpms.length && bpms[ibpm]![0] <= 0; ibpm++) {
    bpm = bpms[ibpm]![1];
    if (bpm < 0 && bpms[ibpm]![0] < 0) {
      ctx.titleLog('has a negative BPM prior to beat 0.  These cause problems; ignoring.');
    }
  }

  if (bpm === 0) {
    if (ibpm === bpms.length) {
      bpm = 60;
      ctx.titleLog('has no valid BPMs.  Defaulting to 60.');
    } else {
      // The original steps to the entry after the next change and uses that one's value, so
      // the next change itself is skipped. With only one change left it reads past the end
      // of the list (undefined behaviour); here that case uses the one change there is.
      const next = bpms[ibpm]![1];
      ibpm++;
      bpm = ibpm < bpms.length ? bpms[ibpm]![1] : next;
      ctx.titleLog('does not establish a BPM before beat 0.  Using the value from the next BPM change.');
    }
  }

  // A song that starts inside a warp gets its first BPM when the warp ends.
  if (bpm > 0 && bpm <= FAST_BPM_WARP) out.addBpm(bpmSegment(0, bpm));

  while (ibpm < bpms.length || istop < stops.length) {
    const changeIsBpm = istop === stops.length || (ibpm < bpms.length && bpms[ibpm]![0] <= stops[istop]![0]);
    const [beat, value] = changeIsBpm ? bpms[ibpm]! : stops[istop]!;

    if (bpm <= FAST_BPM_WARP) {
      timeOfs = f32(timeOfs + f32(f32(f32(beat - prevBeat) * 60) / bpm));
      if (warpStart >= 0 && bpm > 0 && timeOfs > 0) {
        // The warp ended between the previous change and this one.
        warpEnd = f32(beat - f32(f32(timeOfs * bpm) / 60));
        out.addWarp(rangeSegment(beatToNoteRow(warpStart), f32(warpEnd - warpStart)));
        if (bpm !== preWarpBpm) out.addBpm(bpmSegment(beatToNoteRow(warpStart), bpm));
        warpStart = -1;
      }
    }
    prevBeat = beat;

    if (changeIsBpm) {
      if (warpStart < 0 && (value < 0 || value > FAST_BPM_WARP)) {
        warpStart = beat;
        preWarpBpm = bpm;
        timeOfs = 0;
      } else if (warpStart < 0) {
        out.addBpm(bpmSegment(beatToNoteRow(beat), value));
      }
      bpm = value;
      ibpm++;
    } else {
      if (warpStart < 0 && value < 0) {
        warpStart = beat;
        preWarpBpm = bpm;
        timeOfs = value;
      } else if (warpStart < 0) {
        out.addStop({ row: beatToNoteRow(beat), seconds: value });
      } else {
        // A stop inside a warp shortens it.
        timeOfs = f32(timeOfs + value);
        if (value > 0 && timeOfs > 0) {
          warpEnd = beat;
          out.addWarp(rangeSegment(beatToNoteRow(warpStart), f32(warpEnd - warpStart)));
          out.addStop({ row: beatToNoteRow(beat), seconds: timeOfs });
          if (bpm < 0 || bpm > FAST_BPM_WARP) {
            // Still warping because of the BPM.
            warpStart = beat;
            timeOfs = 0;
          } else {
            if (bpm !== preWarpBpm) out.addBpm(bpmSegment(beatToNoteRow(warpStart), bpm));
            warpStart = -1;
          }
        }
      }
      istop++;
    }
  }

  // A warp still open at the end.
  if (warpStart >= 0) {
    if (bpm < 0 || bpm > FAST_BPM_WARP) warpEnd = f32(99999999);
    else warpEnd = f32(prevBeat - f32(f32(timeOfs * bpm) / 60));
    out.addWarp(rangeSegment(beatToNoteRow(warpStart), f32(warpEnd - warpStart)));
    if (bpm !== preWarpBpm) out.addBpm(bpmSegment(beatToNoteRow(warpStart), bpm));
  }
}

export function processDelays(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'DELAYS', expression);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const seconds = stringToFloat(values[1]!);
    if (seconds > 0) out.addDelay({ row: beatToNoteRow(beat), seconds });
    else ctx.titleLog(`has an invalid delay at beat ${formatF(beat)}, length ${formatF(seconds)}.`);
  }
}

export function processTimeSignatures(ctx: LoadContext, out: TimingData, line: string): void {
  const segments: TimeSignatureSegment[] = [];
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length < 3) {
      ctx.titleLog(`has an invalid time signature change with ${values.length} values.`);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const numerator = stringToInt(values[1]!, ctx.warn);
    const denominator = stringToInt(values[2]!, ctx.warn);
    if (beat < 0) {
      ctx.titleLog(`has an invalid time signature change with beat ${formatF(beat)}.`);
      continue;
    }
    if (numerator < 1) {
      ctx.titleLog(`has an invalid time signature change with beat ${formatF(beat)}, iNumerator ${numerator}.`);
      continue;
    }
    if (denominator < 1) {
      ctx.titleLog(`has an invalid time signature change with beat ${formatF(beat)}, iDenominator ${denominator}.`);
      continue;
    }
    segments.push({ row: beatToNoteRow(beat), numerator, denominator });
  }

  // A song whose first time signature is not at the start begins in 4/4.
  if (segments.length > 0 && segments[0]!.row > 0) out.addTimeSignature({ row: 0, numerator: 4, denominator: 4 });
  for (const segment of segments) out.addTimeSignature(segment);
}

export function processTickcounts(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'TICKCOUNTS', expression);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const ticks = Math.min(Math.max(atoi(values[1]!), 0), ROWS_PER_BEAT);
    out.addTickcount({ row: beatToNoteRow(beat), ticks });
  }
}

export function processSpeeds(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    // The original has one more rule here, meant to complete a first entry of two values;
    // its test (`vs2[0] == 0`) never holds, so there is nothing to port.
    if (values.length === 3) values.push('0'); // beats by default
    if (values.length < 4) {
      ctx.titleLog(`has an speed change with ${values.length} values.`);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const ratio = stringToFloat(values[1]!);
    const delay = stringToFloat(values[2]!);
    const unit = stringToInt(values[3]!, ctx.warn) === 0 ? SPEED_UNIT_BEATS : SPEED_UNIT_SECONDS;
    if (beat < 0) {
      ctx.titleLog(`has an speed change with beat ${formatF(beat)}.`);
      continue;
    }
    if (delay < 0) {
      ctx.titleLog(`has an speed change with beat ${formatF(beat)}, length ${formatF(delay)}.`);
      continue;
    }
    out.addSpeed({ row: beatToNoteRow(beat), ratio, delay, unit });
  }
}

export function processFakes(ctx: LoadContext, out: TimingData, line: string): void {
  for (const expression of split(line, ',')) {
    const values = split(expression, '=');
    if (values.length !== 2) {
      invalidPair(ctx, 'FAKES', expression);
      continue;
    }
    const beat = rowToBeat(values[0]!);
    const skippedBeats = stringToFloat(values[1]!);
    if (skippedBeats > 0) out.addFake(rangeSegment(beatToNoteRow(beat), skippedBeats));
    else ctx.titleLog(`has an invalid Fake at beat ${formatF(beat)}, beats to skip ${formatF(skippedBeats)}.`);
  }
}

/** #DISPLAYBPM:[xxx][xxx:xxx]|[*]; for a song. */
export function setSongDisplayBpm(song: Song, params: readonly string[]): void {
  const p1 = param(params, 1);
  if (p1 === '*') {
    song.displayBpmType = DISPLAY_BPM_RANDOM;
    return;
  }
  song.displayBpmType = DISPLAY_BPM_SPECIFIED;
  song.displayBpmMin = stringToFloat(p1);
  const p2 = param(params, 2);
  song.displayBpmMax = p2 === '' ? song.displayBpmMin : stringToFloat(p2);
}

export function setSelectable(ctx: LoadContext, song: Song, value: string): void {
  if (equalsNoCase(value, 'YES')) song.selectable = true;
  else if (equalsNoCase(value, 'NO')) song.selectable = false;
  // ROULETTE (3.9) is no longer in use; ES and OMES come from 3.9+ files.
  else if (equalsNoCase(value, 'ROULETTE')) song.selectable = true;
  else if (equalsNoCase(value, 'ES') || equalsNoCase(value, 'OMES')) song.selectable = true;
  else if (stringToInt(value, ctx.warn) > 0) song.selectable = true;
  else ctx.pathLog(`has an unknown #SELECTABLE value, "${cString(value)}"; ignored.`);
}

/** SMLoader::LoadFromTokens: one #NOTES value. */
function loadFromTokens(
  ctx: LoadContext,
  song: Song,
  stepsTypeRaw: string,
  descriptionRaw: string,
  difficultyRaw: string,
  meterRaw: string,
  noteDataRaw: string,
): Steps {
  let stepsType = trim(stepsTypeRaw);
  const description = trim(descriptionRaw);
  const difficulty = trim(difficultyRaw);
  const noteData = trim(noteDataRaw);

  // Names older versions used.
  if (stepsType === 'ez2-single-hard') stepsType = 'ez2-single';
  if (stepsType === 'para') stepsType = 'para-single';

  const steps = new Steps();
  steps.stepsType = stringToStepsType(stepsType);
  steps.stepsTypeStr = stepsType;
  steps.setDescription(description);
  steps.credit = description; // often used for both
  steps.chartName = description;
  steps.setDifficulty(oldStyleStringToDifficulty(difficulty));

  // From before there was a Challenge difficulty: Hard with a special description.
  if (steps.difficulty === 'Hard' && (equalsNoCase(description, 'smaniac') || equalsNoCase(description, 'challenge'))) {
    steps.setDifficulty('Challenge');
  }

  // Some files have no meter on some charts.
  steps.meter = stringToInt(meterRaw === '' ? '1' : meterRaw, ctx.warn);
  steps.noteText = noteData;
  steps.tidyUp(song.fileName, ctx.warn);
  return steps;
}

/** SMLoader::LoadFromSimfile. `path` is only used in warnings. */
export function loadSm(values: readonly (readonly string[])[], path: string, warn: WarnFn): Song {
  const ctx = new LoadContext(path, warn);
  const song = new Song();
  song.timing.file = path;
  song.fileName = path;

  let bpmChanges: BeatValue[] = [];
  let stops: BeatValue[] = [];

  for (const params of values) {
    const name = makeUpper(param(params, 0));
    const p1 = param(params, 1);
    switch (name) {
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
      case 'CREDIT':
        song.credit = p1;
        break;
      case 'BANNER':
        song.banner = p1;
        break;
      case 'BACKGROUND':
        song.background = p1;
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
      case 'OFFSET':
        song.timing.beat0OffsetSeconds = stringToFloat(p1);
        break;
      case 'BPMS':
        bpmChanges = [];
        parseBpms(ctx, bpmChanges, p1);
        break;
      case 'STOPS':
      case 'FREEZES':
        stops = [];
        parseStops(ctx, stops, p1);
        break;
      case 'DELAYS':
        processDelays(ctx, song.timing, p1);
        break;
      case 'TIMESIGNATURES':
        processTimeSignatures(ctx, song.timing, p1);
        break;
      case 'TICKCOUNTS':
        processTickcounts(ctx, song.timing, p1);
        break;
      case 'SAMPLESTART':
        song.sampleStartSeconds = hhmmssToSeconds(p1, warn);
        break;
      case 'SAMPLELENGTH':
        song.sampleLengthSeconds = hhmmssToSeconds(p1, warn);
        break;
      case 'DISPLAYBPM':
        setSongDisplayBpm(song, params);
        break;
      case 'SELECTABLE':
        setSelectable(ctx, song, p1);
        break;
      case 'INSTRUMENTTRACK':
      case 'ANIMATIONS':
      case 'FGCHANGES':
      case 'KEYSOUNDS':
      case 'ATTACKS':
        break; // not ported
      default:
        if (name.startsWith('BGCHANGES')) break; // not ported
        if (name === 'NOTES' || name === 'NOTES2') {
          if (params.length < 7) {
            ctx.pathLog(`has ${params.length} fields in a #NOTES tag, but should have at least 7.`);
            break;
          }
          // params[5], the radar values, is recomputed rather than read.
          const steps = loadFromTokens(ctx, song, params[1]!, params[2]!, params[3]!, params[4]!, params[6]!);
          steps.filename = path;
          song.addSteps(steps);
          break;
        }
        ctx.pathLog(`has an unexpected value named "${cString(name)}".`);
        break;
    }
  }

  // Negative BPMs and stops become warps.
  processBpmsAndStops(ctx, song.timing, bpmChanges, stops);
  return song;
}
