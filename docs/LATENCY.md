# Latency: model, targets, measurement

Status: design, written 2026-11-09 in the planning session. Numbers marked **(verify)** are
expectations to be confirmed by the Latency Lab on real hardware. First real-device figures
(one laptop, keyboard only) are in section 7.

Scope: the route is decided (TypeScript rewrite, no compiled code shipped; see `OPTIONS.md` and
`PLAN.md`). The model, targets and measurement tiers here do not depend on that choice.
References to StepMania source describe behaviour the rewrite has to reproduce; notes marked
"compile route" are kept only as pointers to the original driver code.

## 1. Does low-level GPU code lower latency?

Only a little, and not where it matters most.

- The GPU API (WebGPU vs WebGL2) does not change how a frame reaches the screen. Both hand a
  finished image to the browser compositor, which presents on the next vsync. StepMania draws a
  few hundred textured quads per frame; either API finishes that in about a millisecond.
- What "low level" does buy is *consistency*: a worker thread is not interrupted by page work,
  shared memory avoids message-passing delays, and code that does not allocate per frame
  (WASM, or carefully written TypeScript) avoids garbage-collector pauses. That removes jitter
  and dropped frames, which matter more than average latency.
- The big levers are input timestamping, the audio clock, and the display path
  (refresh rate, fullscreen, compositor bypass). See section 5.

## 2. Three different latencies

They are usually lumped together, but they have different fixes.

| Name | What it is | Can it be compensated? |
|---|---|---|
| **Judgement error** | Difference between when the engine thinks you stepped (in music time) and the music time you actually heard when your foot landed | The constant part yes (global offset). The jitter no, and it changes scores directly. **Primary KPI.** |
| **A/V sync error** | Arrow crosses the receptor on screen at a different moment than the beat is heard | Constant part yes (draw arrows ahead by the display latency). Jitter is frame pacing. |
| **Reactive latency** | Step → receptor flash / judgment text / hit sound | No. Can only be minimized. |

### Why judgement does not depend on raw latency

The engine judges by timestamp, not by "when the frame noticed the press":

- `Player::Step` (`src/Player.cpp:2079-2258`) computes the music time of a step as
  `musicSeconds + LastBeatUpdate.Ago()*rate − tm.Ago()*rate`, where `tm` is the timestamp carried
  by the input event.
- `GameSoundManager::Update` (`src/GameSoundManager.cpp:607-645`) obtains
  `(music position, timestamp)` as a pair from the sound driver.
- The sound driver contract (`Docs/Devdocs/Sound Drivers.txt`): "when `GetPosition() == pos`,
  the first sample is being heard".
- Input drivers may deliver events late as long as the timestamp is right
  (`src/arch/InputHandler/InputHandler.h:52-64`). Polled drivers that pass a zero timestamp get
  the midpoint of the poll interval.

So the browser version, on any route, has to get exactly two things right for scoring: **the timestamp on each
input event** and **the mapping from the performance clock to the audio frame being heard**.
For reference, the native macOS HID driver stamps events when its callback runs
(`InputHandler_MacOSX_HID.cpp:22`), not with a hardware timestamp, so a browser `event.timeStamp`
is not inherently worse than native.

Timing windows this has to resolve (StepMania defaults, `src/PrefsManager.cpp` / `Player.cpp`):
the tightest default window is ±22.5 ms; competitive ITG-style play uses ±15 ms. Jitter needs to
be an order of magnitude below that.

## 3. Pipeline and measurement points

```
foot ──► pad sensor ──► USB report ──► OS ──► browser ──► main thread ──► shared ring ──► engine worker ──► GPU ──► compositor ──► panel
 T0                       T1                    T2 (event.timeStamp)  T3        T4 (dequeue) T5 (judge)   T6 (frame submit)  T7      T8 photons

mixer (AudioWorklet, frame F) ──► browser audio ──► OS/device ──► speaker
 A0                                A1 (+baseLatency)              A2 (+outputLatency)
```

