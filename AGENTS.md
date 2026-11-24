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
- Serialize library mutations through `Library.enqueue()`. Commit SQLite row
  changes before updating the in-memory catalog. A schema migration must preserve
  settings, tags, notes, favorites, and exclusions, and retain the legacy JSON.
  Never replace a corrupt library with an empty one or silently roll back to JSON.
- Item IDs identify logical registrations. A confirmed relink updates the path
  without changing the ID, presets or user metadata. Normalized path mappings
  must prevent a new file at an old path from taking over its ID. Registration
  does not relocate files. A geometry update or relink invalidates the image.
  Removing a watch folder keeps its registered items.
- Single and bulk thumbnail requests share one queue and one concurrency gate.
  Reuse one hidden renderer within a batch, dispose job resources before reuse,
  and discard the window on cancellation, timeout or renderer failure. Validate
  the sender, frame and job token, and await image persistence before advancing.
  Cache images are served as BLOB bytes by revision to the main UI session only.
  Do not include image bytes in catalog snapshots or batch reports.
- Copy uses `COPYFILE_EXCL`; never silently overwrite a destination. Trash uses a
  native confirmation with Cancel as the default, revalidates the captured source,
  and calls `shell.trashItem` with no permanent-delete fallback. Registration-only
  removal and moving the source to the Recycle Bin have different exclusion rules.
- Bambu Studio receives the original STL, STEP or 3MF through the verified GUI
  executable without a shell. OpenSCAD uses a bounded temporary STL generated
  from the current parameters. Confirm printer and send from Studio.
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
Review any operational script before running it against the real user library.
Report checks actually run and any remaining platform or integration limitation.

## Private data and publishing

- When real API keys, tokens, credentials, personal information, account or
  device identifiers, private endpoints, or workstation-specific paths must
  persist, write them to a private runtime file outside the Git checkout. Use the
  OS-managed Electron `userData` directory by default. Resolve the location at
  runtime and keep real private settings outside the checkout even if its data
  directory is overridden for development or testing.
- Keep those values out of all tracked files, including code, configuration
  defaults, documentation, and fixtures. Use synthetic values in examples and
  tests, and report missing required configuration without echoing its contents.
  Keep private data out of publishable logs, screenshots, generated files, and
  packages as well.
- Before committing, inspect the exact staged snapshot for private values and
  private files, including paths, fixture metadata, binary headers, and archive
  members. Use `.gitignore` as a backup. Exclude private files explicitly and
  remove any already staged copy from the index. Use a non-personal commit
  identity for this public repository.
- Before pushing, inspect the committed content and metadata of every commit
  being sent, including data added and removed between commits. If a private
  file or value appears, remove it from the entire unpublished commit range and
  verify the corrected range before pushing.
