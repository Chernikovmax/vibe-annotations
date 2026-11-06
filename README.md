# Vibe Annotations

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-6K+_users-green?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gkofobaeeepjopdpahbicefmljcmpeof) [![Server Package](https://img.shields.io/badge/Server-NPM-blue)](https://www.npmjs.com/package/vibe-annotations-server) [![License: PolyForm Shield](https://img.shields.io/badge/License-PolyForm%20Shield-blue)](https://polyformproject.org/licenses/shield/1.0.0)

Visual feedback tool for web development. Annotate elements on your pages, make design tweaks, and share with AI coding agents or teammates.

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

Angular stage 1 and the local screenshot/storage stage 2 are implemented locally.
This is not a release or a claim of intermediate-version compatibility. Markdown/ZIP
export, sensitive-field review and modal/EventTarget isolation remain deferred.

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

Preview and **Save image** work without MCP. The optional annotation sync excludes
local-only references and preserves them when merging remote text changes. MCP
cannot read these images: copying annotation text does not transfer image bytes.
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
ANGULAR_DEPS=/path/to/isolated/dependencies node packages/extension/tests/local-attachment-sync.mjs
```

Approve the **real optional host-permission prompt** in the temporary test browser.
Headless mode cannot answer this browser dialog. The manifest is not broadened for
tests. The runner checks actual WebP download/preview, multiple images, failed IDB
commit and Save retry, edit cancellation, full browser restart, draft expiry,
quotas, saved-image/annotation deletion and confirmed Settings cleanup. Sync tests
use a recording fetch boundary rather than a real MCP endpoint.

Stage 2 still uses the reference region selector and DPR-based crop geometry.
Fractional DPR/zoom/visual viewport, complete tab/window/viewport race handling,
region cancellation matrix and ZIP/Markdown/JSON export belong to stage 3.
The inherited region guard swallows all clicks for 400 ms after selection; the
storage runner waits past it rather than claiming event isolation. Stage 4 replaces
the gesture/EventTarget/focus behavior and verifies real Material Dialogs.


## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

[PolyForm Shield 1.0.0](https://polyformproject.org/licenses/shield/1.0.0) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