| Span | Meaning | Observable from |
|---|---|---|
| T0→T2 | Device + USB + OS + browser input path | Hardware probe only |
| T2→T3 | Main-thread dispatch delay | Software |
| T3→T5 | Wait for next engine frame (0–1 frame) | Software |
| T5→T6 | Frame CPU time | Software |
| T6→T8 | Compositor + scanout + panel | Hardware probe or high-speed camera |
| A0→A2 | Audio output latency | Browser-reported (`baseLatency` + `outputLatency`), mic loopback, or probe |
| jitter of T2 vs true T1 | Timestamp quality (drives judgement error) | Hardware probe with a scheduled press train |

## 4. Proposed targets

Reference setup: Chromium desktop, wired pad over WebHID (or keyboard), wired audio, fullscreen.
To be confirmed or revised after Phase 1 produces baseline numbers.

| KPI | Target |
|---|---|
| Judgement jitter, p99 of abs(error − median) | ≤ 2 ms on WebHID and keyboard |
| Judgement jitter on Gamepad API fallback | Report the measured polling granularity; flag the path as degraded if > 4 ms |
| Audio clock map residual (perf clock ↔ heard frame) | ≤ 0.5 ms RMS between steps of the device clock; a step followed within 200 ms (revised after the first real-device runs, section 7) |
| A/V sync error after automatic compensation | within ±5 ms |
| Reactive latency, step → photon, p95 | ≤ 3 frames at 60 Hz (50 ms); ≤ 35 ms at 120 Hz and above |
| Engine-added input delay (T2→T6), p99 | ≤ 1 frame + 4 ms |
| Reported audio output latency | ≤ 30 ms wired; warn the player above 50 ms (Bluetooth) |
| Frame pacing in gameplay | ≥ 99.9 % of frames on time; zero audio underruns per song |

## 5. Browser levers, ranked by effect

