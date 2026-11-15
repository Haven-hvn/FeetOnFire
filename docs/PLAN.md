# Plan: StepMania-compatible dance game in the browser (TypeScript)

Status: v1 scope proposed 2026-11-09 for review. Route and constraints are decided
(`OPTIONS.md`, "Decision"). Durations are judgement, ±50 %.

## Constraints

- Everything runs in the browser from static files. No server. Songs are imported by the player.
- TypeScript only in the shipped product. No C++ compiled to WASM, no compiled decoders.
- The StepMania source (`stepmania-5_1-new/`) is the behaviour reference: same song files, same
  note timing, same judging and scoring.
- Reference browser: desktop Chromium. Input: WebHID, then Gamepad API, then keyboard.
- Latency is measured before and during development (`LATENCY.md`).

## v1 scope

**In**

| Area | v1 |
|---|---|
| Chart formats | `.sm` and `.ssc` (SSC preferred when both exist, as in `src/NotesLoader.cpp`) |
| Game mode | `dance-single` (4 panels), one player. Other step types are listed but not playable. |
| Note types | Tap, hold, roll, mine, lift, fake. Keysound and attack tokens are parsed and ignored. |
| Timing | BPMs, stops, delays, warps (including the SM negative-BPM / negative-stop conversion), fakes, tick counts, combos, speeds, scrolls, labels, time signatures; SSC per-chart timing; song offset; global offset |
| Judging and scoring | Original timing windows, hold/roll/mine rules, jump handling, combo, life bar, percent score, grades, per-judgement counts |
| Player options | Speed (x, C, M), reverse scroll, autoplay (for testing) |
| Audio | MP3, Ogg Vorbis, WAV, with the same start offset as the original |
| Visuals | One built-in noteskin (quantisation colours), song background image, judgement and combo display |
| Screens | Import (folder, zip, drag and drop), song list with search, chart select, gameplay, results, settings (input mapping, offsets), calibration, latency overlay |
| Storage | Songs in the origin-private file system; settings and scores in browser storage |

**Out (after v1)**

SMA, DWI, BMS, KSF; doubles, solo, pump and other modes; two players; courses; edit mode; attacks
and the wider modifier set; rate mods; scripted backgrounds, videos, lyrics, keysounds; themes,
Lua, noteskin import; StepMania profile files; anything online.

## How "same as StepMania" is verified

| What | Method | Limit |
|---|---|---|
| Parsing and note times | A native reference tool (`tools/smref`), built from the original `MsdFile`, `NotesLoaderSM/SSC`, `TimingData`, `NoteData` code behind stubs, dumps every chart as JSON. The TypeScript loader must produce identical rows and note times within 0.05 ms (met in phase 3: bit-identical). | Built. `Song.cpp` is not compiled; the functions the loaders call are copied into the shim with line references. Reference conditions: global offset 0, rate 1 (`tools/smref/README.md`). |
| Audio start offset | The same tool decodes with the original readers and reports where the first samples land. The browser path must match within 0.1 ms (met in phase 4: the same frames in the same places on every file). | MP3 uses the tree's libmad. Ogg uses the locally installed libogg/libvorbis (the vendored copies are empty). WAV uses the original reader. |
| Judging and scoring | Test vectors written from the original code (`Player.cpp`, `ScoreKeeperNormal.cpp`, `LifeMeterBar.cpp`, default metrics): scripted input traces with expected judgements, score and life (`tests/game-judge.test.ts`, `tests/game-score.test.ts`; passing since phase 5). | Not executed against the original: `Player` cannot run without the engine. Any ambiguity is resolved by reading the source and recorded in the tests. |
| Latency | Latency Lab, then the in-game overlay and an automated headless run. | Software tiers cannot see device or display latency; the microphone tier and later the probe cover that. |

Test corpus: the three bundled songs, synthetic files for each parser quirk and timing segment
(`tests/corpus/`, dumps in `tests/reference/`), and any packs you add locally. The reference tool is a test aid: never shipped.

## Architecture

