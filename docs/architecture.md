# Architecture and change guide

Nine Model Library separates native file management, geometry loading, and the
desktop UI. Features are added in source and rebuilt; there is no runtime plugin
installer. The application keeps references to original files and uses derived
geometry only for display.

## Runtime boundaries

```text
React UI (src/App.jsx and components)
    | window.nine: named, argument-limited calls and subscriptions
    v
electron/preload.cjs -> electron/main.cjs -> Library
                                          | serialized mutations
                                          v
                                    library.json + watched files

ModelViewer -> loadModel -> STL / STEP / 3MF adapters -> Three.js
                               |
                               + STEP: dedicated local WASM worker

ThumbnailBatch -> one hidden BrowserWindow per item
    |                 | window.nineThumbnail (separate preload)
    |                 v
    |          src/thumbnail-worker.js -> same loadModel adapters
    v
destroy worker -> validate source -> save image -> advance
    |
    +-> thumbnail-batch.json (progress and result only)
```

`main.cjs` creates the normal window and handles native dialogs and application
launch. `handle()` rejects IPC from another webContents or a subframe. The hidden
thumbnail window gets `thumbnail-preload.cjs`, which exposes only input, complete,
and fail calls; it does not get the library-management API. Its IPC also checks
the currently active worker, frame, abort signal, and batch status.

Both windows run with Node integration off, context isolation and sandboxing on.
Their HTML files contain CSPs. Keep local WASM loading compatible with those
boundaries instead of weakening them to fix a loading error. Vite builds both
`index.html` and `thumbnail.html` with relative asset paths for packaged `file://`
loading.

## Change entry points

| Change | Start here | Related verification |
| --- | --- | --- |
| Search, sorting, selection, file actions | `src/App.jsx`, `src/components/ModelContextMenu.jsx` | Context-menu smoke and affected UI flow |
| Camera, materials, viewport lifecycle | `src/components/ModelViewer.jsx` | Format dimensions plus actual Electron render |
| New format or format correction | `src/formats/index.js`, individual adapter, `shared/formats.json` | `tests/formats.test.mjs`, small fixtures |
| Registration, watching, metadata or schema | `electron/library.cjs` | `tests/library.test.cjs` |
| Native feature or new renderer capability | Guarded handler in `electron/main.cjs`, named API in `electron/preload.cjs` | Backend test plus actual IPC smoke |
| Memory policy | `shared/preview-memory.json`, CJS/ESM policy helpers | `tests/preview-memory.test.mjs`, reader/adapter cases |
| Thumbnail scheduling | `electron/thumbnail-batch.cjs`, main worker lifecycle | `tests/thumbnail-batch.test.cjs`, thumbnail smoke |
| Thumbnail image composition | `src/thumbnail-worker.js` | Nonblank-image checks in thumbnail smoke |
| Packaging or STEP runtime assets | `vite.config.js`, `scripts/copy-occt.mjs`, package build configuration | Build, package, packaged STEP/thumbnail smoke |

## Library state and persistence

`Library` owns `library.json` under Electron's `userData` directory.
`NINE_DATA_DIR` overrides that directory. `NINE_TEST_MODE` bypasses the
single-instance lock; it does not select a separate directory or disable file
operations. UI snapshots include transient `status` and OS memory information
under `system`; those fields are not part of the persisted library schema.

The persisted `schemaVersion: 1` contains:

| Field | Contract |
| --- | --- |
| `items` | Records with `id`, `name`, absolute `path`, `format`, byte `size`, ISO `modifiedAt`/`addedAt`, `missing`, `favorite`, `tags`, `notes`, and optional image `thumbnail` data URL |
| `folders` | Watched folder records `{ id, path }` |
| `settings` | `bambuPath`, `memoryBudgetMiB`; preserve unrelated keys during changes |
| `excludedPaths` | Normalized paths suppressed after registration-only removal |

IDs are a truncated SHA-256 of a resolved, case-folded path. Identical contents
at different paths are separate entries. A rename or move produces a missing
old entry and a separately registered new path. Do not change that identity
rule without a migration plan.

Mutations use a promise queue. Persistence writes a temporary file beside the
library and renames it over the destination; it then broadcasts a state snapshot.
Startup refuses unreadable/corrupt existing JSON rather than overwriting it.
Missing or invalid saved memory settings migrate to the configured default.

Chokidar watches recursively, waits for stable writes, and ignores application
data and common repository/dependency directories. Startup and explicit rescan
also reconcile files. A changed size/mtime invalidates the thumbnail while
preserving user metadata. Unlink marks an entry missing; reappearance can revive
it. Removing a watch folder keeps items. Registration-only removal adds an
exclusion; explicit file import removes that exclusion.

## Geometry and preview limits