| Lever | Affects | Notes |
|---|---|---|
| WebHID `inputreport` events instead of Gamepad API polling | Judgement jitter | Event per USB report with a timestamp. Chromium only. Gamepad API is sampled by the browser at an interval we must measure **(verify)**. |
| Keep the main thread idle (engine in a worker) | Judgement jitter, reactive | If `event.timeStamp` is taken at dispatch rather than at receipt, a busy main thread corrupts timestamps **(verify per input path)**. |
| Cross-origin isolation (COOP/COEP headers) | Everything | Required for SharedArrayBuffer and for fine `performance.now()` resolution; worth having on every route. Host must be able to set headers (Netlify, Cloudflare Pages, Vercel can; GitHub Pages needs a service-worker workaround). Once on, cross-origin resources (CDN scripts, fonts, analytics) must opt in or are blocked, so self-host everything. |
| `AudioContext.getOutputTimestamp()` / `outputLatency` feeding `GetPosition()` | Judgement constant error, A/V sync | Quality varies by browser and OS **(verify)**. |
| Mixing inside an AudioWorklet (128-frame quanta) | Audio latency, reactive sound | A new TypeScript mixer that never allocates in `process()`, fed from shared memory. |
| Never render pure silence (keep-awake) | Judgement constant error after a quiet stretch | Chrome takes the audio device away from a context that has rendered only zeros for 30 s; when sound returns the heard position steps by about 30 ms (section 7). The mixer writes one sample at −120 dB into each otherwise silent block. Measured: no step with it. |
| `latencyHint: 'interactive'` or explicit seconds | Audio latency | Trade against underruns; tune with the harness. |
| Display refresh rate | Reactive, A/V jitter | 120 Hz halves every frame-denominated term. Biggest single win for reactive latency. |
| Fullscreen + opaque canvas; `desynchronized: true` | Reactive (T6→T8) | Compositor bypass is platform dependent (Windows/ChromeOS; not expected on macOS) **(verify)**. As far as I know this hint exists for WebGL/2D canvases and not for WebGPU **(verify)**. |
| Late input latch (delay the start of the frame's update until just before the vsync deadline) | Reactive | Saves up to most of a frame; needs measured frame-time headroom. |
| Predictive rendering (draw arrows for the expected photon time) | A/V sync | The original has `VisualDelaySeconds` (`src/SongPosition.cpp:4,34`); set it (or its equivalent) from the measured display latency. |
| Audio start offset identical to the original | Judgement constant error | The original MP3 reader does not trim encoder or decoder delay, skips a `Xing` header frame, and plays an `Info` header frame as one frame of silence (`src/RageSoundReader_MP3.cpp:276-321`, `:437-448`). Charts are synced to that. A browser decoder that trims gapless padding would start such a file about 2,257 samples (51 ms at 44.1 kHz) early: 1,152 Info frame + 576 encoder delay + 529 decoder delay (confirmed in phase 4: Chromium's `decodeAudioData` starts such files exactly that early). No compiled decoder ships: the port picks out the MP3 frames StepMania plays and decodes them one by one with WebCodecs, which trims nothing. Checked against the native reference tool on every test file: 0 frames apart (`npm run e2e:audio`, `PLAN.md` "Phase 4 result"). |
| GPU API choice (WebGPU vs WebGL2) | ~nothing | Decide by measurement in a late-phase experiment. |

## 6. Measurement tiers

**Tier 0 — always-on software telemetry (no hardware).**
Every input event records T2, T3, T4, T5, T6 into a shared ring buffer. Audio records
`baseLatency`, `outputLatency`, `getOutputTimestamp()` samples, worklet callback interval,
underruns. Video records rAF interval, frame CPU time, missed frames, refresh rate.
Shown in an in-game HUD and exportable as JSON. Covers everything except T0→T2 and T6→T8.

**Tier 1 — human calibration.**
The engine's existing machine-sync screen (`ScreenGameplaySyncMachine`, `AdjustSync`) sets the
global offset from the player's own tapping. Measures the sum of all constant offsets plus human
bias. Good for play, not for engineering.

**Tier 2 — acoustic calibration with the laptop microphone (no extra hardware).**
Play a click track through the engine mixer and record with `getUserMedia` (processing disabled)
while the player steps on the pad near the mic. The recording contains both the clicks and the
step thumps on one clock, so their spacing is independent of microphone latency. Comparing that
spacing with the engine's computed offset for the same steps yields the constant judgement error
directly, without the player needing to be on beat. Also yields the audio round-trip.

**Tier 3 — hardware probe (about $10 of parts; planned for after the game is playable).**
A microcontroller (e.g. Raspberry Pi Pico) enumerating as a 1000 Hz USB HID gamepad, with a
photodiode taped to the screen and an audio pickup.
- Scheduled press train with a crystal-accurate period → measures timestamp jitter (judgement
  jitter) with no sensors involved.
- Press → the engine flashes a patch and plays a click through its real render and mix paths →
  measures true step-to-photon and step-to-sound latency.
- Engine-scheduled flash + click → measures display latency and audio latency separately, and
  therefore A/V sync error.
Firmware and the reporting protocol are part of this project. A 240 fps phone camera filming the
pad LED and screen is the manual fallback.

**Automated regression (no hardware).**
A headless Chromium run injects key events with known timestamps and asserts that the engine's
recorded step times match them and that T2→T6 stays within budget. Protects the software part of
the pipeline from regressions.

## 7. Latency Lab (first deliverable on every route)

A standalone static page, built before any game code, that exercises the exact browser
primitives the game will use and writes a `latency-report.json`:

1. Input: keyboard, Gamepad API, WebHID side by side — event rate, inter-report interval
   histogram, `timeStamp` vs handler time, behaviour under an artificially busy main thread.
2. Audio: AudioWorklet + shared-memory mixer skeleton; reported latencies; clock-map residual;
   underrun behaviour across `latencyHint` values.
3. Video: OffscreenCanvas in a worker driven by `requestAnimationFrame`; frame pacing; effect of
   fullscreen and `desynchronized`.
4. Tier 2 acoustic test and Tier 3 probe support.

Its results fix the final targets in section 4 and settle the open **(verify)** items.

Status 2026-11-09: built (`lab/`, `src/lab/`, run with `npm run serve`). Checked only in
headless Chrome 156, which has no real audio device, display or pad, so these show the
plumbing works and say nothing about real latency:

- Worker and main-thread clocks agree after the `timeOrigin` conversion (offset error 0 at
  the 5 µs timer resolution).
- Keyboard dispatch delay: about 0.25 ms median on an idle main thread, about 30 ms when
  the main thread is busy in 30 ms bursts. This is the case for timestamp-based judging
  and for keeping the main thread idle during play.
- Twice in three runs, the worklet skipped one 128-frame render quantum (2.67 ms)
  mid-run. Not reproduced in isolation; the suspected trigger is changing the audio graph
  (attaching the microphone) while the page is loaded **(verify)**. Design rule until
  disproved: build the audio graph once and never change it during play.
- Click detection needed hardening: normalised correlation alone accepted noise and the
  fake microphone's beeps. The round trip now uses irregular click spacing, a
  peak-to-background threshold and a requirement that all clicks agree on the lag.

First run on real hardware, 2026-11-09 (Apple M4 laptop, macOS, Chrome 156, built-in 60 Hz
display, keyboard only, no microphone; `docs/measurements/2026-11-09-mac-m4-keyboard.json`).
Pad paths (USB polling, WebHID, Gamepad API), the busy-main-thread case and the acoustic tests
were not run.

| Figure | Target | Measured |
|---|---|---|
| Clock map prediction error | ≤ 0.5 ms RMS | 0.54 ms RMS over 977 pairs (49 s). Median 0.000 ms, p95 0.68 ms, p99 2.98 ms, worst 4.42 ms. Missed by a little, and only because of the tail. |
| Skipped render quanta | none | 3 in 49 s, 2.67 ms each, no underruns counted by the browser, no microphone attached. |
| Reported output latency | ≤ 30 ms wired | 45.3 ms (5.3 base + 40.0 output). Output device not recorded. |
| Audio clock against system clock | — | 128 ppm over the run; may be the three skips rather than drift (see below). |
| `currentTime − outputLatency` against the output timestamp | — | 2.2 ms apart on average, spread −4.8 to +1.5 ms. |
| Keyboard, handler time − `event.timeStamp`, idle | — | median 3.66 ms, p99 6.27 ms, worst 7.18 ms (67 presses). |
| Frame pacing | ≥ 99.9 % on time | 99.84 % (4 late of 2,577 at 60.01 Hz); callback delay median 0.34 ms, p99 0.52 ms; frame cost 0.05 ms. |
| Worker clock against main clock through `timeOrigin` | 0 | −0.69 ms, constant (4,899 samples). |

What this settles:

- `getOutputTimestamp()` on this setup is good enough to judge by: half of all pairs are
  predicted to within a microsecond. `currentTime − outputLatency` is not: 2 ms off and
  6 ms wide. This closes the **(verify)** on that lever for Chrome on macOS.
- Skipped quanta happen on a real device without any change to the audio graph, so attaching
  the microphone is not the (only) trigger. The rule to build the graph once stays.
- Judging must use `event.timeStamp`: the handler runs 2.4 to 7.2 ms later even when the
  main thread is idle.
- Converting between threads through `performance.timeOrigin` alone is 0.69 ms off here
  (0 in headless Chrome). Section 8's timebase rule needs a measured offset at start-up; the
  Lab's shared-memory probe is the method.

Second run, same day, with the raw pairs (159 s, `docs/measurements/2026-11-09-mac-m4-audio-trace.json`,
`node tools/lab-analysis/trace.mjs <report>`). It answers the question the first run left open:

- Left alone, the device clock is exact: for 27 s and then for 52 s the heard position stayed
  within 0.01 ms of a straight line, drift 2.3 ppm. The map's error there is 0.002 ms RMS.
- The tail is steps of the heard position against the system clock: +3.9 ms at 30 s, −29.9 ms
  at 32 s, +5.2 ms at 87 s. None came with a skipped render quantum, an underrun count or a
  change of `outputLatency` (40.0 ms throughout).
- After the third step the pairs themselves were noisy (±0.6 ms, 0.41 ms RMS) for the
  remaining 70 s, and all six skipped quanta of the run fell in that stretch. They did not
  move the clock.
- So the skips were not the cause, and stepping the map by the worklet's gap would have been
  wrong.

What was built from it: the clock map (`src/shared/clock.ts`) holds back a pair that is more
than 1.5 ms off; three in a row that agree are a step, and the map starts again from them at
the rate it had; one or two are dropped as outliers. On the recorded run each step now costs
three pairs (150 ms) instead of up to 3.8 s, and nothing else is more than 1.1 ms off. The
recording is a test (`tests/clock.test.ts`, `tests/fixtures/clock-trace-mac-m4.json`). The
engine counts the steps (`ClockReport.steps`).

Target, revised: ≤ 0.5 ms RMS between steps (met: 0.002 ms on a quiet device, 0.41 ms in the
noisy stretch), and a step followed within 200 ms. An RMS over a whole run says little: one
30 ms step sets it.

What the steps are (found the same day): Chrome's own doing. A context that has rendered only
zeros for 30 s is taken off the audio device and driven by a timer; the device is started
again when the context renders sound. The run fits to the second: silence from 0 s, step at
30 s; first press of "Play 8 clicks" at 32 s, step of −30 ms; last click over at 56.5 s, step
at 86.5 s, and the noisy pairs and skipped quanta after it are the timer. Output: built-in
speakers. Reproduced without a person in muted headless Chrome
(`node tools/lab-analysis/silence-step.mjs --asleep`: +4.2 ms at 30.1 s, −31.2 ms when the
clicks start, +4.2 ms 30 s after the last click; pair noise 0.01 ms on the device, 0.3 to
0.4 ms on the timer).

What was built from that: keep-awake. The game's mixer (`src/audio/mixer-worklet.ts`, on for
every real-time context) and the Lab's worklet (checkbox, on by default) write one sample of
±1e-6 (−120 dB, alternating sign) into each block that would otherwise be all zeros. Same
experiment with it: no step, pair noise 0.01 ms throughout, 90 s. The step handling in the
map stays for what keep-awake cannot prevent (the output device changing).

Third run, microphone round trip (built-in speakers and microphone, 28.5 s,
`docs/measurements/2026-11-09-mac-m4-round-trip.json`):

- Round trip 74.547 ms on all 12 clicks, spread 0.002 ms. Clicks leave on the frame they are
  scheduled for and the path does not wander.
- That is 29.2 ms more than the reported output latency (45.3 ms). The 29.2 ms is the
  microphone path plus whatever output latency is not reported; a round trip cannot split
  them. The tap test goes around it: it compares a tap's sound with its event on one
  recording, so the microphone path cancels and what is left is unreported output latency
  plus input delay, which is the constant error the game would judge with.
- Clock map 0.002 ms RMS, worst 0.007 ms, no step, 1.6 ppm. The run ended before 30 s, so it
  does not yet show keep-awake holding on this device.

Fourth run (141.5 s, round trip and tap test, `docs/measurements/2026-11-09-mac-m4-keep-awake-tap.json`):

- Keep-awake holds on the laptop: no step in 141.5 s, 40 s of it silent at the start. Clock
  map 0.002 ms RMS, worst 0.007 ms, over 2,822 pairs; 2.4 ppm; no skipped quantum after
  start-up; no underrun. The clock target is met with a wide margin.
- Round trip 72.238 ms, spread 0.002 ms. 2.3 ms less than in the third run: constant within
  a session, different between sessions (the microphone path is set up anew each time). The
  tap test therefore has to use the round trip of its own session, as it does.
- Keyboard handler − `event.timeStamp`, idle: median 3.79 ms, p99 7.89 ms (62 presses), as
  in the first run.
- Tap test: no result. 39 sounds were detected for 17 taps, the keys are quiet (peak 0.023
  against 0.236 for the clicks), and the nearest-sound matching it used then gave errors
  from −129 to +42 ms. Its median of 13 ms is not a measurement.

Built from that: the tap test now counts only taps whose sound sits at the same distance
from the event (within 5 ms; `matchTaps` in `src/shared/onset.ts`), reports each tap, and
marks the result not accepted when fewer than 8 taps or 60 % agree.

Still open: the constant judging error (tap test with the new matching, or the game's own
sync screen later), and whether the sound itself moves at a step (it no longer arises in
play).

Not measurable by the Lab in software: switch-to-browser input delay (the tap test covers
it acoustically) and frame-start-to-photon delay (hardware probe, after v1 is playable).

### The game's own path (phase 5)

How the game uses the above (`src/game/`, `PLAN.md` "Phase 5 result"):

- Key events are stamped with `event.timeStamp` into a shared ring on the main thread. The
  worker turns each timestamp into music time with the clock map, which the main thread
  publishes into shared memory after every pair (a sequence counter guards the read).
- The worker measures its clock against the main thread's at start-up and corrects the
  `timeOrigin` conversion by what it finds.
- Hits are judged at their own timestamps. What the clock alone decides (misses, hold
  results) is applied 40 ms behind the present, so that an input still on its way to the
  worker is not overtaken. The worker counts inputs that arrive later than that.
- The field is drawn for the frame's own time plus `visualLeadMs` (0 until display latency
  is calibrated). A global offset, in StepMania's sense, is added to the heard music time
  (0 until calibration; typed in by hand on the play page).