```
main thread      input listeners (WebHID, gamepad, keyboard) -> stamp -> shared ring
                 menus (DOM), import, settings
                 audio decoding (the browser's file decoder exists only here; runs before play)
game worker      drains ring, judges by timestamp, renders note field (OffscreenCanvas, WebGL2),
                 driven by requestAnimationFrame
audio worklet    mixer: music + effect sounds placed on the context's frame count; exposes
                 the rendered frame in shared memory
workers          sample-rate conversion to the output rate (built, phase 4);
                 file parsing, zip inflate (DecompressionStream) (phase 6)
```

- One timebase (`performance.now()` in the main thread's origin); see `LATENCY.md` section 8.
- No allocation in the per-frame and per-audio-quantum paths.
- Chart core (parser, timing, note data) and judging core are pure modules with no browser
  dependencies, so they run under Node for tests.
- Dependencies are kept minimal: TypeScript compiler, and a browser driver for headless tests.
  The dev server is a small local script bound to 127.0.0.1 that sets the isolation headers.

## Phases

| # | Phase | Output | Exit criterion | Size |
|---|---|---|---|---|
| 0 | Setup — **done 2026-11-09** | Project skeleton, local dev server, test runner | Lab page loads cross-origin isolated | days |
| 1 | Latency Lab — **built 2026-11-09; first real-hardware run done with a keyboard (`LATENCY.md` section 7); pad and microphone tests not run** | Input, audio, video and microphone tests; `latency-report.json` | Baseline numbers on your machine and pad; targets in `LATENCY.md` section 4 confirmed or revised | ~2 wk |
| 2 | Reference tool — **done 2026-11-09** | `tools/smref`, `tests/corpus/`, `tests/reference/` | Dumps the bundled songs; results stable across runs | ~1 wk |
| 3 | Chart core — **done 2026-11-09** | SM/SSC loader, timing, note data in TypeScript (`src/chart/`) | Matches the reference on the whole corpus | 2–3 wk |
| 4 | Audio engine — **done 2026-11-09 in headless Chrome; on a real device the clock is exact between steps of the device clock, which the map follows in 150 ms; the steps were Chrome suspending a silent output, now prevented by keep-awake (`LATENCY.md` section 7)** | Decode path, worklet mixer, clock map | Start offset matches the reference; clock residual within target | ~2 wk |
| 5 | Gameplay — **built 2026-11-09; exit criteria met in headless Chrome ("Phase 5 result"); not yet played by a person** | Worker renderer, judging, holds/rolls/mines, scoring, life | Test vectors pass; autoplay scores 100 %; pacing and judgement-jitter targets met | 4–5 wk |
| 6 | Shell — **built 2026-11-10; exit criterion met with a keyboard in headless Chrome ("Phase 6 result"); pad paths unverified (no pad available)** | Import, song list, settings, mapping, calibration, results | A pack imported from disk is playable end to end with a pad | 2–3 wk |
| 6b | Presentation — **first pass built 2026-11-10 ("Phase 6b"); asked for as "an actual professional looking AAA game"; open-ended** | Visual and audio design of the menus and the play field | The user's eye | — |
| 7 | Hardening | Tuning, edge cases, documentation | All v1 acceptance checks pass | 1–2 wk |
| — | After v1 | Hardware probe; further formats and modes | — | — |

## Findings so far

- MP3 start offset (phase 2): for the bundled `Kommisar - Springtime.mp3`, StepMania's decoder
  output is the same audio as CoreAudio's but 529 frames (12.0 ms at 44.1 kHz) later, with the
  same total frame count. A browser decoder that trims encoder delay will therefore play
  about 12 ms early relative to the original unless compensated. Phase 4 measured Chromium's
  decode against the reference PCM per file; see "Phase 4 result".
- Ogg start offset (phase 2): for both bundled Ogg files, StepMania's reader output lines up
  with ffmpeg's Vorbis decoder at lag 0 (largest sample difference 6e-7). Chromium decodes
  Vorbis with ffmpeg, so no start correction is expected for Ogg; phase 4 confirmed this in the
  browser. `Mecha-Tribe Assault.ogg` has a malformed last page (granule position goes
  backwards); the two decoders differ only in how much tail they keep after the song ends.
- The bundled simfiles load with only genuine file warnings (an empty `#STOPS` in
  `Goin' Under.sm`, 21 unmatched hold ends in Springtime).

## Phase 3 result: chart core

`src/chart/` reads `.sm` and `.ssc` files and gives the same result as StepMania's own code,
bit for bit: song fields, every timing segment, note rows, note times, hold lengths, which
notes can be judged, and the warning texts. Arithmetic is done in 32-bit floats in the
original's order of operations.

How it is checked:

- `npm test` compares against the stored reference dumps: 17 synthetic corpus files and the
  4 bundled simfiles (about 18,900 notes and 55,000 timing samples).
- `npm run ref:fuzz [count] [seed]` (`tests/chart-diff-fuzz.ts`) generates random simfiles,
  reads each with the reference tool and with the port, and compares everything.
  Seeds 1–5, 2,000 files: 1,814 compared (474,882 notes, 456 million timing samples), none
  differ. 167 skipped (the undefined `.sm` case below). On 19 the reference gave no result:
  10 crashes and 2 failed assertions in StepMania (both in the table below; the port loads
  all 12), 6 dumps too large to read back and 1 timeout (not compared).
- `npm test` also feeds about 5,000 damaged and random files to the parser: it never throws.

Where the port deliberately differs from StepMania:

| Case | StepMania | Port |
|---|---|---|
| Routine (two-player) charts | Loaded | Listed, notes not loaded, with a warning. Out of v1 scope. |
| Chart with empty note data | Re-read from disk later | Stays empty |
| Background, foreground, keysound, attack and instrument-track tags | Parsed, with warnings | Ignored. Out of v1 scope. |
| Tag names with non-ASCII letters | Upper-cased by locale rules | ASCII upper-casing only |
| `.sm` whose only BPM change is after beat 0 | Reads past the end of an array (undefined) | Uses that change's value |
| `#SPEEDS:=;` (an entry with no values) | Crashes (null pointer in `SMLoader::ProcessSpeeds`) | Warning, entry skipped |
| Adding a segment to a list left out of row order by earlier entries, where the lookup fails | Stops with a failed assertion | List put in order, load continues |

One behaviour worth knowing: adding a timing segment equal to the following one moves that
one back without re-sorting, so a list can end up out of row order. StepMania keeps the
song's list that way, but a chart's own timing is copied on assignment and the copy is in
order. The port does both (`TimingData.copy()`; corpus file `edge-segment-order.ssc`).

## Phase 4 result: audio engine

`src/audio/` decodes MP3, Ogg Vorbis and WAV files to the frames StepMania's readers give,
converts them to the output rate, plays them from an AudioWorklet at an exact frame, and
tells the game what music time is being heard at any `performance.now()`.

| Exit criterion | Target | Measured (headless Chrome) |
|---|---|---|
| Start of the audio against the reference | 0.1 ms | 0 frames on all 28 files with a reference (19 MP3, 4 Ogg, 5 WAV), same frame counts. After rate conversion and the mixer: under 1 ns. |
| Clock map prediction error | 0.5 ms RMS | 0.003 ms RMS, 0.007 ms worst. Headless Chrome has no real audio device, so this proves the mechanism only. On real hardware (Lab, Apple M4, Chrome 156): 0.54 ms RMS, median 0.000, p99 2.98, worst 4.42, with three skipped render quanta in 49 s. A second run with raw pairs showed why: the heard position moves in steps (4 to 30 ms) when the device is disturbed; between them the error is 0.002 ms RMS (0.41 ms in a noisy stretch). The map now follows a step in three pairs; see `LATENCY.md` section 7. |

Parts:

| File | Does |
|---|---|
| `decode.ts` | `decodeAudioFile(bytes, name)`: tries formats in StepMania's order (extension first). |
| `mp3.ts` | Walks an MP3 file as StepMania's reader does and lists the frames it plays: ID3 tags, the search limit, checksums, `Xing` (skipped) and `Info` (played) frames. |
| `wav.ts` | WAV decoder, ported from `RageSoundReader_WAV.cpp` (MIT): PCM 8/16/24/32 bit, float, MS ADPCM. Bit-exact against the reference. |
| `ogg.ts` | Reads the Vorbis header (rate, channels), so the browser decodes at the file's rate. |
| `resample.ts`, `resample-worker.ts` | Windowed-sinc rate conversion in a worker. Keeps time to nanoseconds. Flat to 19 kHz at 44.1 → 48 kHz (error 5e-5), −2.2 dB at 20.5 kHz. 129 s of stereo takes about 1 s. |
| `mixer-worklet.ts`, `mixer.ts` | Music frame `offset + (f − start)` is rendered at context frame `f`. 16 effect voices at exact frames. Counts glitches. No allocation while rendering. |
| `engine.ts` | `AudioEngine`: load, play, stop, effect sounds; `musicSecondsAt(perfMs)` from the clock map (`getOutputTimestamp()` every 50 ms). |

### Decode path: what was measured, and the choice

`tools/audio-study/decode-study.mjs` compares each browser path with the reference PCM.

| Option | Result | Effort | Risk |
|---|---|---|---|
| A. `decodeAudioData`, then shift by an offset computed from the file's encoder tag | MP3 comes out early by encoder delay + 529 frames, and by one more frame (1,152) when the tag frame is `Info`: 2,257 frames (51 ms) for a common LAME file. Correct after the shift, but the delay and padding regions are lost, and the rule depends on how the browser's decoder reads tags (it finds LAME's tag in a file with checksums; StepMania does not). | Small | Silent offset error if a browser's trimming rule differs or changes |
| **B. Own frame scan, frames decoded one by one with WebCodecs** (built) | Lag 0, same frame count, on every MP3. Sample difference 8e-7 relative (8e-4 on Springtime, where the two decoders differ on a few loud samples; cause not looked into, position unaffected). Nothing is trimmed, as in StepMania. | Medium (done) | Needs WebCodecs MP3 (desktop Chromium has it) |
| C. Own MP3 and Vorbis decoders in TypeScript | Not built | Large (weeks) | Decoder bugs; slow |

Built: B for MP3 with A as the fallback when WebCodecs is missing (the file then carries a
note). `decodeAudioData` at the file's rate for Ogg (lag 0, difference 2e-7). Own decoder for
WAV. All behind `decodeAudioFile`, so a path can be swapped without touching the rest.

### Where the port differs from StepMania

| Case | StepMania | Port |
|---|---|---|
| WAV with an extensible header (`0xFFFE`) holding PCM or float | Rejected ("Unsupported data format -2") | Played, with a note |
| A file that starts as Ogg or WAV, tried as MP3 | Searched for MP3 frames | Not searched |
| MP3 free-format bitrate | Decoded | Not supported |
| MP3 layers I and II | Decoded | Frames are found; decoding depends on the browser |
| MP3 frame the decoder finds damaged | Dropped by libmad's rules | The browser's decoder decides; frames with a wrong checksum are dropped as in StepMania |
| Ogg with more than two channels | Not compared with the reference | First two channels |
| Whole file decoded into memory before play | Streams | About 45 MB per 2 minutes of stereo, twice that while converting rate |

### How it is checked

- `npm test`: 71 audio tests under Node (MP3 scan against the reference frame counts, WAV
  against the reference hashes, rate conversion, the mixer worklet frame by frame).
- `npm run e2e:audio` (headless Chrome, needs `npm run ref` once): every corpus file and the
  bundled songs decoded and compared with the reference PCM; the mixer's output compared
  sample for sample in an offline context; decode + conversion + mixer placed against the
  reference; the engine played in real time; the fallback MP3 path.
- Fixed on the way: the reference tool printed a non-standard hash (a truncated constant).
  All audio dumps were regenerated; chart dumps are unaffected.

Not covered yet: the real output latency against the reported one (microphone round trip),
other browsers, and behaviour
when the output device changes during play (the engine restarts its clock map and counts it).

## Phase 5 result: gameplay

`src/game/` judges and draws a chart. The page `http://127.0.0.1:5173/lab/play/` (with
`npm run serve`) plays a song picked from disk: speed `2x` / `C450` / `M450`, reverse,
autoplay, fail off, a global offset typed in by hand, keys on the arrows or D F J K.

| Exit criterion | Result |
|---|---|
| Test vectors pass | 27 tests of judging, scoring, life and grade written from the original's code, each with the reading of the source it rests on; 8 more for scroll position and the shared clock. All pass. |
| Autoplay scores 100 % | Under Node: all 77 charts of the corpus and the bundled songs (18,951 notes): every row Flawless, every hold OK, 100.00 %, 100,000,000 points, top grade. In the browser, through the worker: a chart with every kind of note, and a whole bundled song (Springtime: 864 rows, 109 holds). |
| Judgement jitter ≤ 2 ms (p99 from the median) | 0.0004 ms worst, median 0.0000 ms: inputs written to the ring with chosen timestamps come out of the judge with the chosen offsets, and all 22 get the judgement their offset calls for. Real key events reach the judge with `event.timeStamp` unchanged. This is the software path; what the timestamps themselves are worth is the hardware probe's question. |
| Input to frame (T2→T6) p99 ≤ 1 frame + 4 ms | 17.2 to 18.1 ms in three runs (limit 20.7 ms at 60 Hz), median 9 ms: an input waits for the next frame. |
| Frame pacing ≥ 99.9 % on time | 100 %: 0 late of 694 frames, and 0 late of 7,924 over the whole song. Frame cost 0.1 ms median, 0.28 ms p99. |

All figures are from headless Chrome 156 on the Apple M4 (`npm run e2e:game`), which has no
display and no audio device. The page shows the same figures after each song, for a real run.

Parts:

| File | Does |
|---|---|
| `constants.ts` | Windows, weights, life changes, grade tiers: the `dance` defaults. |
| `judge.ts` | `Judge`: `press`, `release`, `advance`. Closest note by row, jumps, holds, rolls, mines, lifts, fakes, misses, autoplay. |
| `score.ts`, `life.ts` | `ScoreKeeper` (dance points, percent, score, combo, counts, grade) and `LifeMeter`. |
| `field.ts` | Scroll position for x, C and M speeds, reverse, layout, note colours. |
| `shared-clock.ts` | The audio clock map in shared memory, with a sequence counter. |
| `render.ts`, `scene.ts` | WebGL2: one program, one atlas painted at start-up (built-in noteskin, words, digits), one batch per frame. |
| `worker.ts` | The frame: read the clock, drain the input ring, advance the judge, draw. Measures its own clock against the page's at start-up. |
| `session.ts`, `play-page.ts` | Page side: canvas, worker, key listeners stamping into the ring, music start with a lead-in; the test page. |

Everything from `constants.ts` to `shared-clock.ts` is pure and runs under Node. Nothing is
allocated per frame; the timing lookups of `src/chart/timing.ts` were changed to reuse their
scratch objects for that (results unchanged: the reference tests still pass).

### How judging differs from StepMania, on purpose

| Case | StepMania | Port |
|---|---|---|
| Time | Per frame: hold life falls by the frame time, panels are sampled once a frame, hits and misses are scored on the next frame | By time: each input at its own timestamp; misses, hold results and mines under a held panel at times computed from the chart; all applied in time order. The result does not depend on the frame rate (tested at 4, 60, 144 Hz and with no frames). |
| End of a hold | The first frame whose rounded song row has reached the end row | The moment the rounded song row reaches it: half a row before the end, as the original on average |
| A hold let go | Life empty at a frame before the end | Panel up for 0.25 s before the end is reached; a roll 0.5 s without a step, the end included |
| Where a step looks for its note | Rows around the song position of the last frame | Rows around the step's own time |
| Clock-driven judgements for a player | Same frame | Up to 40 ms later (`judgeLagMs`): the judge's clock is kept behind the present so that inputs still on their way arrive in order. Hits are not delayed and not affected. |
| Autoplay scoring | Nothing is scored | Scored, so that 100 % can be tested |
| Autoplay steps | Random offset inside the top window; rolls stepped again when half empty | Offset 0; rolls do not run out |
| Grade tiers | Default theme: 17 | `_fallback` theme: 7 (AAAA, AAA, AA, A, B, C, D) |
| Global offset | −0.008 s by default | A setting, 0 by default; same sign as the original's |
| Failing | The song ends when every player has failed | Play goes on, marked failed; points stop as in the original |
| `MinTNSToScoreNotes` and early-hit re-judging, held-miss flag, hold checkpoints, attacks, keysounds, calories | Present; off or unused by default in `dance` | Not built |

Readings of the source worth knowing (each has a test):

- The closest note is by row, not by time, and is taken even when out of reach: a press
  between a mine and a tap can hit nothing though the tap is inside its window.
- Fake-type notes (`F`) are not left out of that search: a press near one is used up on it.
- A miss is registered 0.5 s (the largest window, the roll's) after the row is passed, plus
  half a row; during a stop on the row, without the half row.
- A row is scored once, with the score of the last note hit; W4 and W5 are counted with the
  combo segment's miss multiplier.
- A hold whose head was never stepped on is `Missed`, not `LetGo`: no life lost and no
  score step beyond the head's own miss.
- A lift-only row counts as a step toward the score's step count.

### How it is checked

- `npm test`: 35 game tests among 182.
- `npm run e2e:game` (headless Chrome): autoplay through the worker; inputs with chosen
  timestamps; real key events; the timing figures above against their targets.
  `--song <folder>` plays a whole song folder on autoplay; `--shot <png>` saves a picture.

Not covered: a person playing (the page is ready for it); pads (WebHID and Gamepad input
into the ring: phase 6, with the mapping screen); the constant judging error on real
hardware (set by hand with the global offset until the calibration screen); song
background image; other browsers.

## Phase 6 result: shell

The game is a page of its own: `http://127.0.0.1:5173/` (`npm run serve`), in `app/` and
`src/app/`. Songs are added from a folder, files, a zip, or by dropping any of them on the
page; they are listed by pack with search; a chart is chosen and played; the result is shown
and the best score kept. Esc pauses (resume, restart, end, quit).

On 2026-11-10 the user handed over the choices ("you own this code base, do whatever you
see fit"). Made, with the reasons:

| Choice | Taken | Why |
|---|---|---|
| Page | New `app/` directory, plain DOM modules, no framework | Six screens do not need one. Cost: one word added to the dev server's list of served directories and `/` now leads to `/app/`; the bind is unchanged (127.0.0.1). |
| Song storage | Original files copied into the origin-private file system; descriptions and scores in IndexedDB; settings in localStorage | Decoded audio is about 45 MB per 2 minutes, so it is decoded at play time, not stored. The browser may clear storage under pressure unless asked not to: Settings has the button. |
| Zip | Own reader (`zip.ts`: directory, stored and deflated entries; inflate by `DecompressionStream`) | No dependency. Zip64 and encrypted archives are refused with a message. |
| Calibration | Optional. Offset 0 by default; a number in Settings; "Tap to set" plays 28 clicks through the game's own audio path and proposes minus the median tap error; a note when the output reports over 50 ms (Bluetooth) | The user played at offset 0 and found it good enough: wired and built-in audio rarely need it, wireless audio is unplayable without it. Includes the player's own tapping bias, as StepMania's sync screen does. |
| Visual lead | A number in Settings, 0 by default; no test for it | Not measurable without hardware; add a tap-to-flash pass if someone reports arrows out of step with sound. |
| Input | One `InputRouter` on the main thread for keyboard, Gamepad API and WebHID; one mapping screen ("Add", then press the control) | The user's decision named WebHID first. WebHID is mapped by which report bit changes on a press, so no descriptor parsing; bits that move in the first half second after opening are taken for axes and ignored. |

| Exit criterion | Result |
|---|---|
| A pack imported from disk is playable end to end | `npm run e2e:app`, headless Chrome: a zip of a two-song pack and loose files are imported, listed, searched, still there after a reload; a re-import replaces; a key is mapped; the song is played on the keyboard through a pause to the results (16 of 16 hit), and the score shows as the chart's best; autoplay reaches 100 % and keeps no score. |
| ... with a pad | **Not met and not testable here**: no pad can be plugged in. Gamepad and WebHID input are written to the specifications; the report differ and the bindings have unit tests with synthetic reports only. |
| Calibration | Taps dispatched 40 ms after each click give a proposal of −42 to −43 ms (the test's timers add the rest). |

Added to the game for this: pause and resume (the music is stopped and started again a second
before where it stopped; the audio context keeps running), the song's background picture
behind the field, a sound when a mine goes off (synthesized, nothing shipped), two controls
on one panel acting as one switch, and keys let go when the window loses focus (which also
pauses).

Parts (`src/app/`): `zip.ts`, `library.ts` (grouping files into songs, describing a song;
pure), `store.ts` (file system, IndexedDB, settings, import), `sounds.ts` (mine, click track,
tap arithmetic; pure), `main.ts` (song list, import), `play.ts` (loading, pause menu,
results), `settings-screen.ts`, `ui.ts`. In `src/game/`: `bindings.ts` (pure), `input.ts`.

Not covered: pads on real hardware; the folder picker and drag and drop (the test uses the
file picker; same code after the file list is built); very large packs (import is one song
at a time, memory is one file at a time, but nothing over a few songs has been tried);
song preview audio; other browsers.

## Phase 6b: presentation (first pass)

What changed, all made here (no outside fonts, pictures or sounds; the lettering is the
system's condensed face):

- Play field (`render.ts`, `scene.ts`): a 2048×1024 atlas painted at start-up. Arrows are a
  shaded body tinted by note colour plus an outline-and-sheen layer; metal receptors that
  pulse on the beat and light up when pressed; shaded hold and roll bodies with a core of
  light while held; a spinning mine with a glowing core. Hits throw an arrow-shaped flash,
  a ring and a glow in the judgement's colour (additive light); mines flash the screen.
  Judgement words in their own colours with a pop, "early"/"late" under anything short of
  Flawless, a combo number coloured by the worst judgement so far, drawn under the notes.
  A lane underlay, a vignette, drifting lights when the song has no picture, the song's
  name and difficulty at the left, live judgement counts at the right, a song progress
  line, a life bar that glows when full and blinks in danger, "Ready" before the first
  note, "Full Combo" after a clean run, a red wash on failing.
- Menus (`app/app.css`, `src/app/`): a title screen (its key press is also what lets the
  browser start audio); the song list over the selected song's picture out of focus, with
  difficulty tiles and best scores; the selected song's sample plays and loops; menu
  sounds; an animated results card with a histogram of where the hits fell, and an offer
  to shift the offset when they lean one way by 12 ms or more over 30 hits.

Cost: a frame takes 0.15 ms (was 0.10); pacing unchanged (0 late frames in the e2e runs).

Found on the way, worth knowing: a box with `overflow: hidden` can still be scrolled by
`focus()` and `scrollIntoView()`; with a background layer larger than the page this shifted
every later screen up and left. The app container uses `overflow: clip`. And sprites that
share a texture must not be drawn from small mip levels (neighbours mix): the level is capped.

Ideas not done: a noteskin choice; particles; a song wheel with jackets instead of a list;
a banner for songs without one drawn from the title; transitions into and out of play
(curtain, countdown); results that count up; sound for judgements (off in StepMania too);
the visual polish of Settings; a name and a mark of its own (it is called "Dance" for now).

## Open items


- Publishing: unanswered. It decides hosting (the host must set COOP/COEP headers), whether a
  licence file and the StepMania copyright notice need to ship (a close rewrite is a derived
  work of MIT-licensed code, so the notice stays either way), and nothing about decoders any
  more, since no GPL code ships.
- Audio decode path: built as own frame scan plus WebCodecs for MP3 (option B in "Phase 4
  result"). Say if you want another option; the change is contained in `src/audio/decode.ts`.
- Version control: the project directory is not a git repository. Say if you want one.
- Device clock steps: explained and prevented. Chrome takes the audio device away after 30 s
  of pure silence and the heard position steps by about 30 ms when sound returns. The mixer
  now never renders pure silence (`LATENCY.md` section 7); confirmed on the laptop (141.5 s,
  no step, 0.002 ms RMS). Phase 5 rule: one audio context for the
  whole session, created once and never suspended in menus or pause.
- Reported output latency on the laptop's speakers is 45.3 ms (target ≤ 30 ms). Microphone
  round trip: 74.5 ms, spread 0.002 ms; it cannot split output from microphone latency. The
  tap test gives the constant judging error with the microphone cancelled; the first try
  gave no usable result (quiet keys, sounds mismatched) and its matching was rebuilt. A
  repeat is optional: the game's sync screen (phase 6) sets the same constant per player.
- Worker clocks: `timeOrigin` conversion was 0.69 ms off on real hardware. The game worker
  measures and corrects it at start-up (phase 5); WebHID in a worker (phase 6) must do the same.
- `lab/play/` is the phase 5 test page, kept for `npm run e2e:game`. The game is `app/`.
- Pad input is unverified until someone with a pad tries the mapping screen.
