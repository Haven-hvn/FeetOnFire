# Implementation route: options, effort, risk

Status: **decided 2026-11-09 — Route B (TypeScript rewrite), scoped to a defined v1.** See
"Decision" at the end and `PLAN.md`. The comparison below is kept as the record of what was
weighed; my recommendation (A) was not taken.

Written 2026-11-09 from three read-only sweeps of
`stepmania-5_1-new/` (rendering, file formats, portability). Nothing has been built or installed.
Effort figures are judgement, not measurement: treat them as ±50 % and as a way to compare
routes, not as a schedule.

Latency is not a differentiator. All three routes use the same browser APIs for input, audio and
presentation, and the latency-critical code (input timestamping, audio clock map, frame pacing)
is new code on every route. See `LATENCY.md`.

## Facts that drive the comparison

| Fact | Source |
|---|---|
| Core engine is ~239k LOC C++ plus ~56k LOC platform code | `src/`, `src/arch`, `src/archutils` |
| Gameplay core is ~18k LOC; `Player` is an `ActorFrame`, so judging is tied to the actor/Lua system | `src/Player.h:43` |
| Format + timing core is ~23k LOC with few singleton references; 4 of its files include `LuaBinding.h` | `NotesLoader*`, `TimingData`, `NoteData`, `Song`, `Steps`, `NoteTypes` |
| Six chart formats, dispatched SSC → SMA → SM → DWI → BMS → KSF, with parser quirks and SSC version thresholds | `src/NotesLoader.cpp:32-70`, `src/MsdFile.cpp` |
| Themes and noteskins are Lua: 21k lines of Lua, 1,625 Lua-bound engine methods, 271 Lua files in `NoteSkins/` | `Themes/`, `NoteSkins/`, `ADD_METHOD` |
| The only working renderer is fixed-function desktop OpenGL (2,856 LOC) plus 15 legacy GLSL shaders; the GLES2 file is a dead skeleton | `src/RageDisplay_OGL.cpp`, `src/RageDisplay_GLES2.cpp` |
| The renderer interface is 43 pure virtuals (+3 for compiled geometry); a null renderer exists | `src/RageDisplay.h`, `src/RageDisplay_Null.cpp` |
| The main loop is a blocking `while(!UserQuit())`; several screens run nested blocking loops | `src/GameLoop.cpp:317`, `src/ScreenReloadSongs.cpp:38` |
| The engine always starts threads (music, decode, background loader, stream buffers) | `src/GameSoundManager.cpp:452`, `RageSoundDriver_Generic_Software.cpp:192` |
| The build knows only Windows, macOS and Linux; any other platform hits `#error Which arch?` | `StepmaniaCore.cmake:175-353`, `src/arch/arch_default.h` |
| 11 vendored libraries are empty directories (ogg, vorbis, zlib, libpng, ffmpeg, IXWebSocket, mbedtls, hidapi, libusb, libtomcrypt, libtommath); the last two have copies under `src/` | `extern/` |
| Null drivers exist for display, sound, movies, memory cards, loading window, dialogs; none for ArchHooks, window or threads | `src/arch/` |
| No simfile-loader tests and no headless dump mode exist upstream | `src/tests/` |
| Shipped assets: `_fallback` + `default` themes 22 MB (1,192 files), noteskins 16 MB (1,547 files) | `Themes/`, `NoteSkins/` |

## Route A — compile the C++ engine to WebAssembly (Emscripten)

**What you get:** the whole game with original behaviour: every chart format and parser quirk,
judging, scoring, all modifiers, courses, edit mode, every game type, profiles, and existing
themes and noteskins unmodified.

**Work**

| Package | Size |
|---|---|
| Build: new platform branch in CMake and `arch_default.h`; supply ogg/vorbis/zlib/libpng (Emscripten ports); switch off ffmpeg, libusb/hidapi, GLEW and networking (`NetworkManager` is not behind the existing `WITHOUT_NETWORKING` guard) | 1–2 wk |
| Headless boot: ArchHooks, window, loading-window drivers; engine on a worker thread; filesystem (in-memory + OPFS); null display and sound | 1–2 wk |
| WebGL2 renderer: 43 methods, one shader emulating the fixed-function paths (texture modes, alpha test, 1 light, sphere map, 11 blend modes), port of the 15 effect shaders, quads → indexed triangles, paletted textures converted on upload | 4–6 wk |
| Main loop as a per-frame step driven by `requestAnimationFrame`; nested loading loops handled | ~1 wk |
| Sound driver on AudioWorklet, using the engine's existing lock-free `Mix()` | ~2 wk |
| Input driver: keyboard, Gamepad API, WebHID, pre-stamped events through a shared ring | 1–2 wk |
| Import (folder / zip picker), persistence, asset packaging (themes as one zip mounted by the existing zip driver) | 1–2 wk |
| Startup time, download size, frame-time tuning | 2–4 wk |

