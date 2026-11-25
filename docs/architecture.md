# Architecture

Nine print model hub is a Windows Electron application. Its SQLite catalog keeps
references to source files on disk. The viewer creates geometry for display and
the desktop process handles file operations, OpenSCAD jobs, and Studio handoff.
New capabilities are added through the source entry points below and rebuilt.
See the [README](../README.md) for usage and [AGENTS.md](../AGENTS.md) for change
and publication rules.

## Runtime boundaries

```text
React UI -> window.nine -> main-process IPC -> Library -> SQLite and source files
ModelViewer -> format adapters and workers -> Three.js
ThumbnailBatch -> hidden renderer -> validated image save -> next job
ModelThumbnail -> nine-thumb://library/<id>/<revision> -> SQLite image BLOB
MCP client -> stdio server -> read-only SQLite connection
```

[`main.cjs`](../electron/main.cjs) accepts library IPC only from the main window
and its main frame. The separate thumbnail preload exposes input, complete, and
fail calls. Main validates the active thumbnail worker, frame, job token, and
cancellation state before accepting those calls.

Both windows use sandboxing, context isolation, disabled Node integration, and
HTML content security policies. Vite builds `index.html` and `thumbnail.html`
with relative asset paths so that the packaged app loads its scripts and WASM
locally. [MCP](mcp.md) is a separate stdio process that starts on client request.
It opens the catalog read-only and serves bounded metadata queries, saved SCAD
presets, and cached thumbnails. `get_model` requires launcher and request opt-in
to return local source paths or notes.

## Change entry points

| Change | Start here | Related verification |
| --- | --- | --- |
| Search, sorting, selection, file actions | `src/App.jsx`, `src/components/ModelContextMenu.jsx` | Context-menu smoke and affected UI flow |
| Camera, materials, viewport lifecycle | `src/components/ModelViewer.jsx`, `src/components/model-viewer-engine.js` | Electron render and preview-memory smoke |
| Format adapters and mesh transfer | `shared/formats.json`, `src/formats/index.js`, the format adapter, `src/formats/mesh-worker*.js`, `src/formats/mesh-transfer.js` | `tests/formats.test.mjs`, small fixtures |
| 3MF range-read fallback | `electron/three-mf-thumbnail.cjs`, `src/components/ModelViewer.jsx` | `tests/three-mf-thumbnail.test.cjs`, preview-memory smoke |
| OpenSCAD parameters, rendering or part export | `electron/scad-parameters.cjs`, `electron/scad-engine.cjs`, `src/components/ScadPanel.jsx` | OpenSCAD tests and `scripts/smoke-scad.mjs` |
| OpenSCAD presets | `electron/scad-presets.cjs`, `src/components/ScadPresetControls.jsx`, `src/components/useScadWorkspace.js` | `tests/scad-presets.test.cjs`, OpenSCAD smoke |
| Registration, watching, metadata or schema | `electron/library.cjs`, `electron/library-store.cjs` | `tests/library.test.cjs` |
| Bambu Studio print handoff | `electron/bambu-print.cjs` | `tests/bambu-print.test.cjs` |
| Native feature or new renderer capability | Guarded handler in `electron/main.cjs`, named API in `electron/preload.cjs` | Backend test plus actual IPC smoke |
| Agent discovery and catalog reads | `electron/mcp-server.cjs`, `electron/mcp-catalog.cjs` | MCP client and SQLite reader tests |
| Memory policy | `shared/preview-memory.json`, CJS/ESM policy helpers | `tests/preview-memory.test.mjs`, reader/adapter cases |
| Thumbnail scheduling, report persistence and renderer lifecycle | `electron/thumbnail-batch.cjs`, `electron/thumbnail-batch-store.cjs`, `electron/thumbnail-worker.cjs` | Batch/store/worker tests, thumbnail smoke |
| Thumbnail image composition | `src/thumbnail-worker.js` | Nonblank-image checks in thumbnail smoke |
| Thumbnail delivery | `electron/thumbnail-protocol.cjs`, `src/components/ModelThumbnail.jsx` | Protocol tests, thumbnail smoke |
| Packaging or STEP runtime assets | `vite.config.js`, `scripts/copy-occt.mjs`, package build configuration | Build, package, packaged STEP/thumbnail smoke |

## Library state and persistence

`Library` opens `library.sqlite3` under Electron's `userData` directory.
[`shared/app-profile.cjs`](../shared/app-profile.cjs) resolves the `Nine Model Library`
profile under Windows app data for both Electron and MCP. `NINE_DATA_DIR`
overrides that directory. UI snapshots add transient scanning status and system
memory information.

SQLite uses row-level updates, transactions, foreign keys, and WAL. Main retains
a metadata projection that the renderer uses to filter, sort, and mount 48 cards
per page. Catalog snapshots carry thumbnail presence and revision. The main UI
session serves each image as a binary BLOB through `nine-thumb://library/<id>/<revision>`
after validating the model ID and current revision.

The catalog persists:

