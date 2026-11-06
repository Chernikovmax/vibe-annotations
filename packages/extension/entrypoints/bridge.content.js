// Page-world bridge API for coding-agent integration.
// Runs in the MAIN world so window.__vibeAnnotations is accessible to the page and to
// browser-automation tools. Communicates with the content-script (ISOLATED) world via
// CustomEvents handled in lib/content/bridge-handler.js.

import { installUiEventIsolation } from '../lib/main/ui-event-isolation.js';

export default defineContentScript({
  matches: [
    'http://localhost/*',
    'https://localhost/*',
    'http://127.0.0.1/*',
    'https://127.0.0.1/*',
    'http://0.0.0.0/*',
    'https://0.0.0.0/*',
    'http://*.local/*',
    'https://*.local/*',
    'http://*.test/*',
    'https://*.test/*',
    'http://*.localhost/*',
    'https://*.localhost/*',
    'file:///*',
  ],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    if (window.__vibeAnnotations) return;

    installUiEventIsolation();

    const TIMEOUT = 5000;
    let reqId = 0;

    function request(method, args) {
      return new Promise((resolve, reject) => {
        const id = '__vibe_' + ++reqId + '_' + Date.now();
        const timer = setTimeout(() => {
          document.removeEventListener('vibe-bridge:response', handler);
          reject(new Error('Vibe Annotations: request timed out'));
        }, TIMEOUT);

        function handler(e) {
          if (e.detail?.id !== id) return;
          document.removeEventListener('vibe-bridge:response', handler);
          clearTimeout(timer);
          if (e.detail.error) reject(new Error(e.detail.error));
          else resolve(e.detail.result);
        }

        document.addEventListener('vibe-bridge:response', handler);
        document.dispatchEvent(
          new CustomEvent('vibe-bridge:request', {
            detail: { id, method, args },
          }),
        );
      });
    }

    window.__vibeAnnotations = {
      help() {
        return {
          overview:
            'Vibe Annotations API — record visual design changes as annotations. A coding agent will later read these annotations and implement them in source code. You handle the visual preview, the coding agent handles the source files.',
          workflow: {
            step1: 'Call getAnnotations() first to see what already exists — avoid duplicates.',
            step2: 'Assess the requested changes — split them into global styling vs component-level edits vs structural changes.',
            step3: 'Apply global/theme CSS with createStyleAnnotation (one call for all related rules).',
            step4: 'Apply component-level CSS/text tweaks with createAnnotation (target by simple selector — the API auto-captures full element context).',
            step5: 'For text changes, use textChange param — CSS cannot change text content.',
            step6: 'For structural changes (add/remove elements, reorder layout), use createAnnotation with comment only — describe what the coding agent should do, do NOT attempt DOM surgery.',
          },
          methods: {
            createStyleAnnotation: {
              when: 'Global/broad CSS only: themes, color palettes, typography, spacing resets, animations — anything targeting :root, body, tag selectors, or many elements at once.',
              signature: 'createStyleAnnotation(css, { comment })',
              example:
                'createStyleAnnotation(":root { --primary: #0066FF; --primary-hover: #0052CC; } button, .btn { background-color: var(--primary); } button:hover, .btn:hover { background-color: var(--primary-hover); }", { comment: "Blue primary color rebrand" })',
              note: 'Group ALL related rules into ONE call. Do not create multiple stylesheet annotations for the same theme — update or delete the old one first.',
            },
            createAnnotation: {
              when: "Single-element edits: restyle one button, change one heading's text, tweak one card's layout. Use cssChanges for inline property overrides, textChange for text content, and css only when that specific element needs pseudo-elements or :hover states.",
              signature: 'createAnnotation(selector, { comment, cssChanges, textChange, css })',
              params: {
                selector: 'CSS selector targeting ONE element — e.g. ".hero h1", "#signup-btn"',
                comment: 'Describe the intent for the coding agent (required for structural changes)',
                cssChanges: 'Inline CSS overrides as { camelCase: "value" } — e.g. { fontSize: "48px", color: "#ff0000" }',
                textChange: 'New text content — the ONLY way to change text. CSS cannot do this.',
                css: 'Raw CSS rules ONLY for pseudo-elements (::before, ::after), states (:hover, :focus), or @media on this element. Do NOT use this for simple property changes — use cssChanges instead.',
              },
              examples: [
                'createAnnotation(".hero h1", { comment: "Bigger heading", cssChanges: { fontSize: "48px" }, textChange: "New Title" })',
                'createAnnotation(".pricing-section", { comment: "Add a third pricing tier card between Pro and Enterprise, matching the existing card design" })',
                'createAnnotation(".cta-btn", { comment: "Hover glow + larger padding", cssChanges: { padding: "16px 32px" }, css: ".cta-btn:hover { box-shadow: 0 0 20px gold; }" })',
              ],
              note: 'Use simple selectors (tag, class, id). Do NOT trace CSS module hashes or source files — the API captures element context automatically.',
            },
            getAnnotations: { when: 'Read existing annotations BEFORE creating new ones — prevents duplicates.', signature: 'getAnnotations()' },
            deleteAnnotation: { when: 'Remove an annotation by ID. Use this to clean up before replacing with an updated version.', signature: 'deleteAnnotation(id)' },
            exportAnnotations: { when: 'Export all annotations as a portable JSON object.', signature: 'exportAnnotations(scope?)', example: 'exportAnnotations("project")' },
            status: { when: 'Check if extension and server are active.', signature: 'status()' },
          },
          rules: [
            'ALWAYS call getAnnotations() first to check for existing annotations. If one already covers what you need, delete it before creating an updated replacement. Never stack duplicate annotations.',
            'To change text content, you MUST use createAnnotation with textChange. CSS cannot change text — a stylesheet annotation with a comment is not a text change.',
            'Use cssChanges (inline overrides) for simple property changes on a single element. Only use the css param when you need pseudo-elements, :hover/:focus, or @media for that element.',
            'Use createStyleAnnotation for broad/global CSS only. If you are targeting a specific element, use createAnnotation instead.',
            'Group related global CSS into ONE createStyleAnnotation call. Do not split a color theme across multiple annotations.',
            'Avoid !important — it creates specificity wars. Use precise selectors instead.',
            'Avoid wildcard attribute selectors like [class*="button"] — they match unrelated elements. Use the actual class names visible in the DOM.',
            'Write descriptive comments — they are the primary signal the coding agent uses to understand intent.',
            'Do NOT trace CSS module hashes, source files, or build tooling. The coding agent has the codebase and handles source mapping.',
            'For structural DOM changes (add/remove/reorder elements), describe the change in the comment. Do not manipulate the DOM.',
          ],
        };
      },

      createAnnotation(selector, options = {}) {
        return request('createAnnotation', { selector, ...options });
      },

      createStyleAnnotation(css, options = {}) {
        return request('createStyleAnnotation', { css, ...options });
      },

      getAnnotations() {
        return request('getAnnotations');
      },

      exportAnnotations(scope = 'project') {
        return request('exportAnnotations', { scope });
      },

      deleteAnnotation(id) {
        return request('deleteAnnotation', { id });
      },

      status() {
        return request('status');
      },
    };

    // --- Reverse bridge: isolated world → MAIN world ---
    // The isolated-world content script cannot see page-set JS expando properties
    // (e.g. React's __reactFiber$… or Vue's __vueParentComponent). This MAIN-world
    // listener reads framework source/identity info off a node the isolated world
    // tags with a temporary probe attribute, then returns the result across the bridge.

    const PROBE_ATTR = 'data-vibe-fiber-probe';

    document.addEventListener('vibe-bridge:main-request', (e) => {
      const { id, method, args } = e.detail || {};
      if (!id || !method) return;

      let result = null;
      let error = null;
      try {
        if (method === 'readSource') result = readSourceInfo(args || {});
        else throw new Error('Unknown main-world method: ' + method);
      } catch (err) {
        error = err && err.message ? err.message : String(err);
      }

      document.dispatchEvent(new CustomEvent('vibe-bridge:main-response', {
        detail: error ? { id, error } : { id, result },
      }));
    });

    function readSourceInfo({ marker }) {
      if (!marker) return null;
      const sel = '[' + PROBE_ATTR + '="' + (window.CSS && CSS.escape ? CSS.escape(marker) : marker) + '"]';
      const el = deepQuery(sel);
      if (!el) return null;

      return readAngularSource(el) || readReactSource(el) || readVueSource(el) || null;
    }

    // Walk up across shadow boundaries (MAIN world has no shared util for this).
    function parentDeep(node) {
      if (node.parentElement) return node.parentElement;
      const root = node.getRootNode && node.getRootNode();
      if (root && root instanceof ShadowRoot) return root.host;
      return null;
    }

    function deepQuery(selector) {
      const direct = document.querySelector(selector);
      if (direct) return direct;
      const walk = (root) => {
        const hosts = root.querySelectorAll('*');
        for (const h of hosts) {
          if (h.shadowRoot) {
            const found = h.shadowRoot.querySelector(selector) || walk(h.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      try { return walk(document); } catch { return null; }
    }

    // --- Angular ---
    //
    // Debug discovery describes observed view ownership, not source paths or the
    // caller of MatDialog.open(). Embedded portals may expose insertion ownership.
    function readAngularSource(element) {
      const ng = window.ng;
      // Production Angular can leave a profiler-only window.ng object.
      if (!ng || !['getOwningComponent', 'getComponent'].some(api => typeof ng[api] === 'function')) return null;

      const issues = [];
      const call = (api, arg) => {
        if (typeof ng[api] !== 'function') {
          if (!issues.some(i => i.api === api)) issues.push({ api, reason: 'api_unavailable' });
          return { value: null, reason: 'api_unavailable' };
        }
        try { return { value: ng[api](arg) }; }
        catch {
          if (!issues.some(i => i.api === api)) issues.push({ api, reason: 'api_error' });
          return { value: null, reason: 'api_error' };
        }
      };
      const nameOf = instance => {
        // Inspect descriptors, never application getters (including constructor).
        try {
          let proto = Object.getPrototypeOf(instance);
          while (proto) {
            const ctor = Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
            const name = ctor && Object.getOwnPropertyDescriptor(ctor, 'name')?.value;
            if (typeof name === 'string') {
              return name.length <= 120 && !isMinifiedName(name) ? name : null;
            }
            proto = Object.getPrototypeOf(proto);
          }
        } catch { /* unknown identity must not stop ownership traversal */ }
        return null;
      };
      const hosts = new Map();
      const hostOf = instance => {
        if (!hosts.has(instance)) hosts.set(instance, call('getHostElement', instance));
        return hosts.get(instance);
      };
      const describe = instance => {
        if (!instance) return null;
        const host = hostOf(instance).value;
        return {
          name: nameOf(instance),
          ...(host?.nodeType === 1 ? { host: describeAngularHost(host) } : {}),
        };
      };

      // These reads are independent. In particular, a component host belongs to
      // its declaring view, not necessarily to the component it hosts.
      const owner = call('getOwningComponent', element);
      const hosted = call('getComponent', element);
      const primary = owner.value || hosted.value;
      const templateOwner = describe(owner.value);
      const hostedComponent = describe(hosted.value);
      const seen = new Set();
      const names = [];
      let unnamed = 0;
      let current = primary;
      let stop = owner.reason || hosted.reason || 'no_owner';
      while (current) {
        if (seen.has(current)) { stop = 'cycle'; break; }
        seen.add(current);
        const name = nameOf(current);
        if (name) names.push(name);
        else unnamed++;
        const host = hostOf(current);
        if (host.reason) { stop = host.reason; break; }
        if (!host.value) { stop = 'no_owner'; break; }
        const parent = call('getOwningComponent', host.value);
        if (parent.reason) { stop = parent.reason; break; }
        if (!parent.value) { stop = 'no_owner'; break; }
        if (parent.value === current) { stop = 'self_owner'; break; }
        if (seen.has(parent.value)) { stop = 'cycle'; break; }
        if (seen.size >= 20) { stop = 'depth_limit'; break; }
        current = parent.value;
      }

      const angular = {
        ...(nameOf(primary) ? { component: nameOf(primary) } : {}),
        ...(templateOwner ? { template_owner: templateOwner } : {}),
        ...(hostedComponent ? { hosted_component: hostedComponent } : {}),
        chain: {
          status: 'observed',
          components: names.reverse(),
          stop_reason: stop,
          instance_count: seen.size,
          ...(unnamed ? { unnamed_count: unnamed } : {}),
          limitations: [
            'Not proven complete ancestry; no_owner does not prove an application root.',
            'Not dialog opener history.',
            'getOwningComponent may report insertion ownership for embedded portals, not the template declaration.',
          ],
        },
      };
      const directives = call('getDirectives', element).value;
      if (Array.isArray(directives)) {
        angular.directives = directives.map(nameOf).filter(Boolean).slice(0, 6);
      }
      if (primary) {
        const meta = call('getDirectiveMetadata', primary).value;
        if (meta) {
          // Debug metadata maps public names to property names. Never read those
          // properties: even a primitive input can be an application getter.
          angular.input_names = Object.keys(meta.inputs || {}).filter(n => n.length <= 120).slice(0, 8);
          if (meta.framework == null || meta.framework === 'angular') {
            if (meta.changeDetection === 0) angular.change_detection = 'OnPush';
            else if (meta.changeDetection === 1) angular.change_detection = 'Default';
          }
        }
      }
      const versions = [...new Set(Array.from(document.querySelectorAll('[ng-version]'))
        .map(el => el.getAttribute('ng-version')).filter(v => /^\d+\.\d+\.\d+[-\w.]*$/.test(v) && v.length <= 120))];
      if (versions.length === 1) {
        angular.version = versions[0];
        angular.version_source = 'document [ng-version] attribute';
      }
      if (issues.length) angular.api_issues = issues;
      return {
        filePath: null,
        lineRange: null,
        hasSourceMap: false,
        componentName: angular.component || null,
        angular,
        target_identity: describeAngularTarget(element, owner.value ? hostOf(owner.value).value : null),
      };
    }

    function describeAngularHost(el) {
      return {
        tag: el.tagName.toLowerCase(),
        classes: Array.from(el.classList || [])
          .filter(c => c.length <= 120 && !/^(ng-|cdk-|_ng|_mat-|mat-|mdc-|vibe-)/.test(c))
          .slice(0, 6),
      };
    }

    function describeAngularTarget(element, ownerHost) {
      const target = { ...describeAngularHost(element), attributes: {} };
      for (const name of ['data-testid', 'data-test', 'data-cy', 'data-component', 'role', 'type']) {
        const value = element.getAttribute(name);
        if (value !== null) target.attributes[name] = value.slice(0, 120);
      }
      if (!ownerHost) return { ...target, relative_selector_reason: 'owner_host_unavailable' };
      // A shadow template is scoped to its actual root, not queried through a host.
      const root = ownerHost.shadowRoot?.contains(element) ? ownerHost.shadowRoot : ownerHost;
      if (element === ownerHost) {
        return { ...target, relative_selector: ':scope', match_count: 1, match_scope: 'owner_host_self' };
      }
      if (!root.contains(element)) return { ...target, relative_selector_reason: 'outside_owner_host' };
      target.match_scope = root === ownerHost ? 'owner_host' : 'owner_shadow_root';
      for (const name of ['data-testid', 'data-test', 'data-cy', 'data-component']) {
        const value = element.getAttribute(name);
        if (value === null || value.length > 120) continue;
        const selector = `[${name}="${CSS.escape(value)}"]`;
        const count = root.querySelectorAll(selector).length;
        if (count) return { ...target, relative_selector: selector, match_count: count };
      }
      const classes = target.classes.map(c => `.${CSS.escape(c)}`).join('');
      const candidate = CSS.escape(target.tag) + classes;
      if (root.querySelectorAll(candidate).length === 1) {
        return { ...target, relative_selector: candidate, match_count: 1 };
      }
      const path = [];
      let node = element;
      while (node && node !== root) {
        const siblings = Array.from(node.parentNode.children).filter(s => s.tagName === node.tagName);
        path.unshift(`${CSS.escape(node.tagName.toLowerCase())}:nth-of-type(${siblings.indexOf(node) + 1})`);
        node = node.parentNode;
      }
      const selector = (root === ownerHost ? ':scope > ' : '') + path.join(' > ');
      return { ...target, relative_selector: selector, match_count: root.querySelectorAll(selector).length };
    }

    // --- React ---

    function readReactSource(element) {
      let current = element;
      let depth = 0;
      while (current && depth < 10) {
        const fiberKey = Object.keys(current).find(k =>
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('_reactInternalFiber')
        );
        if (fiberKey) return readFromFiber(current[fiberKey]);
        current = parentDeep(current);
        depth++;
      }
      return null;
    }

    function readFromFiber(startFiber) {
      // Find the first _debugSource on the fiber or its owner chain (React ≤18 dev).
      let fiber = startFiber;
      let fd = 0;
      let source = null;
      while (fiber && fd < 30) {
        const s = fiber._debugSource || fiber._source ||
          (fiber.elementType && fiber.elementType._source) || (fiber.type && fiber.type._source);
        if (s && s.fileName) { source = s; break; }
        if (fiber._debugOwner) {
          const os = fiber._debugOwner._debugSource || fiber._debugOwner._source;
          if (os && os.fileName) { source = os; break; }
        }
        fiber = fiber.return || fiber._debugOwner;
        fd++;
      }

      const identity = readReactIdentity(startFiber);

      if (source && source.fileName) {
        return {
          filePath: source.fileName,
          lineRange: source.lineNumber ? (source.lineNumber + '-' + (source.lineNumber + 10)) : null,
          hasSourceMap: true,
          componentName: identity.name,
          ownerChain: identity.chain,
        };
      }

      // No _debugSource (React 19, or dev transform stripped) → identity only, never a path.
      if (identity.name) {
        return {
          filePath: null,
          lineRange: null,
          hasSourceMap: false,
          componentName: identity.name,
          ownerChain: identity.chain,
        };
      }

      return null;
    }

    // Raw component name for a fiber, or null if it isn't a component
    // (host element string type, Fragment, etc.).
    function rawComponentName(fiber) {
      const t = fiber && fiber.type;
      if (!t || typeof t === 'string') return null;
      return t.displayName || t.name ||
        (t.render && (t.render.displayName || t.render.name)) || null;
    }

    // Real React component names are PascalCase and ≥3 chars; minifier output is
    // short / lowercase-led (`sD`, `xe`, `t`, `n2`). Reporting those as `Component:`
    // is noise that sends the agent chasing a meaningless symbol.
    function isMinifiedName(name) {
      return !name || name.length <= 2 || !/^[A-Z]/.test(name);
    }

    // Filtered name — used for the owner chain (real names only).
    function reactFiberName(fiber) {
      const name = rawComponentName(fiber);
      return isMinifiedName(name) ? null : name;
    }

    function readReactIdentity(startFiber) {
      // Primary name = the NEAREST component this node belongs to. If that
      // component's name is minified, report no name rather than climbing to a
      // distant library ancestor (e.g. Router) and misattributing the element.
      let name = null;
      let fiber = startFiber;
      let fd = 0;
      while (fiber && fd < 30) {
        if (typeof fiber.type === 'function') { // nearest function/class component
          const raw = rawComponentName(fiber);
          name = isMinifiedName(raw) ? null : raw;
          break;
        }
        fiber = fiber.return;
        fd++;
      }

      // Ownership chain (who rendered whom) via _debugOwner — real names only.
      const chain = [];
      let owner = startFiber;
      let od = 0;
      while (owner && od < 12) {
        const n = reactFiberName(owner);
        if (n && !chain.includes(n)) chain.unshift(n);
        owner = owner._debugOwner;
        od++;
      }
      return { name, chain: chain.length ? chain : null };
    }

    // --- Vue 3 ---

    function readVueSource(element) {
      let current = element;
      let depth = 0;
      while (current && depth < 10) {
        const inst = current.__vueParentComponent || current.__vue__;
        if (inst) {
          const type = inst.type || inst.$options || {};
          const file = type.__file || (inst.$options && inst.$options.__file);
          const name = type.name || type.__name || (inst.$options && inst.$options.name) || null;
          if (file) {
            return { filePath: file, lineRange: null, hasSourceMap: true, componentName: name, ownerChain: name ? [name] : null };
          }
          if (name) {
            return { filePath: null, lineRange: null, hasSourceMap: false, componentName: name, ownerChain: [name] };
          }
        }
        current = parentDeep(current);
        depth++;
      }
      return null;
    }
  },
});
