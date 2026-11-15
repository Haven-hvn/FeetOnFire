// Acoustic (microphone) tests: docs/LATENCY.md, tier 2.
//
// Round trip: play clicks at known context frames, find them in the microphone recording.
//   roundTrip = recordedFrame - scheduledFrame = output latency + air + input latency.
//
// Tap test: the player taps the pad or keyboard next to the microphone. For each tap,
//   E = context frame the lab believes was being heard at the event timestamp
//   R = context frame at which the thump was recorded
// The frame actually being heard when the thump happened is R - roundTrip, so
//   error = E - (R - roundTrip)
// is the constant judgement error (input path delay plus any error in the audio clock map),
// measured without the player needing to be on a beat.

import type { AudioLab } from './audio.ts';
import { detectOnsets, findTemplate, matchTaps } from '../shared/onset.ts';
import { round, roundSummary, summarize } from '../shared/stats.ts';

// Click correlation peak over the RMS of the search range; noise alone reaches 4 to 5.
const MIN_PROMINENCE = 8;
// Clicks are spaced irregularly so that a periodic sound cannot imitate them.
const SPACING_JITTER_MS = 120;
// Accepted clicks must agree on the lag this closely.
const CONSISTENCY_MS = 2;

export interface RoundTripResult {
  clicks: number;
  detected: number;
  roundTripFrames: number | null;
  report: Record<string, unknown>;
}

function levelStats(samples: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    sq += samples[i] * samples[i];
  }
  return { peak: round(peak, 4), rms: round(Math.sqrt(sq / Math.max(1, samples.length)), 5) };
}

export async function measureRoundTrip(audio: AudioLab, clicks = 12, intervalMs = 500): Promise<RoundTripResult> {
  const sr = audio.sampleRate;
  const leadMs = 400;
  const seconds = (leadMs + clicks * (intervalMs + SPACING_JITTER_MS) + 300) / 1000;
  const recording = audio.record(seconds);
  const frames = audio.scheduleClicks(clicks, intervalMs, leadMs, SPACING_JITTER_MS);
  const { samples, startFrame } = await recording;

  const maxLag = Math.round(((intervalMs - 50) / 1000) * sr);
  const lagsMs: number[] = [];
  const prominences: number[] = [];
  for (const f of frames) {
    const expected = f - startFrame;
    const match = findTemplate(samples, audio.click, expected, expected + maxLag);
    if (!match) continue;
    prominences.push(match.prominence);
    if (match.prominence >= MIN_PROMINENCE) lagsMs.push(((match.index - expected) / sr) * 1000);
  }

  // A real round trip puts every click at the same lag. Anything else that happened to
  // correlate (music, speech, a periodic beep) does not follow the random spacing.
  const all = summarize(lagsMs);
  const consistent = all ? lagsMs.filter((v) => Math.abs(v - all.p50) <= CONSISTENCY_MS) : [];
  const accepted = consistent.length >= Math.max(4, Math.ceil(clicks * 0.75));
  const summary = accepted ? summarize(consistent) : null;

  const ctx = audio.ctx;
  const reportedOutMs = ctx ? (ctx.baseLatency + ctx.outputLatency) * 1000 : NaN;
  return {
    clicks,
    detected: accepted ? consistent.length : 0,
    roundTripFrames: summary ? (summary.p50 / 1000) * sr : null,
    report: {
      clicks,
      aboveThreshold: lagsMs.length,
      consistent: consistent.length,
      accepted,
      roundTripMs: roundSummary(summary),
      // Every lag that passed the threshold, for diagnosis when the result is rejected.
      allLagsMs: lagsMs.map((v) => round(v, 2)),
      // Detection statistic per click; a click counts when it reaches the minimum.
      clickProminence: roundSummary(summarize(prominences), 1),
      minProminence: MIN_PROMINENCE,
      reportedOutputMs: round(reportedOutMs),
      // What is left after the browser's own output estimate: input latency plus air
      // (about 1 ms per 34 cm), plus any error in the reported output latency.
      roundTripMinusReportedOutputMs: summary ? round(summary.p50 - reportedOutMs) : null,
      recordingLevel: levelStats(samples),
    },
  };
}

export interface TapTestResult {
  report: Record<string, unknown>;
}

/**
 * @param taps returns the event timestamps (ms, main timebase) collected so far
 * @param roundTripFrames from measureRoundTrip
 */
export async function tapTest(audio: AudioLab, taps: () => number[], seconds: number, roundTripFrames: number): Promise<TapTestResult> {
  const sr = audio.sampleRate;
  const before = taps().length;
  const { samples, startFrame } = await audio.record(seconds);
  const stamps = taps().slice(before);

  const onsets = detectOnsets(samples, sr).map((o) => startFrame + o.index);
  // Where each tap's sound would be in the recording if the event were stamped the moment
  // the sound was made: the frame heard then, plus the way from the mixer to the recording.
  const expected = stamps.map((t) => audio.heardFrameAt(t) + roundTripFrames);
  const match = matchTaps(expected, onsets, sr);
  return {
    report: {
      taps: stamps.length,
      thumpsDetected: onsets.length,
      // Taps whose sound sits at the same distance from the event (within 5 ms).
      matched: match.errorsMs.length,
      // False: too few taps agree (taps too quiet, or too much other sound); the figures mean nothing.
      accepted: match.accepted,
      // Positive: the event was stamped later than the thump was heard (input path delay).
      constantJudgementErrorMs: match.consensusMs === null ? null : round(match.consensusMs),
      agreeingTapsMs: roundSummary(summarize(match.errorsMs)),
      perTapMs: match.errorsMs.map((e) => round(e)),
      note: 'Jitter here includes thump-detection noise (about 1 ms). On keyboards the thump is the key bottoming out, a few ms after it registers.',
      recordingLevel: levelStats(samples),
    },
  };
}