Total: roughly **4–5 months** to a full playable game, about 7–10k lines of new code plus patches
to existing files. Video backgrounds are off until a WebCodecs movie driver is written.

**Risks**

| Risk | Level | Note |
|---|---|---|
| Nothing is visible until build, loop, filesystem and renderer all work | High | Mitigated by staging: headless boot first, then renderer, audio, input. |
| Renderer fidelity: theme effects that depend on a fixed-function corner I did not emulate | Medium | Bounded surface (43 methods); compare screenshots against the native build. |
| Unknown porting faults in a large desktop codebase (function-pointer signature mismatches trap in WASM, thread start-up order, blocking calls) | Medium | Only a trial build reveals them. This is what the spike below tests. |
| Download and startup: ~40 MB of assets before trimming, plus the engine binary | Medium | Trim noteskins and drop the `legacy` theme; lazy-load. **(verify)** |
| Threads make cross-origin isolation mandatory, not just recommended | Low | Already planned; needs a host that can set COOP/COEP headers. |
| AudioWorklet calling into the threaded WASM module | Medium | Emscripten supports it, but the combination with pthreads needs checking **(verify)**. Fallback: mix on a thread into a shared ring, at the cost of a few ms. |
| Mobile and Safari: memory ceiling, no WebHID | Medium | Desktop Chromium is the reference target on every route. |
| Slow debug loop (large rebuilds, WASM stack traces) | Low–Medium | Costs time, not correctness. |

## Route B — rewrite in TypeScript

**What you get:** a small, fast-loading game that plays StepMania charts. Only what is
reimplemented exists. Existing themes and Lua noteskins cannot be loaded: that would need the
1,625-method Lua API, which is most of the engine.

**Work**

| Package | Size |
|---|---|
| Parsers: SM + SSC | 2–3 wk |
| Parsers: SMA, DWI, BMS, KSF and the quirks | +3–5 wk |
| Timing (BPM, stops, delays, warps, speed/scroll/fake segments) | 1–2 wk |
| Gameplay: taps, holds, rolls, mines, lifts, judging, life, score, combo | 3–4 wk |
| Note field rendering, speed mods, one built-in noteskin | 2–3 wk |
| Audio engine in an AudioWorklet (decoders are still libmad/vorbis compiled to WASM, for sync) | ~2 wk |
| Input (same as route A) | 1–2 wk |
| Song select, options, results, profiles UI | 3–4 wk |
| Import and persistence | 1–2 wk |

Total: **2.5–3.5 months** for a minimum game (dance single/double, SM + SSC, default windows and
scoring). Parity with the original's gameplay features (about 100 modifiers, courses, attacks,
all six formats, background animations, edit mode, other game types) is **another 6–12 months
and open-ended**. Roughly 12–15k lines for the minimum, 30–45k for near-parity.

**Risks**

| Risk | Level | Note |
|---|---|---|
| Behaviour drift: a chart parses or times slightly differently from StepMania, so sync or scoring is off | High | Needs differential tests against a reference. No upstream tests exist, so the reference has to be built anyway (native or WASM). |
| Scope never converges on "StepMania" | High | Every missing feature is a new project. |
| Garbage-collection pauses in the game loop and mixer | Medium | Manageable with allocation-free hot paths; measured by the Latency Lab. |
| Community content that depends on themes, Lua noteskins or scripted backgrounds does not work | Certain | By design. |

## Route C — hybrid: parsers, timing and decoders as WASM; everything else in TypeScript

**What you get:** route B's small game, but chart loading and beat/time conversion are the
original code, so all six formats and their quirks are exact from day one. Gameplay, UI and
noteskins are still rewritten, because judging lives in `Player`, which cannot be lifted out
without the actor and Lua systems.

**Work:** route B minus the parser and timing packages (saves 6–10 weeks and most of the
differential testing), plus 1–2 weeks to extract the format core behind stubs for the handful of
singletons it touches (`Song.cpp` is the most entangled; the four files with Lua bindings need
those compiled out or Lua linked in).

Total: **2–3 months** for the same minimum game, with full format coverage. Gameplay parity
remains open-ended as in route B. The WASM module is single-threaded and around 1–2 MB.