`loadModel(bytes, { filename, signal, memoryBudgetMiB })` chooses an adapter and
passes `{ filename, signal, limits }`. Normal results contain an `Object3D`,
`unit: 'mm'`, warnings, and optional metadata. Image-only 3MF results use
`object: null`, `previewImage`, and `metadata.previewOnly`. Both viewport and
thumbnail code must handle that result without inventing geometry or dimensions.

The shared coordinate contract is Z up and millimeters. STL lacks unit metadata
and is interpreted as millimeters. STEP runs OpenCascade in a classic worker,
with a 180-second conversion timeout and termination on cancellation. Its JS and
WASM runtime files are copied from the installed dependency; edit the worker
source, not generated vendor assets.

3MF has a dedicated reader. It resolves ZIP model paths and object IDs together,
applies component/build transforms and unit conversion, rejects cyclic or
over-budget structures, and supports saved-preview fallback when geometry is
absent. Do not replace it with a generic loader without preserving those cases.
Unsupported paint/material features produce warnings; Bambu integration still
opens the original file with its print settings intact.

`shared/preview-memory.json` is the policy source. The main-process CJS helper
and renderer ESM helper use the same scaling rule and hard ceilings; parity is
tested. The default is 2048 MiB and accepted budgets are integers from 512 through
32768 MiB. These are parsing/rendering budgets, not guaranteed RSS limits.

`readModel()` checks the size before allocating, reads a bounded buffer in chunks,
and checks size/mtime again after reading. Adapters separately limit expanded
archive/XML data, triangles, instances, and depth. Preserve all stages: compressed
file size alone cannot bound the cost of a 3MF. Clean up geometries, materials,
textures, renderers, and workers when their rendering lifetime ends, including
failure, superseded loads, and abort.

## Thumbnail runs

`ThumbnailBatch` is an Electron-independent controller with injected generation,
save, and report-persistence functions. Single-item and bulk requests use the
same instance and cannot overlap. Bulk targets are a snapshot of the complete
library, independent of UI filters, with the memory budget captured at start.
Existing thumbnails are skipped unless overwrite is requested; missing files are
skipped. A single-item request regenerates that item even if an image exists.

For every target, main creates a fresh hidden window with background throttling
disabled. It returns one assigned model over guarded IPC. Once generation
finishes, main destroys the worker window, validates source freshness, and awaits
thumbnail persistence before proceeding. The 90-second timeout applies to
generation, including reading/parsing/rendering; an atomic save already in
progress is allowed to finish. Failure or renderer termination is recorded and
the next target proceeds. Cancellation aborts/destroys the current generator and
prevents the next target from starting.

`processed = succeeded + failed + skipped`; cancellation can leave it below
`total`. Reports contain counts, scope, timestamps, the current item, and errors,
not model bytes or thumbnail images. `thumbnail-batch.json` persists the latest
run. A previously running/stopping report becomes cancelled after restart.
`reportError` exposes persistence problems to the live UI.

Batch saves pass an expected source to `saveThumbnail()`, which checks the
registered path/size/mtime and the actual file before committing the image.
The legacy two-argument save API remains for the viewport. New asynchronous
thumbnail producers should supply the expected source.

## Copy, registration removal, and trash

These operations deliberately have separate contracts:

| Operation | Filesystem behavior | Registration behavior |
| --- | --- | --- |
| `copyModel` | Native destination chooser, `COPYFILE_EXCL`; duplicate or same-source destination fails | Original stays registered; a watched destination is discovered normally |
| `removeItem` | No source-file change | Remove entry and suppress automatic re-registration |
| `trashModel` | Native Cancel-default confirmation, then `shell.trashItem`; no permanent-delete fallback | Remove only after successful trash; no exclusion, so restoration can register again |

Copy/trash capture source metadata before a native dialog, then revalidate after
it. The snapshot includes registration time and filesystem identity as well as
path, size, and mtime, so a replacement at the same path is not treated as the
confirmed source. Trash uses the library mutation queue, preserving watcher/save
ordering. Tests inject a temporary-file move for trash; they must not use a real
model or real Recycle Bin as a fixture.

## Verification workflow

Commands are repository-relative and run from the root on Windows:

```text
npm ci
npm test
npm run build
node scripts/smoke-thumbnails.mjs
node scripts/smoke-context-menu.mjs
```

The two fixture-based smoke scripts isolate storage under `output/playwright/`.
They exercise Electron IPC, local STEP/WASM, image output, cancellation, queue
ordering, and context-menu actions. The context-menu test substitutes native
dialogs and trash with controlled fixture behavior. Unit tests cover filesystem
watching, persistence, format geometry, memory policy, and queue invariants.

After packaging changes, run `npm run package`, then the relevant smoke command
with `--packaged`. Packaging emits a Windows folder application, not a standalone
EXE that can be separated from its support files. Keep generated output and
real-library diagnostics outside commits. Operational scripts that access the
normal user library are not substitutes for isolated regression tests.