Figures, headless Chrome 156 on the Apple M4 (`npm run e2e:game`, 2026-11-09). No display,
no audio device: they cover the software path only.

| Figure | Target | Measured |
|---|---|---|
| Judged offset against the offset an input was given (22 hits) | jitter p99 ≤ 2 ms | median 0.0000 ms, worst 0.0004 ms from it |
| Timestamps of real key events at the judge | `event.timeStamp` | identical, 80 of 80 |
| Input to end of the first frame drawn with it (T2→T6) | p99 ≤ 1 frame + 4 ms (20.7 ms) | p50 8.9 to 9.7 ms, p99 17.2 to 18.1 ms in three runs |
| Inputs arriving after judging had passed their time | none | 0 of 80 |
| Frame pacing | ≥ 99.9 % on time | 100 %: 0 late of 694; 0 late of 7,924 over a whole song |
| Frame cost | — | 0.1 ms median, 0.28 ms p99 |
| Worker clock through `timeOrigin` | 0 | −0.005 ms, corrected |
| Audio clock map over a whole song | ≤ 0.5 ms RMS | 0.002 ms RMS, worst 0.007 ms, no step |

Not measured yet: any of this with a person at the keyboard on the real display and
speakers. The play page prints the same figures after each song.

## 8. Clock rules for the implementation

- One timebase: `performance.now()` expressed in the main thread's time origin. Worker time
  origins differ, so every thread converts through `performance.timeOrigin`. (Compile route:
  this backs the engine's `RageTimer` via `ArchHooks::GetMicrosecondsSinceStart`.)
- Input timestamps are `event.timeStamp` (main-thread origin) converted into that timebase before
  they enter the shared ring. Never stamp at dequeue time.
- The audio position used for judging is the AudioContext frame currently being *heard*:
  `H(t) = (contextTime + (t − performanceTime)) × sampleRate` from `getOutputTimestamp()`.
  (Compile route: this is the sound driver's "hardware frame"; the worklet passes `currentFrame`
  as the frame at which its buffer will be heard and `H(now)` as the current frame, matching the
  CoreAudio driver's use of host time, `src/arch/Sound/RageSoundDriver_AU.cpp:223,369-371`.)
