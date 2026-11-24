# Working on Nine Model Library

This repository is a Windows desktop application for local 3D files. Start with
[the architecture guide](docs/architecture.md) for code ownership and data flow;
`README.md` covers usage.
Keep changes focused on the requested behavior and preserve existing library data.

## Change boundaries

- `electron/` owns filesystem access, persistence, native dialogs, process launch,
  and IPC. These modules use CommonJS (`.cjs`).
- `src/` owns React UI, Three.js rendering, and format adapters. It uses ES modules.
  Do not import Node.js APIs into a renderer or expose unrestricted IPC/filesystem
  access through a preload.
- `shared/formats.json` registers source files. `src/formats/index.js` registers
  mesh loaders. OpenSCAD is converted to STL in main before it reaches a loader.
  Adapters return geometry in millimeters with Z up, accept cancellation and
  preview limits, and dispose resources on failure or cancellation.
- `shared/preview-memory.json` defines preview policy. Keep its main-process and
  renderer implementations equivalent; the parity test checks this. The budget
  adjusts input/geometry limits, not an OS-enforced RAM reservation or cap.

## Invariants to preserve

- Keep `contextIsolation`, sandboxing, and web security enabled, with renderer
  Node integration disabled. Every privileged main-window IPC call must pass
  the sender and main-frame guard in `electron/main.cjs`. Thumbnail-worker IPC
  must accept only the currently assigned worker and its main frame.
- Serialize library mutations through `Library.enqueue()` and persist with
  same-directory temporary-file replacement. A schema migration must preserve
  unrelated settings, tags, notes, favorites, and exclusions. Never replace a
  corrupt library with an empty one as an automatic recovery shortcut.
- Item IDs identify normalized file paths, not file contents. Registration does
  not relocate source files. Updating geometry invalidates its cached thumbnail.
  Removing a watch folder keeps its registered items.
- Single and bulk thumbnail requests share one queue and one concurrency gate.
  Keep one fresh hidden renderer per model, terminate it on cancellation/timeout,
  await image persistence before starting the next model, and validate source
  freshness before saving. Do not include image bytes in batch reports.
- Copy uses `COPYFILE_EXCL`; never silently overwrite a destination. Trash uses a
  native confirmation with Cancel as the default, revalidates the captured source,
  and calls `shell.trashItem` with no permanent-delete fallback. Registration-only
  removal and moving the source to the Recycle Bin have different exclusion rules.
- Bambu Studio receives the original file through `spawn(executable, [path],
  { shell: false })`. Do not substitute a preview mesh for the original project.
- OpenSCAD runs as an external process with no shell and the original source
  directory as its working directory. Only validated Customizer literals may
  become parameter overrides. Keep previews in temporary files and never
  overwrite the source or existing destination STLs.

## Verification

Run commands from the repository root. Normal development and packaging target
Windows; the Electron smoke scripts expect a Windows executable.

```text
npm ci
npm test
npm run build
node scripts/smoke-thumbnails.mjs
node scripts/smoke-context-menu.mjs
node scripts/smoke-scad.mjs
```

Run the smoke test relevant to the change, not every expensive check by default.
The OpenSCAD smoke test requires an installed OpenSCAD executable.
For a packaging change, run `npm run package` and rerun the relevant smoke script
with `--packaged`. Both HTML entry points and local STEP/WASM assets must work
from the packaged app, not only from the Vite development server.

Use generated or committed test fixtures. Set `NINE_DATA_DIR` to an isolated test
directory for custom Electron verification; `NINE_TEST_MODE` alone does **not**
isolate storage. Keep source models, user libraries, local paths, screenshots,
logs, generated runtime binaries, and release output out of source commits.
Before pushing, inspect the exact staged content for personal identifiers,
embedded credentials, and hard-coded workstation paths. Check fixture metadata
and archive members as well as text files. Use platform paths resolved at
runtime and synthetic fixture metadata.
Review any operational script before running it against the real user library.
Report checks actually run and any remaining platform or integration limitation.
