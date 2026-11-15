// Chart core entry point: reads a .sm or .ssc file into a song, its timing and its charts,
// with the same results as StepMania 5.1 (see docs/PLAN.md, phase 3).
//
//   const simfile = parseSimfile(bytes, 'ssc', { path: file.name });
//   const chart = simfile.charts[0];
//   const { notes } = loadChartNotes(chart);   // rows, tracks and the time of each note
//
// Times are seconds from the start of the music file, with no global offset applied.

import { loadSm } from './loader-sm.ts';
import { loadSsc } from './loader-ssc.ts';
import { parseMsd } from './msd.ts';
import { loadNoteDataString, NoteData, type Note } from './notedata.ts';
import type { Song, Steps } from './song.ts';
import type { Difficulty, StepsTypeCategory } from './steps-types.ts';
import { binaryToUtf8, utf8ToBinary } from './text.ts';
import type { TimingData } from './timing.ts';

export { DISPLAY_BPM_ACTUAL, DISPLAY_BPM_RANDOM, DISPLAY_BPM_SPECIFIED } from './song.ts';
export { beatToNoteRow, noteRowToBeat, ROWS_PER_BEAT } from './f32.ts';
export { NoteData } from './notedata.ts';
export type { HoldSubType, Note, TapNote, TapNoteType } from './notedata.ts';
export { DIFFICULTIES } from './steps-types.ts';
export type { Difficulty, StepsTypeCategory } from './steps-types.ts';
export { SPEED_UNIT_BEATS, SPEED_UNIT_SECONDS, TimingData } from './timing.ts';
export type { BeatInfo } from './timing.ts';

export type SimfileFormat = 'sm' | 'ssc';

export interface ParseOptions {
  /** Name or path of the file. Only used in warnings. */
  path?: string;
}

export interface Chart {
  /** Position among the charts of the file. */
  index: number;
  /** For example "dance-single". */
  stepsType: string;
  /** Number of columns. */
  tracks: number;
  category: StepsTypeCategory;
  /** Null only for a chart whose notes are in another file (#STEPFILENAME). */
  difficulty: Difficulty | null;
  meter: number;
  description: string;
  chartName: string;
  chartStyle: string;
  credit: string;
  /** The chart's own music file, else ''. */
  music: string;
  /** DISPLAY_BPM_* */
  displayBpmType: number;
  displayBpmMin: number;
  displayBpmMax: number;
  /** The chart's own timing, or null when it uses the song's. */
  ownTiming: TimingData | null;
  /** The timing in effect for this chart. */
  timing: TimingData;
  /** The note data as written in the file (one char per byte). See loadChartNotes. */
  noteText: string;
}

export interface Simfile {
  format: SimfileFormat;
  title: string;
  subtitle: string;
  artist: string;
  titleTranslit: string;
  subtitleTranslit: string;
  artistTranslit: string;
  genre: string;
  origin: string;
  credit: string;
  banner: string;
  background: string;
  jacket: string;
  cdTitle: string;
  lyricsPath: string;
  music: string;
  /** Music file for the preview when it is not the song's own, else ''. */
  preview: string;
  sampleStartSeconds: number;
  sampleLengthSeconds: number;
  /** DISPLAY_BPM_* */
  displayBpmType: number;
  displayBpmMin: number;
  displayBpmMax: number;
  selectable: boolean;
  /** The file format version StepMania gives a loaded song: always its own, 0.83. */
  version: number;
  timing: TimingData;
  /** Charts of a known type, in file order. */
  charts: Chart[];
  /** What StepMania would have logged while loading, in the same order. */
  warnings: string[];
}

function decodeLabels(timing: TimingData): void {
  for (const segment of timing.labels) segment.label = binaryToUtf8(segment.label);
}

function toChart(steps: Steps, index: number, song: Song): Chart {
  const type = steps.stepsType!;
  const ownTiming = steps.timing.empty() ? null : steps.timing;
  return {
    index,
    stepsType: binaryToUtf8(steps.stepsTypeStr),
    tracks: type.tracks,
    category: type.category,
    difficulty: steps.difficulty,
    meter: steps.meter,
    description: binaryToUtf8(steps.description),
    chartName: binaryToUtf8(steps.chartName),
    chartStyle: binaryToUtf8(steps.chartStyle),
    credit: binaryToUtf8(steps.credit),
    music: binaryToUtf8(steps.music),
    displayBpmType: steps.displayBpmType,
    displayBpmMin: steps.displayBpmMin,
    displayBpmMax: steps.displayBpmMax,
    ownTiming,
    timing: ownTiming ?? song.timing,
    noteText: steps.noteText,
  };
}

