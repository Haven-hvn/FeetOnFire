// What the loaders fill in: a song and its charts ("steps"), as StepMania's Song and Steps
// hold them while loading. Text fields are binary strings (one char per file byte); the
// entry point in index.ts decodes them.

import { cString, type WarnFn } from './cnum.ts';
import { f32 } from './f32.ts';
import { stringToDifficulty, type Difficulty, type StepsTypeInfo } from './steps-types.ts';
import { TimingData } from './timing.ts';

/** How the BPM is shown on the song wheel (DisplayBPM in the original). */
export const DISPLAY_BPM_ACTUAL = 0;
export const DISPLAY_BPM_SPECIFIED = 1;
export const DISPLAY_BPM_RANDOM = 2;

/** STEPFILE_VERSION_NUMBER: the .ssc version this StepMania writes. */
export const STEPFILE_VERSION = f32(0.83);

const MAX_STEPS_DESCRIPTION_LENGTH = 255;

export class Steps {
  /** Null when this StepMania version does not know the type. */
  stepsType: StepsTypeInfo | null = null;
  /** The type as written in the file. */
  stepsTypeStr = '';
  difficulty: Difficulty | null = null;
  description = '';
  chartName = '';
  chartStyle = '';
  credit = '';
  meter = 0;
  /** A chart's own music file (.ssc), else ''. */
  music = '';
  filename = '';
  displayBpmType = DISPLAY_BPM_ACTUAL;
  displayBpmMin = 0;
  displayBpmMax = 0;
  /** The chart's own timing; without segments the song's timing applies. */
  timing = new TimingData();
  /** The note data as text, parsed on demand. */
  noteText = '';

  /** Steps::SetDifficultyAndDescription: an edit's description is cut to 255 bytes. */
  private setDifficultyAndDescription(difficulty: Difficulty | null, description: string): void {
    this.difficulty = difficulty;
    this.description =
      difficulty === 'Edit' && description.length > MAX_STEPS_DESCRIPTION_LENGTH
        ? description.slice(0, MAX_STEPS_DESCRIPTION_LENGTH)
        : description;
  }

  setDifficulty(difficulty: Difficulty | null): void {
    this.setDifficultyAndDescription(difficulty, this.description);
  }

  setDescription(description: string): void {
    this.setDifficultyAndDescription(this.difficulty, description);
  }

  /** Steps::TidyUpData: fills in a missing type name, difficulty and meter. */
  tidyUp(songFileName: string, warn: WarnFn): void {
    if (this.stepsType === null) {
      warn(`Detected steps with unknown style '${cString(this.stepsTypeStr)}' in '${cString(songFileName)}'`);
    } else if (this.stepsTypeStr === '') {
      this.stepsTypeStr = this.stepsType.name;
    }

    if (this.difficulty === null) this.setDifficulty(stringToDifficulty(this.description));

    if (this.difficulty === null) {
      if (this.meter === 1) this.setDifficulty('Beginner');
      else if (this.meter <= 3) this.setDifficulty('Easy');
      else if (this.meter <= 6) this.setDifficulty('Medium');
      else this.setDifficulty('Hard');
    }

    // The original calls PredictMeter() here; at load time, with no radar values yet, that is 1.
    if (this.meter < 1) this.meter = 1;
  }
}

export class Song {
  /** Path of the simfile, as given by the caller. Used in warnings. */
  fileName = '';
  version = STEPFILE_VERSION;
  title = '';
  subtitle = '';
  artist = '';
  titleTranslit = '';
  subtitleTranslit = '';
  artistTranslit = '';
  genre = '';
  origin = '';
  credit = '';
  banner = '';
  background = '';
  jacket = '';
  cdTitle = '';
  lyricsPath = '';
  music = '';
  /** Music file for the preview, when different from the song's (.ssc #PREVIEW). */
  preview = '';
  sampleStartSeconds = -1;
  sampleLengthSeconds = 12;
  displayBpmType = DISPLAY_BPM_ACTUAL;
  displayBpmMin = 0;
  displayBpmMax = 0;
  /** #SELECTABLE:NO hides a song from the song list. */
  selectable = true;
  timing = new TimingData();
  /** Charts of a known type, in file order. */
  steps: Steps[] = [];
  /** Charts of a type this StepMania version does not know; kept only for saving. */
  unknownStyleSteps: Steps[] = [];

  /** Song::AddSteps */
  addSteps(steps: Steps): void {
    if (steps.stepsType !== null) this.steps.push(steps);
    else this.unknownStyleSteps.push(steps);
  }
}
