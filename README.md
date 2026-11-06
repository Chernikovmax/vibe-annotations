# ng-vibe-remarker

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-6K+_users-green?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gkofobaeeepjopdpahbicefmljcmpeof) [![Server Package](https://img.shields.io/badge/Server-NPM-blue)](https://www.npmjs.com/package/vibe-annotations-server) [![License: PolyForm Shield](https://img.shields.io/badge/License-PolyForm%20Shield-blue)](https://polyformproject.org/licenses/shield/1.0.0)

Visual feedback tool for web development. Annotate elements on your pages, make design tweaks, and share with AI coding agents or teammates.

This checkout builds **ng-vibe-remarker**, a local Angular-aware extension derived
from Vibe Annotations. The Web Store, server/plugin packages and upstream docs linked
below still refer to the upstream product, not a published release of this fork.
Build with `pnpm --filter vibe-annotations-extension build` and load
`packages/extension/.output/chrome-mv3` as an unpacked extension in Chrome.

https://github.com/user-attachments/assets/6946733e-eea6-4d38-8386-c493f90d36f4

For more features explanations (like collaboration via file sharing, AI-assisted annotations, watch mode...) please read the docs.

## Get started

**1.** Install the [browser extension](https://chromewebstore.google.com/detail/gkofobaeeepjopdpahbicefmljcmpeof)

**2.** Run the setup wizard

```bash
npx vibe-annotations-server init
```

One interactive command installs the global server, starts it in the background, and configures your AI coding agent (Claude Code, Cursor, Windsurf, Codex, OpenClaw, VS Code). For Claude Code it also offers the [Vibe Annotations mod](packages/claude-mod): new annotations show above the prompt and go to Claude in one press. Prefer manual? See [Installation](https://vibe-annotations.com/docs/installation).

Using only Claude Code? The mod alone is enough, since it starts the server for you:

```bash
claude plugin install vibe-annotations --marketplace RaphaelRegnier/vibe-annotations
```

**3.** Open a localhost page, click **Annotate**. You can annotate multiple pages on your web app. Then:

A (recommended) - [Use the MCP](https://vibe-annotations.com/docs/mcp-setup) to implement your Annotations

B - Copy to your clipboard: **View all** > **Copy** and send to your AI coding agent.

## Documentation

Full docs at [**vibe-annotations.com/docs**](https://vibe-annotations.com/docs) — including [installation](https://vibe-annotations.com/docs/installation), [MCP setup](https://vibe-annotations.com/docs/mcp-setup), [workflows](https://vibe-annotations.com/docs/workflows), [architecture](https://vibe-annotations.com/docs/architecture), and [troubleshooting](https://vibe-annotations.com/docs/troubleshooting).

### Local Angular context implementation

The local extension reader uses Angular development discovery APIs. It records
`element_context.angular` and `element_context.target_identity` through both the
annotation popover and the page bridge. `template_owner` is the observed result of
`ng.getOwningComponent(element)`; `hosted_component` is independently obtained from
`ng.getComponent(element)`. Hosts come from `ng.getHostElement(instance)`, not DOM ancestry.

Owner chains have `status: "observed"`, a bounded instance count and a stop reason.
They are **not** proven complete ancestry or dialog opener history. Real Angular
17.3.12/Material-CDK 17.3.10 and Angular 20.0.0/Material-CDK 20.0.4 fixtures show that
TemplateRef dialog discovery can report `MatDialogContainer` rather than the component
declaring the template; a root-host TemplatePortal can report no owner at all.
Those public API limits are included in structured context and human-readable hints.
The declaration-owner acceptance criterion remains unresolved for these cases.

The reader collects input **names only**, never their values/getters. Target attributes
use a six-attribute allowlist; relative selectors include their actual match count/scope,
or an explicit reason such as `outside_owner_host`. Existing DOM text/classes/id may
still contain sensitive content. No source file path or Angular selector is inferred
from a host tag. Production pages without discovery APIs retain DOM context.

Runtime regression sources are in `packages/extension/tests/angular-runtime/`.
Build with `pnpm --filter vibe-annotations-extension build`, then run
`ANGULAR_DEPS=/path/to/isolated/angular-dependencies node packages/extension/tests/angular-runtime/run.mjs`.
The isolated dependency installation needs matching Angular core/common/compiler/forms/
router/platform-browser/animations, Material/CDK, Zone.js, RxJS, esbuild and Playwright
with Chromium installed. The runner uses a temporary persistent profile, blocks background
HTTP requests, and exercises real Angular/Material, bridge storage and popover Save.
The production fixture is an optimized JIT bundle, not an Angular CLI AOT-build test.

Angular reader, durable manual screenshots, local capture/export, and Material
interaction isolation are implemented. The stage-5 integration evidence and remaining
acceptance limits are recorded below; this is not a release or a compatibility claim
for untested versions.

### Copy for OMP (manual text handoff)

In **View all → Copy**, choose **Копировать для OMP** in **Copy format**.
Review the fields/images, deselect sensitive fields or entire annotations, then
**Copy text** and paste into the OMP session you choose. The existing Markdown
option remains available. No session discovery, delivery API, MCP or native host
is involved; copying reads local annotations and does not delete originals.

Each separated note starts with the requested change and URL without query/hash,
then observed template owner/host, independent hosted component, target test
attributes/classes and locator with actual scope/count or its unavailable reason.
Observed chain/status/stop reason/limitations precede clearly labeled search
guidance; additional reviewed DOM context follows. Structure wins over hints.
For old records without structured Angular/target context, only identifier-only
component hints are retained as reviewed, **unconfirmed** search keys; free-form
legacy hints that might contain input values are omitted. Excluded owners/targets
are not reconstructed from hints or duplicate DOM identity fields.

Names can repeat; host tags are not proof of Angular selectors. Limited
TemplateRef/portal ownership remains limited, not an inferred declaration owner.
No source paths, `@file` references or line numbers are generated. With no Angular
discovery API, use the retained DOM keys.

Text never transfers images: retained attachments produce a ZIP-transfer reminder,
not blob URLs, local IDs as paths or fake image links. **Share / Export → ZIP**
remains the separate image-transfer path; copying does not require image bytes to
be exportable. The ZIP schema and attachment lifecycle are unchanged.

Stage-6 checks passed on installed unpacked builds with Angular 17.3.12/CDK 17.3.10
and Angular 20.0.0/CDK 20.0.4: single/multiple selected notes, actual clipboard reads,
review exclusions, clean URLs, no invented image/source links, and DOM-only/optimized
JIT fallback. Copied owner/host/target keys resolved the exact fixture declarations
and template nodes for ordinary elements, component hosts, same-name classes,
Component dialog and limited TemplateRef/portal cases. The actual clipboard text
was also read in the current OMP session via a temporary local artifact and matched
against those sources; this is not automatic session delivery or a speed benchmark.
`chrome://extensions`, runtime manifest and the loaded toolbar logo confirmed the
installed **ng-vibe-remarker** name. Run the Angular runner above and
`node packages/extension/tests/local-export-runtime.mjs` to reproduce browser checks.
No screenshot permissions were requested; the stage-5 screenshot blocker remains open.

### Manual local screenshots

The annotation card's **+** menu captures the selected element or a dragged viewport
region. Opening, saving or editing an annotation never captures automatically; the
old Screenshots toggle was removed and its stored value is ignored. An annotation
needs a comment, design change or attachment; an auto-capture setting is not content.

Each capture has its own `local_only` attachment ID and `capture_mode` (`element` or
`region`). The extension worker captures, crops and encodes WebP, then commits Blob
bytes to extension-origin IndexedDB before confirming the attachment. Draft IDs are
stable across capture and Save retries. Save awaits binding and chrome.storage
publication; failed writes are visible and retain retryable images.

Preview and **Save image** work without MCP. In **View all → Share / Export**,
review each selected annotation, its DOM/Angular fields, and image previews;
uncheck sensitive fields or images, then download a ZIP containing
`annotations.json`, `annotations.md`, and actual `attachments/<id>.webp` bytes.
JSON maps annotation IDs to attachment IDs/relative paths. Unzip it into a
directory available to your agent and send that directory path: the agent
cannot read extension IndexedDB, and **Copy** transmits text only. Query and
fragment are removed from the exported URL copy, not the stored annotation.
Missing local bytes fail the export visibly; old server attachments are labeled
unavailable rather than given fake paths. Export does not delete originals,
even if the old Clear after copy setting was enabled.

The optional annotation sync excludes local-only references and preserves them
when merging remote text changes. New screenshot bytes/refs do not go to MCP.
Legacy server attachments remain separate.

Cancelling a new card deletes its draft images. Cancelling an edit deletes only new
draft images; saved-image removals take effect on Save. Deleting a saved image or
annotation deletes its bytes. Settings offers a confirmed **Clear local images**
action. Unbound drafts expire after 24 hours; bound images do not expire by age.
Limits are 15 MiB per image and 100 MiB total, with visible errors and no silent
eviction. Browser/extension data clearing or uninstall destroys local images:
save important images from preview; this store is not a backup.

Browser-boundary checks (isolated Playwright/Chromium and esbuild dependencies as
above; no MCP server needed):

```sh
pnpm --filter vibe-annotations-extension build
HEADED=1 ANGULAR_DEPS=/path/to/isolated/dependencies node packages/extension/tests/local-capture-runtime.mjs
node packages/extension/tests/region-selection-runtime.mjs
node packages/extension/tests/local-export-runtime.mjs
HEADED=1 DPR=1 node packages/extension/tests/capture-geometry-runtime.mjs
node packages/extension/tests/local-attachment-sync.mjs
```

Approve the **real optional host-permission prompt** in the temporary test browser.
Headless mode cannot answer this browser dialog. The manifest is not broadened for
tests. The runner checks actual WebP download/preview, multiple images, failed IDB
commit and Save retry, edit cancellation, full browser restart, draft expiry,
quotas, saved-image/annotation deletion and confirmed Settings cleanup. Sync tests
use a recording fetch boundary rather than a real MCP endpoint.

The region selector handles drag direction, viewport edges, 4 CSS px sides,
pointer capture loss/cancel, Escape, blur, scroll and resize. The worker
checks the sender tab/focused window and stable viewport/zoom across capture;
bitmap dimensions, not DPR alone, determine cropped pixel bounds. The browser
grid fixture covers DPR 1/1.25/2, zoom 80/100/125%, scroll, pinch scale 1.5,
fixed/sticky elements and in-flight tab/window/scroll/zoom/decode failures.
Selection guards follow the selecting pointer ID through release/click, not a
400–700 ms click blackout. Long holds remain owned; the next pointerdown is
independent. Only a missing post-release click needs a 1500 ms cleanup watchdog.

The unpacked extension is named **ng-vibe-remarker** and uses the unchanged `logo.png`
for its generated 16/32/48/128 px icons and toolbar artwork. The checkout folder,
GitHub remotes, package/server/protocol names, storage keys, IndexedDB name and local
attachment IDs are unchanged; this is visible branding, not a data migration.

### Modal UI compatibility

The actual extension UI was exercised with Angular 17.3.12/Material-CDK 17.3.10
and Angular 20.0.0/Material-CDK 20.0.4 in Chromium 156. Both CDK versions use
ordinary overlay containers; separate native popover and modal-dialog cases
exercise the browser top layer. The extension uses a **manual nonmodal popover**,
never `showModal()`. Inside an active native modal, the same host is moved into
that modal to avoid native inertness, then promoted above its surface.
`moveBefore()` preserves state where available; the fallback reopens the popover.

Escape cancels region selection first, then closes the card/inspection mode;
the next Escape belongs to the application. Card Tab/Shift+Tab stays inside its
controls. Closing restores a connected page target or a safe dialog control.
The application's focus trap is not disabled. Toolbar mode changes are
synchronous; CSS owns the crossfade so stale timers cannot reopen annotation mode.

The document-start MAIN wrapper filters interactive listeners only on
window/document/body/html, using the registered host **object**, not an ID lookup.
Inactive UI and ordinary page events pass through. Duplicate/remove/once,
reentrancy, dynamic object `handleEvent`, passive options, AbortSignal, original
event/receiver/order and callback errors are covered by browser regressions.
Remove/once/abort release callback references, checked with browser GC/WeakRef.

This is compatibility isolation, **not a security boundary** against hostile page
JavaScript. Preinstalled listeners, saved native methods, property handlers and
capture listeners on other ancestors can bypass it. Late site enablement cannot
retroactively wrap existing listeners. The target application's exact CDK version
still needs its own acceptance run before release; intermediate versions are unproven.

```sh
ANGULAR_DEPS=/path/to/angular17 node packages/extension/tests/material-interaction-runtime.mjs
ANGULAR_DEPS=/path/to/angular20 node packages/extension/tests/material-interaction-runtime.mjs
ANGULAR_DEPS=/path/to/dependencies node packages/extension/tests/event-target-runtime.mjs
```

These runners load the built extension in temporary persistent profiles without
MCP. The Material runner uses real editor/IME/clipboard/pointer input and checks
two dialogs, backdrop, focus, top-layer hit testing, repeat/SPA/disable cleanup.
It bypasses the permission prompt and rejects capture at the worker API boundary:
it is interaction acceptance, not a replacement for the real GUI permission/WebP
checks above. The EventTarget runner also checks repeat injection over a later
page patch and documents the native bypass boundaries.

### Final local integration matrix (stage 5, 2026-11-06)

All runs use the built unpacked extension, isolated persistent Chromium 156.0.8078.4
profiles and Node 22.23.2, without starting MCP or modifying the mandatory permissions.
Paths below are relative to `packages/extension/tests/`.

| Acceptance surface | Final-run evidence | Limits |
|---|---|---|
| Angular 17.3.12/CDK 17.3.10 and Angular 20.0.0/CDK 20.0.4 | `angular-runtime/run.mjs`: nesting, root/component hosts, embedded/projection/recursive/standalone/lazy/same-name components, dialogs/portals, ShadowDom, stop reasons and zero input getter reads | TemplateRef dialog owner remains `MatDialogContainer`; root-host TemplatePortal has no owner. No invented AppComponent ancestry |
| Actual Angular context → saved annotation → reviewed ZIP | Same runner: real Annotate/Save, downloaded JSON/Markdown, owner-relative locator resolves to selected conditional button; URL secrets/input values absent and internal URL preserved | Fixture `CardComponent` + `fixture-card` + `conditional` identifies `angular-runtime/main.js`'s CardComponent template; this is not source-map inference |
| Optimized JIT production / DOM-only UI | `angular-runtime/run.mjs` on both dependency sets: actual Annotate → text → Save persisted DOM identity under the current URL, without invented Angular context | Not Angular CLI AOT, not a real target-app run |
| Material editing and native top layer | `material-interaction-runtime.mjs` on both versions: held/short/Enter selection, independent click, two dialogs, region/backdrop, typing/paste/IME, Tab wrapping, staged Escape, focus restore, repeated/SPA/disable cleanup | Real installed UI, but this runner bypasses permission and rejects capture; not screenshot-byte evidence. Both tested CDK containers are ordinary DIVs |
| EventTarget compatibility | `event-target-runtime.mjs`: identity/options/once/reentrancy/remove/abort/object callbacks/passive/errors/order, GC release, repeat bridge injection | Saved native methods, property handlers, preinstalled listeners and other ancestor capture remain bypasses; not a hostile-page security boundary |
| Region interaction | `region-selection-runtime.mjs`: directions, edges, minimum sides, long hold, pointer cancellation/loss, Escape/blur/scroll/resize and immediate independent click | Browser viewport only, not desktop capture |
| Reviewed image ZIP/clipboard | `local-export-runtime.mjs`: real review/download, unzip, exact committed WebP bytes and decode, nested sensitive-field/image exclusions, missing-byte error, originals retained | Export fixture seeds real extension IDB images/context; actual Angular context export is independently covered above |
| Optional sync boundary | `local-attachment-sync.mjs`: outbound local-ref exclusion and remote-merge retention | Recording fetch boundary, not a live MCP integration run |
| Automatic capture regression | `local-capture-runtime.mjs` reached and passed legacy Screenshots=ON / empty Save / zero capture-call checks | Full stage-5 run did **not** pass: native permission UI focus changes cancelled capture before the injected quota check |
| Capture geometry and durable lifecycle | Prior stage-3 grid evidence: DPR 1/1.25/2, zoom 80/100/125%, scroll/pinch/fixed/sticky and tab/window/geometry/decode races; prior stage-2 full restart/quota/delete/clear run | **Not repeated successfully in stage 5.** Geometry denial run blocked at real browser permission UI; no new pixel/restart acceptance is claimed |
| Local production build | `pnpm --filter vibe-annotations-extension build` → `.output/chrome-mv3` | No ZIP release, publishing or server start |

The disable regression waits for asynchronous worker/IDB draft cleanup before asserting
that the card is detached; host hiding alone is not cleanup completion. No production
behavior was changed to satisfy that assertion.

The screenshot blocker is specific: foreground/native-permission automation invalidated
the focused-window guard; later `orca computer get-app-state --app pid:… --restore-window`
could not read the visible Chromium AX window (`permission_denied`), even though
`orca computer permissions` reported Accessibility and screenshots granted. Both direct
PID/window targeting and geometry's `NORMAL_PERMISSIONS=1` (without `--enable-automation`)
were attempted. Permission approval was observed, but denial, final screenshot bytes and
the full restart suite were not reaccepted. The mandatory manifest was not broadened,
the focus guard was not bypassed, and experimental test workarounds were removed.
Repeating this part needs functioning native permission-dialog automation and an
uninterrupted foreground test window. Forced worker termination exactly between IDB
binding and chrome.storage publication also remains untested.

**Not release acceptance:** the target application/build and exact Angular/CDK version
were not supplied. Intermediate versions and Angular CLI AOT production are untested;
the production fixture is optimized/minified JIT. Public ownership and EventTarget
limits above are unchanged. The known `floating-toolbar-position.test.js` MockElement
failure (`sendEl.setAttribute is not a function`, 8/9 nested scenarios) was not rerun
or weakened; this matrix does not claim a green general unit suite. “Copy for OMP”
remains a future stage, not part of this implementation.



## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

[PolyForm Shield 1.0.0](https://polyformproject.org/licenses/shield/1.0.0) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