/**
 * Reads a simfile. Never throws on malformed content: like StepMania, it keeps what it can
 * read and reports the rest in `warnings`.
 */
export function parseSimfile(bytes: Uint8Array, format: SimfileFormat, options: ParseOptions = {}): Simfile {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(message);
  };
  const path = utf8ToBinary(options.path ?? '');
  const values = parseMsd(bytes);
  const song = format === 'ssc' ? loadSsc(values, path, warn) : loadSm(values, path, warn);

  // The timing part of Song::TidyUpData: defaults such as a first BPM.
  song.timing.tidyUp(false, warn);
  for (const steps of song.steps) steps.timing.tidyUp(true, warn);

  decodeLabels(song.timing);
  for (const steps of song.steps) decodeLabels(steps.timing);

  return {
    format,
    title: binaryToUtf8(song.title),
    subtitle: binaryToUtf8(song.subtitle),
    artist: binaryToUtf8(song.artist),
    titleTranslit: binaryToUtf8(song.titleTranslit),
    subtitleTranslit: binaryToUtf8(song.subtitleTranslit),
    artistTranslit: binaryToUtf8(song.artistTranslit),
    genre: binaryToUtf8(song.genre),
    origin: binaryToUtf8(song.origin),
    credit: binaryToUtf8(song.credit),
    banner: binaryToUtf8(song.banner),
    background: binaryToUtf8(song.background),
    jacket: binaryToUtf8(song.jacket),
    cdTitle: binaryToUtf8(song.cdTitle),
    lyricsPath: binaryToUtf8(song.lyricsPath),
    music: binaryToUtf8(song.music),
    preview: binaryToUtf8(song.preview),
    sampleStartSeconds: song.sampleStartSeconds,
    sampleLengthSeconds: song.sampleLengthSeconds,
    displayBpmType: song.displayBpmType,
    displayBpmMin: song.displayBpmMin,
    displayBpmMax: song.displayBpmMax,
    selectable: song.selectable,
    version: song.version,
    timing: song.timing,
    charts: song.steps.map((steps, index) => toChart(steps, index, song)),
    warnings: warnings.map(binaryToUtf8),
  };
}

/** The format a file name's extension stands for, or null. */
export function simfileFormatOf(fileName: string): SimfileFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ssc')) return 'ssc';
  if (lower.endsWith('.sm')) return 'sm';
  return null;
}

export interface TimedNote extends Note {
  /** When the note is to be hit. */
  seconds: number;
  /** When a hold or roll ends; null for other notes. */
  endSeconds: number | null;
  /** False inside a warp or fake section: shown, not judged. */
  judgable: boolean;
}

export interface ChartNotes {
  noteData: NoteData;
  /** All notes by row and then track, with their times. */
  notes: TimedNote[];
  warnings: string[];
}

/** Parses a chart's notes (Steps::GetNoteData) and gives each its time. */
export function loadChartNotes(chart: Chart): ChartNotes {
  const warnings: string[] = [];
  const warn = (message: string): void => {
    warnings.push(binaryToUtf8(message));
  };

  let noteData: NoteData;
  if (chart.category === 'Routine') {
    // Two players' notes in one chart ("composite" note data): not supported.
    warnings.push(`Chart ${chart.index} (${chart.stepsType}) is a routine chart; its notes were not loaded.`);
    noteData = new NoteData(chart.tracks);
  } else if (chart.noteText === '') {
    noteData = new NoteData(chart.tracks);
  } else {
    noteData = loadNoteDataString(chart.noteText, chart.tracks, warn);
  }

  const timing = chart.timing;
  const notes = noteData.notes().map((note): TimedNote => {
    const hold = note.type === 'HoldHead';
    return {
      ...note,
      seconds: timing.secondsAtRow(note.row),
      endSeconds: hold ? timing.secondsAtRow(note.row + note.durationRows) : null,
      judgable: timing.isJudgableAtRow(note.row),
    };
  });
  return { noteData, notes, warnings };
}