| Field | Contract |
| --- | --- |
| Models | ID, name, absolute path, format, size, modified/added timestamps, missing state, favorite, tags and notes |
| Thumbnails | BLOB, MIME and revision per model |
| `folders` | Watched folder records `{ id, path }` |
| `settings` | Bambu/OpenSCAD paths, manual read budget, lightweight policy and unrelated inherited keys |
| `excludedPaths` | Normalized paths suppressed after registration-only removal |
| `model_path_aliases` | Durable associations for relinked IDs and path hash collisions |
| `scad_presets` | Named OpenSCAD parameter overrides per model |
| `thumbnail_batch_report` | Latest thumbnail run status and counts |

Existing registrations keep their IDs. An initial ID is normally a truncated
SHA-256 of a normalized path. Later operations resolve the registered path
through the path index, and confirmed relinks retain the original logical ID.
Move detection marks the old path missing and may register the new path
separately. Relink reuses the old ID, preserves its presets and metadata, and
invalidates the cached image. It can remove a duplicate registration after
confirmation only when the duplicate has no independent user data. Identical
contents at different paths can still be registered separately.

Mutations use a promise queue and publish after committing. The initial legacy
`library.json` import validates the data, commits it as a unit, and retains the
original file. The SQLite schema 1-to-2 migration adds durable path bindings.
Unreadable data triggers a startup error. The first window uses the stored
catalog while watcher reconciliation runs in the background.

Chokidar watches recursively without following symlinks, waits for stable writes,
and ignores application data and common repository/dependency directories.
Startup reconciliation reuses paths and file stats from the initial discovery
events. Registered paths absent from those events receive individual checks.
An unchanged watch-root set reuses the existing watcher. A manual rescan reads
the chosen folders directly. Changed size or mtime invalidates the thumbnail.
An unlink marks the entry missing, and reappearance can revive it. Removing a
watch root keeps its registrations. Explicit import clears a registration-only
removal exclusion for that path.

## Geometry and preview limits

`loadModel(bytes, options)` selects an adapter by filename and supplies a cancel
signal and calculated limits. Geometry adapters return an `Object3D` in
millimeters with Z up, along with warnings and optional metadata. A 3MF with
only an embedded preview returns `object: null`, `previewImage`, and
`metadata.previewOnly`.

| Foreground input | Processing |
| --- | --- |
| STL below 256 KiB | Direct parse in the viewer, with coordinates interpreted as millimeters |
| STL at or above 256 KiB | Dedicated parsing worker |
| 3MF | Dedicated parsing worker with compact XML vertex and triangle rows |
| STEP / STP | Local OpenCascade WASM in a classic worker |
| OpenSCAD | Main runs OpenSCAD to generate a temporary STL, then uses the STL path |

The viewer sets `offThread` and transfers owned input with `consumeInput`.
STL and 3MF workers transfer mesh arrays with precomputed bounds. Workers use a
180-second deadline and terminate on completion, failure, or cancellation.
The thumbnail renderer shares the format adapters, with 3MF XML parsed in its
isolated renderer and STEP converted in its WASM worker. The 3MF adapter resolves
object IDs within each archive part and applies component/build transforms and
units. It builds indexed geometry, preserves color boundaries at triangle corners,
and uses flat shading to preserve the face normals. It rejects cycles and reports
unsupported paint or material features.

In lightweight mode, selecting a model shows catalog data and any cached image.
An explicit preview starts loading. WebGL starts after a usable mesh is ready,
draws on demand, and is released on close, replacement, or reload. Auto-rotation
requests additional frames while visible. Changing the selection or cancelling
the preview aborts its pending read or conversion. Camera fitting and explicit
reloads call the viewer directly. A memory setting saved by itself applies to
the next load. Save-and-reload supplies the persisted budget for the current
model, and a SCAD update supplies the selected parameter values for that render.

When a foreground 3MF load fails, [`three-mf-thumbnail.cjs`](../electron/three-mf-thumbnail.cjs)
can read the central directory and one PNG or JPEG by range from the source ZIP.
The fallback bounds the directory and image sizes, validates the selected image,
and sends its bytes through IPC. The viewer releases the temporary object URL
when the image is replaced or the viewer closes.

[`shared/preview-memory.json`](../shared/preview-memory.json) defines the limits
for both main and renderer. Lightweight mode uses 512 MiB. The saved manual
budget defaults to 2048 MiB and accepts integers from 512 to 32768 MiB. An
explicit detail retry can use a higher saved budget and enable full-quality
rendering for the current preview. The budget scales input and geometry limits.
Actual process memory depends on the geometry and rendering workload.

Main checks file size before allocation, reads in chunks, and checks size and
mtime after the read. Adapters enforce separate limits for expanded archive/XML
data, triangles, instances, and depth. Keep both file and format checks when
adding loaders.

## OpenSCAD source files

The parser reads public literal declarations from the main SCAD file's
Customizer header. It does not evaluate source expressions. The main process
validates the incoming type and optional range/enum, then passes each override to
OpenSCAD as a CLI argument. The original source stays in place to resolve
relative project dependencies.