**Risks**

| Risk | Level | Note |
|---|---|---|
| Extraction pulls in more of the engine than expected | Medium | `Song.cpp` touches the filesystem, cache and audio length detection. Fallback is to compile more and stub less. |
| Gameplay drift (judging, holds, scoring, modifiers) | Medium–High | Same as route B, minus the parsing and timing part. |
| Two languages and a data boundary to maintain | Low | Charts cross once at load, as flat arrays. |
| No themes or Lua noteskins | Certain | As route B. |

## Side by side

| | A: compile | B: rewrite | C: hybrid |
|---|---|---|---|
| Chart formats exact | Yes, all six | Only as reimplemented | Yes, all six |
| Judging / scoring / modifiers exact | Yes | Reimplemented | Reimplemented |
| Existing themes, noteskins, Lua | Yes | No | No |
| Time to something playable | ~3 months | ~2.5–3.5 months | ~2–3 months |
| Time to full StepMania feature set | ~4–5 months | 9–15+ months, open-ended | 8–14+ months, open-ended |
| Download size | Large (tens of MB) | Small | Small |
| Main risk | Integration: late first frame, porting unknowns | Fidelity and unbounded scope | Gameplay fidelity and scope |
| Mobile-friendly | Weak | Good | Good |
| Latency | Same | Same | Same |

## What is shared (no regret on any route)

- The Latency Lab and its report format.
- The browser side of input (keyboard, Gamepad API, WebHID, WebUSB for vendor boards) and the
  timestamp/ring design.
- The AudioWorklet output path and the clock map.
- File import, OPFS persistence, cross-origin-isolated static hosting.
- libmad and vorbis decoders compiled to WASM.
- The first step of route A (a headless WASM build that loads songs) produces exactly the module
  route C needs, and the test reference route B needs.

## Recommendation

**Route A, behind a time-boxed spike, with route C as the fallback.**

1. Latency Lab first (shared, about 2 weeks). It also settles the proposed targets.
2. Spike, 1–2 weeks: build the engine headless with Emscripten (null display and sound), boot it
   in a worker, load the three bundled songs and dump the parsed charts. Pass: it boots and the
   charts match a native reference dump. Fail or overrun: stop and switch to route C, reusing the
   toolchain, filesystem and decoder work.
3. If it passes: renderer, then audio, then input, measured against the Lab at each step.

Reasons: the request is a port of StepMania, and A is the only route that yields one; the code
most likely to drift in a rewrite (judging, holds, scoring, modifiers) comes for free; A costs no
latency control, because that code is new on every route; and A's main risk can be tested cheaply
before committing, with the result reusable either way.

What would change it: if existing themes, Lua noteskins and full modifier fidelity are not
needed, and small download or phone support matter more, choose C. I do not recommend B on any
assumption: C gives the same shell with exact parsers for less work.

## Decision (user, 2026-11-09)

1. **Route B**: TypeScript rewrite, StepMania source as the behaviour reference. No C++ compiled
   to WASM, hybrid included. Nothing compiled ships (this also rules out libmad/vorbis WASM
   decoders; see `LATENCY.md` section 5).
2. Scope is a defined v1, not the full feature set: SM and SSC only, 4-panel gameplay, a built-in
   noteskin. Latency Lab first.
3. Themes and Lua noteskins are not required. Same song files, same timing and scoring is enough.
4. Desktop Chromium is the reference browser: WebHID, with Gamepad API and keyboard as fallback.
5. Publishing: **not answered yet** (the reply contained a placeholder). Until it is, nothing is
   deployed and no songs are bundled.
6. Toolchain: Node only, no emsdk. A small native reference tool may be built from the original
   parser and timing code to verify note times and audio start offset; it is a test aid only.
7. Measurement: software and microphone tiers now; hardware probe planned for after the game is
   playable.

## Decisions needed (as asked; superseded by the section above)

1. Route: A with spike (recommended), C, or B.
2. Are existing themes and Lua noteskins a requirement, or is "plays the same song files with the
   same timing and scoring" enough?
3. Reference browser: desktop Chromium first (WebHID exists only there)?
4. Will this be published? libmad is GPL, so a public build with MP3 support must offer source;
   the bundled songs may not be sold. A permissively licensed MP3 decoder is possible but must be
   checked for identical sync.
5. Permission to install the toolchain (emsdk, Node) and download the missing libraries once a
   route is chosen.
6. Build the ~$10 hardware latency probe, or stay with software and microphone tiers for now?