Preview, thumbnail, export, and print preparation share a single OpenSCAD
process slot. Thumbnail jobs render source defaults to keep library images
stable. Applying a preset updates the editor values for the next explicit
preview.

Presets store public overrides per model and validate against its current
parameter definitions on save and use. Customizer JSON carries preset names and
parameter values.

STL export passes the current overrides, optionally replacing one enum with
the selected part values. Jobs are sequential, check the source before render
and save, and use exclusive copies into the chosen destination. Output filenames
for a part are independent of which other parts were selected. The UI skips
recognizable assembly and preview options in the all-parts list. It leaves
those options available in the explicit selection modes.

## Bambu Studio handoff

[`bambu-print.cjs`](../electron/bambu-print.cjs) launches the verified Studio
executable without a shell. It passes the original STL, STEP, or 3MF by path.
For SCAD it stages a bounded temporary STL with the current parameters. A
successful handoff means the launch request with the file path was accepted.
Printer selection, plate settings, slicing, and final send confirmation take
place in Studio.

## Thumbnail runs

`ThumbnailBatch` is an Electron-independent controller with injected generation,
save, and report-persistence functions. Single-item and bulk requests use the
same instance and cannot overlap. Bulk targets are a snapshot of the complete
library, independent of UI filters, with the memory budget captured at start.
Bulk runs skip missing files and keep existing thumbnails unless overwrite is
requested. A single-item request regenerates that item even if an image exists.

The worker keeps one hidden window and WebGL renderer during a healthy batch.
Each assigned job has its own token and validated IPC. The worker disposes model
and scene resources before it reports completion. Main checks source freshness
and awaits image persistence before advancing. The 90-second timeout covers
reading, parsing, and rendering. An atomic save already in progress can finish.
The window closes at the end of a run. Cancellation, timeout, or renderer
failure also discard it. Later jobs can start a fresh window if the run
continues. Ordinary malformed-model failures retain the healthy window.

`processed = succeeded + failed + skipped`. Cancellation can leave it below
`total`. Reports carry counts, scope, timestamps, the current item, and errors.
[`ThumbnailBatchStore`](../electron/thumbnail-batch-store.cjs) persists the latest
run in SQLite and reads the earlier `thumbnail-batch.json` when SQLite has no
report. `ThumbnailBatch` restores the report and marks a previously running or
stopping run as cancelled. `reportError` exposes persistence problems to the live UI.

Batch saves pass an expected source to `saveThumbnail()`, which checks the
registered path/size/mtime and the actual file before committing the image.
The viewport passes an expected source as well. Background work should always
validate the file that produced its derived image before it saves it.

## Copy, registration removal, and trash

The native file operations differ in their effect on the source and catalog.

| Operation | Filesystem behavior | Registration behavior |
| --- | --- | --- |
| `copyModel` | Native destination chooser with `COPYFILE_EXCL`. Duplicate or same-source destination fails | Keeps the original. A watched destination is discovered normally |
| `removeItem` | No source-file change | Remove entry and suppress automatic re-registration |
| `trashModel` | Native Cancel-default confirmation, then `shell.trashItem` | Removes after a successful move to the Recycle Bin. Restoration can register again |

Copy and trash capture the source before a native dialog and revalidate after it.
The snapshot checks registration time and filesystem identity as well as path,
size, and mtime. Trash uses the library mutation queue to preserve ordering with
watcher and image-save jobs. Its test substitutes a move within a fixture folder.

## Build and verify

Run from the repository root on Windows.

```text
npm ci
npm test
npm run build
```

`npm run dev` and `npm run build` copy the OpenCascade JS and WASM files from the
installed dependency to `public/occt/`. Packaging builds both Vite entry points,
keeps one copy of the STEP runtime, and ships the bundled dependency licenses.
`npm run package` writes the Windows folder application under `release/win-unpacked/`.

| Command | Coverage |
| --- | --- |
| `node scripts/smoke.mjs` | Format dimensions, watcher, catalog actions, persistence |
| `node scripts/smoke-memory.mjs` | Preview limits, image fallback, explicit detail retry |
| `node scripts/smoke-thumbnails.mjs` | Worker reuse, sequential generation, cancellation, image delivery |
| `node scripts/smoke-context-menu.mjs` | File actions through Electron IPC with fixture dialogs and trash |
| `node scripts/smoke-scad.mjs` | SCAD preview, presets, export, and relink. Requires OpenSCAD installed |
| `node --test tests/mcp-server.test.cjs` | stdio tool discovery and read-only catalog access |

For a packaged smoke run, append `--packaged` and optionally
`--release-dir=<build-directory>`. For packaged MCP tests, set
`NINE_MCP_PACKAGED_DIR` to the `win-unpacked` directory. The Electron smoke
scripts use isolated profiles under `output/playwright/`. For custom GUI tests,
set `NINE_DATA_DIR` to an isolated directory. `NINE_TEST_MODE` only bypasses the
single-instance lock. Keep generated assets, release output, test logs, and
real-library data outside commits.
