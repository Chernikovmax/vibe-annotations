// Pure logic module — selector generation, element context collection,
// screenshot capture, source mapping, parent chain.
// Operates on host page DOM. No UI.

import VibeShadowDOMUtils from './shadow-dom-utils.js';
import { vibeLocationPath } from './event-bus.js';


  // Preserve text-node boundaries without reading form values or icon glyph names.
  function textSample(element, limit = 100) {
    const excluded = 'script, style, noscript, template, [hidden], [aria-hidden="true"]';
    if (element.matches(excluded)) return '';
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          return node.matches(excluded) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '';
    while (walker.nextNode()) {
      const part = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
      if (part) text += (text ? ' ' : '') + part;
      if (text.length > limit) return text.slice(0, limit - 1).trimEnd() + '…';
    }
    return text;
  }

  function getElementState(element, style) {
    const state = {};
    if (element.matches('button, fieldset, input, optgroup, option, select, textarea')) state.disabled = element.matches(':disabled');
    if (element.matches('input[type="checkbox"], input[type="radio"]')) state.checked = element.checked;
    for (const key of ['aria-disabled', 'aria-checked', 'aria-pressed', 'aria-expanded']) {
      const value = element.getAttribute(key);
      if (['false', 'true', 'mixed'].includes(value)) state[key] = value;
    }
    state.visible = typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ visibilityProperty: true })
      : element.getClientRects().length > 0 && style.visibility === 'visible';
    return state;
  }

  const translationSelector = '[translate], [ng-reflect-translate]';
  function translationKeyOn(node) {
    for (const name of ['translate', 'ng-reflect-translate']) {
      const value = node.getAttribute(name);
      if (/^[A-Za-z][\w-]*(?:\.[\w-]+)+$/.test(value || '') && value.length <= 120) return value;
    }
  }

  function getTranslationKey(element) {
    const selector = translationSelector;
    const keyOf = translationKeyOn;
    const ancestor = element.parentElement?.closest(selector);
    const direct = keyOf(element) || (ancestor && keyOf(ancestor));
    if (direct) return direct;
    let candidate;
    for (const node of element.querySelectorAll(selector)) {
      const key = keyOf(node);
      if (!key) continue;
      if (candidate && key !== candidate) return undefined;
      candidate = key;
    }
    return candidate;
  }

  function isProjectHost(node) {
    return node.localName.includes('-') && !/^(?:mat-|mdc-|cdk-|ng-|vibe-)/i.test(node.localName);
  }

  function handoffAttribute(node, key) {
    const value = node.getAttribute(key)?.trim();
    return value && value.length <= 160 && !/^(?:undefined|null)$/i.test(value) ? value : undefined;
  }

  function handoffClasses(element) {
    const root = element.getRootNode();
    const ranked = [];
    for (const name of element.classList) {
      if (name.length > 120 || !isStableClass(name) || isGenericFrameworkClass(name)
        || /^(?:_?mat-|mdc-|cdk-|_?ng-|vibe-|btn(?:-|$)|input(?:-|$)|row$|col(?:-|$))/i.test(name)) continue;
      const matches = root.querySelectorAll('.' + CSS.escape(name)).length;
      ranked.push({ name, matches });
    }
    ranked.sort((a, b) => a.matches - b.matches);
    const unique = ranked[0]?.matches === 1;
    return ranked.slice(0, 2).filter(entry => !unique || entry.matches === 1).map(entry => entry.name);
  }

  const dynamicKinds = ['timer', 'counter', 'date', 'row data'];
  function dynamicTextKind(node, text, explicit) {
    if (dynamicKinds.includes(explicit)) return explicit;
    if (explicit === 'static' || explicit === 'i18n' || translationKeyOn(node) || !text) return;
    if (/^\d{1,3}:\d{2}(?::\d{2})?$/.test(text)) return 'timer';
    if (node.matches('time')) return 'date';
    if (/^\d+$/.test(text)) return 'counter';
  }

  function dynamicInner(element) {
    let best;
    for (const node of element.querySelectorAll('*')) {
      if (node.childElementCount && !node.matches('time, [data-remarker-text]')
        && !Array.prototype.some.call(node.childNodes, child => child.nodeType === Node.TEXT_NODE && child.textContent.trim())) continue;
      const kind = dynamicTextKind(node, textSample(node), handoffAttribute(node, 'data-remarker-text'));
      if (!kind || node.closest('[hidden], [aria-hidden="true"]')
        || node.checkVisibility?.({ visibilityProperty: true }) === false) continue;
      let depth = 0;
      for (let current = node; current !== element; current = current.parentElement) depth++;
      if (!best || depth < best.depth) {
        best = { node, depth, kind };
        if (depth === 1) break;
      }
    }
    return best && { tag: best.node.localName, classes: handoffClasses(best.node), depth: best.depth, kind: best.kind };
  }

  function promotedLabel(element) {
    const sourceFor = node => ({ tag: node.localName, classes: handoffClasses(node), key: translationKeyOn(node) });
    const referenced = (element.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean)
      .map(id => element.getRootNode().getElementById?.(id)).filter(Boolean);
    const nameOf = node => {
      const explicit = handoffAttribute(node, 'aria-label');
      const value = explicit || textSample(node);
      if (!value || (!explicit && (/^\d+(?::\d+){0,2}$/.test(value) || node.matches('time, [aria-live]:not([aria-live="off"])')))) return '';
      return value;
    };
    if (referenced.length) {
      const value = referenced.map(nameOf).filter(Boolean).join(' ').slice(0, 160);
      if (value) return { value, via: 'aria-labelledby', ...(referenced.length === 1 ? { source: sourceFor(referenced[0]) } : {}) };
    }
    const ariaLabel = handoffAttribute(element, 'aria-label');
    if (ariaLabel) return { value: ariaLabel, via: 'aria-label' };
    const value = nameOf(element);
    if (!value) return;
    const translated = [...element.querySelectorAll(translationSelector)].filter(node => translationKeyOn(node) && textSample(node) === value);
    const node = translated.length === 1 ? translated[0] : null;
    if (!node) {
      // A generic cell can contain live row data. Copy only a labelled/static
      // name, or a non-live tab/option caption, not arbitrary descendant text.
      if (!element.matches('[role="tab"], [role="option"]') && !translationKeyOn(element)
        && handoffAttribute(element, 'data-remarker-text') !== 'static') return;
      return { value, via: 'content', key: translationKeyOn(element) };
    }
    const descendantAnchors = [];
    for (let child = node; child && child !== element && descendantAnchors.length < 4; child = child.parentElement) {
      const id = handoffAttribute(child, 'data-testid');
      if (id) descendantAnchors.push(id);
    }
    return { value, source: sourceFor(node), descendant_anchors: descendantAnchors };
  }

  function assertDomHops(element, ancestor, depth) {
    let length = 1, node = element;
    while (node && node !== ancestor) {
      node = node.parentElement;
      length++;
    }
    console.assert(node === ancestor && depth === length - 1, 'Remarker: invalid DOM hop count', depth, node ? length - 1 : 'not an ancestor');
  }

  // Read only rendered DOM or metadata the application explicitly exposes.
  function getHandoffContext(element, text, rect, style) {
    const handoff = { dom_hops: true };
    if (element.classList.contains('mat-mdc-menu-trigger')) handoff.menu_trigger = true;
    const context = {};
    const attr = handoffAttribute;
    const testAnchors = [];
    let pastWidget = false;
    const contextAttrs = ['data-workspace-id', 'data-preset-id', 'data-widget-id', 'data-tab-index', 'data-remarker-context'];
    const rowSelector = 'tr, mat-row, cdk-row, [role="row"], li, [role="listitem"], [data-remarker-row-key], [data-row-key]';
    const tableSelector = 'table, mat-table, cdk-table, [role="table"], [role="grid"], [role="treegrid"]';
    let inCell = false, foundTable = false, projectHost = null;
    for (let node = element, depth = 0; node; node = node.parentElement, depth++) {
      if (!pastWidget) {
        // Count every DOM element ancestor, including plain wrappers. The target is depth 0.
        if (depth && testAnchors.length < 4) {
          const value = attr(node, 'data-testid');
          if (value) {
            if (import.meta.env?.DEV) assertDomHops(element, node, depth);
            testAnchors.push({ value, depth });
          }
        }
        pastWidget = isProjectHost(node) && (node.hasAttribute('data-widget-id') || /-widget$/.test(node.localName));
      }
      if (depth && !handoff.ancestor_id) {
        const id = attr(node, 'id');
        if (id && !/^(?:mat-|mdc-|cdk-|vibe-)/i.test(id)) {
          if (import.meta.env?.DEV) assertDomHops(element, node, depth);
          handoff.ancestor_id = { value: id, tag: node.localName, depth };
        }
      }
      if (depth && !handoff.interactive_ancestor) {
        const role = attr(node, 'role');
        const menu = attr(node, 'matmenutriggerfor');
        const menuBinding = node.hasAttribute('ng-reflect-mat-menu-trigger-for') || node.classList.contains('mat-mdc-menu-trigger');
        if (['tab', 'cell', 'gridcell', 'option', 'button', 'link', 'menuitem'].includes(role) || menu || menuBinding
          || node.matches('button, a[href], td')) {
          if (import.meta.env?.DEV) assertDomHops(element, node, depth);
          handoff.interactive_ancestor = { tag: node.localName, depth, role, menu, menu_binding: menuBinding || undefined };
        }
      }
      for (const key of contextAttrs) {
        if (depth || key !== 'data-tab-index') context[key] ??= attr(node, key);
      }
      handoff.guard ??= attr(node, 'data-remarker-guard');
      if (node.hasAttribute('hidden')) handoff.hidden = true;
      if (node.getAttribute('aria-hidden') === 'true') handoff.aria_hidden = true;
      if (!inCell && node.matches('td, th, mat-cell, cdk-cell, ng-container, [role="cell"], [role="gridcell"]')) {
        inCell = true;
        if (!projectHost) {
          const hosts = [...node.children].filter(isProjectHost);
          if (hosts.length === 1) projectHost = hosts[0];
        }
        const binding = attr(node, 'awptablecell') || attr(node, 'ng-reflect-awp-table-cell')
          || (projectHost && (attr(projectHost, 'awptablecell') || attr(projectHost, 'ng-reflect-awp-table-cell')));
        const field = attr(node, 'data-column-field');
        const dataColumn = attr(node, 'data-column');
        const className = [...node.classList].find(name => /^(?:mat|cdk)-column-[\w-]+$/.test(name));
        const column = binding || field || dataColumn || className?.replace(/^(?:mat|cdk)-column-/, '');
        if (column) handoff.cell_column = {
          value: column,
          attribute: binding ? 'awpTableCell' : field ? 'data-column-field' : dataColumn ? 'data-column' : undefined,
          class_name: className,
        };
        if (node === element && projectHost) handoff.projected = { tag: projectHost.localName, binding };
      } else if (!inCell && isProjectHost(node)) {
        projectHost = node;
      }
      if (!handoff.row && node.matches(rowSelector)) {
        let identity = attr(node, 'data-remarker-row-key') || attr(node, 'data-row-key');
        if (!identity) {
          const keyCell = node.querySelector('[data-remarker-key-cell]')
            || node.querySelector(':scope > [data-column="name"], :scope > .cdk-column-name, :scope > .mat-column-name');
          if (keyCell) identity = textSample(keyCell, 80);
        }
        handoff.row = { repeated: true, identity };
      }
      if (handoff.row && !foundTable && node.matches(tableSelector)) {
        foundTable = true;
        handoff.row.container = attr(node, 'data-testid');
        // Some table implementations put the test anchor on the wrapping component.
        for (let parent = VibeShadowDOMUtils.getParentElement(node); !handoff.row.container && parent
          && !parent.matches(rowSelector + ', ' + tableSelector); parent = VibeShadowDOMUtils.getParentElement(parent)) {
          handoff.row.container = attr(parent, 'data-testid');
          if (!parent.localName.includes('-')) break;
        }
      }
    }
    if (testAnchors.length) handoff.test_anchors = testAnchors;
    if (Object.values(context).some(Boolean)) handoff.context = context;
    const explicitText = attr(element, 'data-remarker-text');
    if (element.children.length && element.matches('button, a[href], [role="tab"], [role="cell"], [role="gridcell"], [role="option"], [role="button"], td, mat-cell, cdk-cell, [matmenutriggerfor], [ng-reflect-mat-menu-trigger-for], .mat-mdc-menu-trigger')) {
      handoff.inner = dynamicInner(element);
    }
    const dynamic = dynamicTextKind(element, text, explicitText) || handoff.inner?.kind;
    if (dynamic) handoff.text_kind = dynamic;
    else if (explicitText === 'static' && text) handoff.text_kind = 'static';
    else if (explicitText === 'i18n' || element.matches(translationSelector)) handoff.text_kind = 'i18n';
    else if (handoff.row && text) handoff.text_kind = 'row data';
    if (element.matches('[role="tab"], [role="cell"], [role="gridcell"], [role="option"], mat-cell, cdk-cell, [matmenutriggerfor], [ng-reflect-mat-menu-trigger-for], .mat-mdc-menu-trigger')) {
      const label = promotedLabel(element);
      if (!dynamic || label?.via?.startsWith('aria-')) handoff.label = label;
    }

    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (rect.width > 0 && rect.height > 0 && style.pointerEvents !== 'none') {
      const stack = element.getRootNode().elementsFromPoint?.(x, y) || [];
      const hit = stack[0];
      if (hit && !element.contains(hit) && stack.some(node => element.contains(node))) {
        const loader = '.table__rows-loader';
        const modal = '.modal-backdrop, .cdk-overlay-backdrop, .cdk-overlay-dark-backdrop, [aria-modal="true"], dialog[open]';
        const overlayKinds = ['[data-remarker-overlay]', loader, ...modal.split(', '), '.cdk-overlay-pane', '[popover]:popover-open'];
        const overlay = hit.closest(overlayKinds.join(', '));
        if (overlay && !overlay.contains(element)) {
          const explicit = attr(overlay, 'data-remarker-overlay');
          const testId = attr(overlay, 'data-testid');
          const className = overlayKinds.find(selector => selector.startsWith('.') && overlay.matches(selector))
            || [...overlay.classList].find(name => !name.startsWith('vibe-'));
          const selector = testId ? '[data-testid="' + CSS.escape(testId) + '"]'
            : className ? overlay.localName + (className.startsWith('.') ? className : '.' + CSS.escape(className)) : undefined;
          const zIndex = getComputedStyle(overlay).zIndex;
          const kind = ['transient', 'sticky'].includes(explicit) ? explicit
            : overlay.matches(loader) ? 'transient' : overlay.matches(modal) ? 'sticky' : undefined;
          handoff.covered_by_overlay = { kind, selector, z_index: /^-?\d+$/.test(zIndex) ? zIndex : undefined,
            condition: attr(overlay, 'data-remarker-overlay-condition') };
        }
      }
    }
    return handoff;
  }

  // --- Main entry point ---

  async function generate(element) {
    const selector = generateSelector(element);
    const computedStyle = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const classes = getDisplayClasses(element);
    const text = textSample(element);
    const translationKey = getTranslationKey(element);

    const context = {
      selector,
      tag: element.tagName.toLowerCase(),
      classes,
      text,
      state: getElementState(element, computedStyle),
      translation_key: translationKey,
      handoff: getHandoffContext(element, text, rect, computedStyle),
      path: getElementLocationPath(element),
      styles: {
        display: computedStyle.display,
        opacity: computedStyle.opacity,
        pointerEvents: computedStyle.pointerEvents,
        visibility: computedStyle.visibility,
        cursor: computedStyle.cursor,
        position: computedStyle.position,
        fontSize: computedStyle.fontSize,
        fontWeight: computedStyle.fontWeight,
        lineHeight: computedStyle.lineHeight,
        textAlign: computedStyle.textAlign,
        color: computedStyle.color,
        backgroundColor: computedStyle.backgroundColor,
        margin: computedStyle.margin,
        padding: computedStyle.padding,
        paddingTop: computedStyle.paddingTop,
        paddingRight: computedStyle.paddingRight,
        paddingBottom: computedStyle.paddingBottom,
        paddingLeft: computedStyle.paddingLeft,
        marginTop: computedStyle.marginTop,
        marginRight: computedStyle.marginRight,
        marginBottom: computedStyle.marginBottom,
        marginLeft: computedStyle.marginLeft,
        flexDirection: computedStyle.flexDirection,
        flexWrap: computedStyle.flexWrap,
        justifyContent: computedStyle.justifyContent,
        alignItems: computedStyle.alignItems,
        gap: computedStyle.gap,
        columnGap: computedStyle.columnGap,
        rowGap: computedStyle.rowGap,
        gridTemplateColumns: computedStyle.gridTemplateColumns,
        gridTemplateRows: computedStyle.gridTemplateRows,
        borderTopWidth: computedStyle.borderTopWidth,
        borderRadius: computedStyle.borderRadius,
        borderStyle: computedStyle.borderStyle,
        borderColor: computedStyle.borderColor,
        width: computedStyle.width,
        minWidth: computedStyle.minWidth,
        maxWidth: computedStyle.maxWidth,
        height: computedStyle.height,
        minHeight: computedStyle.minHeight,
        maxHeight: computedStyle.maxHeight
      },
      position: {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      source_mapping: await generateSourceMapping(element),
      screenshot: null,
      parent_chain: getParentChainContext(element, 4)
    };
    context.target_identity = {
      ...context.source_mapping.target_identity,
      tag: context.tag,
      classes: handoffClasses(element),
    };
    const attributes = context.target_identity.attributes ??= {};
    for (const name of ['data-testid', 'data-test', 'data-cy', 'data-component', 'id', 'aria-label', 'role', 'type',
      'data-tab-index', 'matmenutriggerfor', 'awptablecell', 'awptranslatetooltip']) {
      const value = element.getAttribute(name);
      if (value && value.length <= 120) attributes[name] = value;
    }
    for (const name of ['translate', 'ng-reflect-translate']) {
      const value = element.getAttribute(name);
      if (/^[A-Za-z][\w-]*(?:\.[\w-]+)+$/.test(value || '') && value.length <= 120) attributes[name] = value;
    }
    if (element.hasAttribute('ng-reflect-mat-menu-trigger-for')) attributes['ng-reflect-mat-menu-trigger-for'] = true;

    // Real screenshots are captured asynchronously after save (see screenshot.js) —
    // a cropped chrome.tabs.captureVisibleTab, not a synthetic canvas. Left null here.

    return context;
  }

  // --- Selector generation (multi-strategy fallback) ---

  function generateSelector(element) {
    // Shadow DOM elements need a compound selector: host >> host >> inner
    const shadowSel = generateShadowAwareSelector(element);
    if (shadowSel) return shadowSel;

    if (element.id && element.id !== 'undefined') return `#${CSS.escape(element.id)}`;

    const unique = findUniqueAttributeSelector(element);
    if (unique) return unique;

    const textSel = generateTextBasedSelector(element);
    if (textSel && isUnique(textSel)) return textSel;

    const classSel = generateClassSelector(element);
    if (classSel && isUnique(classSel)) return classSel;

    const ctxSel = generateLimitedContextSelector(element);
    if (ctxSel && isUnique(ctxSel)) return ctxSel;

    const fallSel = generateFallbackSelector(element);
    if (fallSel && isUnique(fallSel)) return fallSel;

    const pathSel = generateRobustPathSelector(element);
    if (pathSel && isUnique(pathSel)) return pathSel;

    // Last resort: a best-effort STRUCTURAL selector. It may not be perfectly unique,
    // but unlike a runtime-injected data-vibe-id it actually exists in the source — so
    // an agent grepping the codebase (or another person reading the annotation) can
    // find the element. Live badge anchoring still disambiguates via text / class /
    // position (see findElementBySelector), so uniqueness here isn't required.
    return pathSel || generateFallbackSelector(element) || element.tagName.toLowerCase();
  }

  // Build "host >> host >> innerSelector" for elements inside shadow DOM
  function generateShadowAwareSelector(element) {
    if (!VibeShadowDOMUtils.isInShadowDOM(element)) return null;

    const root = element.getRootNode();
    if (!VibeShadowDOMUtils.isShadowRoot(root)) return null;

    const shadowHosts = VibeShadowDOMUtils.getShadowPath(element);
    if (!shadowHosts.length) return null;

    const hostSelectors = [];
    for (let i = 0; i < shadowHosts.length; i++) {
      const host = shadowHosts[i];
      const hostRoot = i === 0 ? document : shadowHosts[i - 1].shadowRoot;
      const sel = generateSelectorInRoot(host, hostRoot);
      if (!sel) return null;
      hostSelectors.push(sel);
    }

    const innerSelector = generateSelectorInRoot(element, root);
    return VibeShadowDOMUtils.buildShadowSelector(hostSelectors, innerSelector);
  }

  // Generate a selector for `element` scoped to `root` (document or ShadowRoot)
  function generateSelectorInRoot(element, root) {
    if (element.id && element.id !== 'undefined') {
      const sel = `#${CSS.escape(element.id)}`;
      if (isUniqueIn(sel, root)) return sel;
    }

    const unique = findUniqueAttributeSelector(element, root);
    if (unique) return unique;

    const classSel = generateClassSelector(element);
    if (classSel && isUniqueIn(classSel, root)) return classSel;

    // Path-based fallback within this root
    const pathParts = [];
    let current = element;
    while (current && current !== root && !(VibeShadowDOMUtils.isShadowRoot(current))) {
      const tag = current.tagName.toLowerCase();
      let part = tag;
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(el => el.tagName.toLowerCase() === tag);
        if (siblings.length > 1) {
          const index = siblings.indexOf(current);
          if (index !== -1) part = `${tag}:nth-of-type(${index + 1})`;
        }
      }
      pathParts.unshift(part);
      current = current.parentElement;
    }

    const pathSel = pathParts.join(' > ');
    if (pathSel && isUniqueIn(pathSel, root)) return pathSel;

    // Prefer a structural path (greppable in source) over an injected data-vibe-id.
    return pathSel || generateDataAttributeSelector(element);
  }

  function findUniqueAttributeSelector(element, root = document) {
    // Priority order: stable test/identity attributes first, then semantic
    const stableAttrs = [
      'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa',
      'data-e2e', 'data-automation-id', 'data-component',
      'aria-label', 'title', 'name', 'role'
    ];
    const tag = element.tagName.toLowerCase();
    const unique = (sel) => isUniqueIn(sel, root);

    // First pass: check the element itself
    for (const attr of stableAttrs) {
      const value = element.getAttribute(attr);
      if (value) {
        const sel = `${tag}[${attr}="${CSS.escape(value)}"]`;
        if (unique(sel)) return sel;
      }
    }

    // Second pass: check nearest ancestor with a stable attribute (scoped selector)
    let parent = VibeShadowDOMUtils.getParentElement(element);
    let depth = 0;
    while (parent && parent.tagName !== 'BODY' && depth < 5) {
      for (const attr of stableAttrs.slice(0, 8)) { // test attrs only
        const value = parent.getAttribute(attr);
        if (value) {
          const parentSel = `${parent.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
          // Build child selector relative to this stable parent
          const childTag = tag;
          // Check if element is a direct child — use child combinator only if so
          const isDirectChild = VibeShadowDOMUtils.getParentElement(element) === parent;
          if (isDirectChild) {
            const directChildren = Array.from(parent.querySelectorAll(`:scope > ${childTag}`));
            if (directChildren.length === 1 && directChildren[0] === element) {
              const sel = `${parentSel} > ${childTag}`;
              if (unique(sel)) return sel;
            }
          }
          // Descendant selector with nth-of-type
          const allOfType = Array.from(parent.querySelectorAll(childTag));
          const idx = allOfType.indexOf(element);
          if (idx !== -1) {
            const sel = `${parentSel} ${childTag}:nth-of-type(${idx + 1})`;
            if (unique(sel)) return sel;
          }
        }
      }
      parent = VibeShadowDOMUtils.getParentElement(parent);
      depth++;
    }

    return null;
  }

  function generateTextBasedSelector(element) {
    const text = element.textContent?.trim();
    if (!text || text.length > 100) return null;
    const tag = element.tagName.toLowerCase();
    if (!['button', 'a', 'span', 'div'].includes(tag)) return null;

    const sanitized = text.replace(/[^\w\s]/g, '').trim();
    if (!sanitized || sanitized.length >= 50) return null;

    const candidates = VibeShadowDOMUtils.querySelectorAllDeep(document, tag);
    const matches = candidates.filter(el =>
      el.textContent?.trim().replace(/[^\w\s]/g, '').trim() === sanitized
    );
    if (matches.length === 1) {
      element.setAttribute('data-text-content', sanitized);
      return `${tag}[data-text-content="${CSS.escape(sanitized)}"]`;
    }
    return null;
  }

  function generateClassSelector(element) {
    if (!element.className) return null;
    const classes = getDisplayClasses(element).slice(0, 4);
    if (!classes.length) return null;
    return `${element.tagName.toLowerCase()}.${classes.map(c => CSS.escape(c)).join('.')}`;
  }

  function generateLimitedContextSelector(element) {
    const classSel = generateClassSelector(element);
    if (!classSel) return null;
    const parent = VibeShadowDOMUtils.getParentElement(element);
    if (!parent || parent.tagName === 'BODY') return null;
    const pClasses = Array.from(parent.classList)
      .filter(c => !c.startsWith('vibe-'))
      .filter(isStableClass)
      .slice(0, 2);
    if (!pClasses.length) return null;
    return `${parent.tagName.toLowerCase()}.${pClasses.map(c => CSS.escape(c)).join('.')} > ${classSel}`;
  }

  function generateFallbackSelector(element) {
    const tag = element.tagName.toLowerCase();
    const parent = VibeShadowDOMUtils.getParentElement(element);
    if (!parent) return null;

    // Build qualified parent selector — require classes or ID to avoid fragile bare-tag selectors
    let parentSel = parent.tagName.toLowerCase();
    if (parent.id) {
      parentSel += `#${CSS.escape(parent.id)}`;
    } else {
      const pClasses = Array.from(parent.classList)
        .filter(c => !c.startsWith('vibe-'))
        .filter(isStableClass)
        .slice(0, 3);
      if (pClasses.length) {
        parentSel += `.${pClasses.map(c => CSS.escape(c)).join('.')}`;
      }
    }

    // If parent has no qualifying info, selector is too fragile — skip
    if (parentSel === parent.tagName.toLowerCase()) return null;

    const siblings = Array.from(parent.children).filter(el => el.tagName.toLowerCase() === tag);
    const index = siblings.indexOf(element) + 1;
    const attrs = [];
    if (element.type) attrs.push(`[type="${element.type}"]`);
    if (element.role) attrs.push(`[role="${element.role}"]`);

    return `${parentSel} > ${tag}${attrs.join('')}:nth-of-type(${index})`;
  }

  function generateRobustPathSelector(element) {
    const path = [];
    let current = element;
    let depth = 0;
    while (current && current.tagName !== 'BODY' && depth < 4) {
      const tag = current.tagName.toLowerCase();
      let id = tag;

      const stable = Array.from(current.classList)
        .filter(c => !c.startsWith('vibe-'))
        .filter(isStableClass)
        .slice(0, 2);

      if (stable.length) {
        id = `${tag}.${stable.map(c => CSS.escape(c)).join('.')}`;
      } else if (current.id && current.id !== 'undefined') {
        id = `${tag}#${CSS.escape(current.id)}`;
      } else if (current.getAttribute('role')) {
        id = `${tag}[role="${current.getAttribute('role')}"]`;
      } else {
        const siblings = Array.from(VibeShadowDOMUtils.getParentElement(current)?.children || []);
        const same = siblings.filter(s => s.tagName.toLowerCase() === tag);
        if (same.length > 1) {
          id = `${tag}:nth-of-type(${same.indexOf(current) + 1})`;
        }
      }

      path.unshift(id);
      current = VibeShadowDOMUtils.getParentElement(current);
      depth++;
    }
    return path.length ? path.join(' > ') : null;
  }

  function generateDataAttributeSelector(element) {
    const id = `vibe-annotation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    element.setAttribute('data-vibe-id', id);
    return `[data-vibe-id="${id}"]`;
  }

  function isStableClass(cls) {
    return ![
      /^hover:/, /^focus:/, /^active:/, /^disabled:/,
      /^transition/, /^duration/, /^ease/,
      /^[a-z0-9]{8,}$/,
      /--/,
      /\[.*\]/
    ].some(p => p.test(cls));
  }

  function isUnique(selector) {
    try { return VibeShadowDOMUtils.querySelectorCountDeep(document, selector, 1) === 1; }
    catch { return false; }
  }

  // Uniqueness within a specific root (ShadowRoot or document) — no deep traversal
  function isUniqueIn(selector, root) {
    try { return root.querySelectorAll(selector).length === 1; }
    catch { return false; }
  }

  // --- Source mapping ---

  async function generateSourceMapping(element) {
    try {
      const srcInfo = await extractSourceInfo(element);
      const projectArea = getProjectAreaFromURL();
      // Do not change annotation.url or legacy non-Angular route addressing.
      const urlPath = srcInfo.angular ? window.location.pathname : vibeLocationPath(window.location);
      const hints = withIdentityHints(generateContextHints(element), srcInfo);
      return {
        source_file_path: srcInfo.filePath || null,
        source_line_range: srcInfo.lineRange || null,
        project_area: projectArea,
        url_path: urlPath,
        source_map_available: srcInfo.hasSourceMap || false,
        framework: srcInfo.angular ? 'angular' : null,
        angular: srcInfo.angular || null,
        target_identity: srcInfo.target_identity || null,
        context_hints: hints
      };
    } catch {
      return {
        source_file_path: null,
        source_line_range: null,
        project_area: 'unknown',
        url_path: vibeLocationPath(window.location),
        source_map_available: false,
        framework: null,
        angular: null,
        context_hints: generateContextHints(element)
      };
    }
  }

  async function extractSourceInfo(element) {
    const empty = {
      filePath: null, lineRange: null, hasSourceMap: false,
      componentName: null, ownerChain: null, framework: null, angular: null
    };

    // Primary: ask the MAIN world to read the framework fiber/instance.
    // (Page-set expandos like __reactFiber$… are invisible in the isolated world.)
    try {
      const main = await readSourceFromMainWorld(element);
      if (main) {
        return {
          filePath: main.filePath ? normalizeSourcePath(main.filePath) : null,
          lineRange: main.lineRange || null,
          hasSourceMap: !!main.hasSourceMap,
          componentName: main.componentName || null,
          ownerChain: main.ownerChain || null,
          framework: main.angular ? 'angular' : null,
          angular: main.angular || null,
          target_identity: main.target_identity || null,
        };
      }
    } catch { /* continue to backstop */ }

    // Backstop: build-tool data attributes (data-source-file, data-nextjs-path, …).
    try {
      const data = getDataAttributeInfo(element);
      if (data) return { ...empty, ...data };
    } catch { /* continue */ }

    return empty;
  }

  // Ask the MAIN-world script to read framework source/identity for `element`.
  // Handshake: tag the node with a temporary probe attribute, dispatch a request,
  // the MAIN world re-selects the same shared node and reads its fiber/instance.
  // The marker is always stripped, and a timeout guarantees we never hang the
  // capture (on non-framework pages the MAIN world replies null immediately).
  const FIBER_PROBE_ATTR = 'data-vibe-fiber-probe';
  let probeSeq = 0;

  function readSourceFromMainWorld(element) {
    return new Promise((resolve) => {
      let settled = false;
      const marker = 'fp_' + (++probeSeq) + '_' + Date.now();
      const id = '__vibe_main_' + marker;

      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener('vibe-bridge:main-response', handler);
        try { element.removeAttribute(FIBER_PROBE_ATTR); } catch { /* detached */ }
        resolve(value);
      }

      function handler(e) {
        if (e.detail?.id !== id) return;
        finish(e.detail.error ? null : e.detail.result);
      }

      const timer = setTimeout(() => finish(null), 1500);

      try {
        element.setAttribute(FIBER_PROBE_ATTR, marker);
        document.addEventListener('vibe-bridge:main-response', handler);
        document.dispatchEvent(new CustomEvent('vibe-bridge:main-request', {
          detail: { id, method: 'readSource', args: { marker } }
        }));
      } catch {
        finish(null);
      }
    });
  }

  // Append component identity from the MAIN-world read onto the DOM-derived hints.
  function withIdentityHints(baseHints, srcInfo) {
    const hints = Array.isArray(baseHints) ? baseHints.slice() : [];
    const ng = srcInfo?.angular;
    if (ng) {
      // Names/hosts are search clues, never a recovered source path or selector.
      for (let i = hints.length - 1; i >= 0; i--) {
        if (/^Nested .*component hierarchy$|^React test ID:/.test(hints[i])) hints.splice(i, 1);
      }
      if (ng.component) hints.unshift(`Angular component: ${ng.component}`);
      for (const [label, identity] of [['template owner (debug API)', ng.template_owner], ['hosted component', ng.hosted_component]]) {
        if (!identity) continue;
        hints.push(`Angular ${label}: ${identity.name || '(unknown name)'}; host: ${angularHostSelector(identity.host) || '(unavailable)'}`);
      }
      if (ng.chain) {
        hints.push(`Angular observed owner chain: ${ng.chain.components.map(n => n || '(unknown)').join(' > ') || '(none)'}; stop: ${ng.chain.stop_reason}`);
        if (ng.chain.unnamed_count) hints.push(`Angular chain unnamed instances: ${ng.chain.unnamed_count}`);
        for (const limitation of ng.chain.limitations || []) hints.push(`Angular limitation: ${limitation}`);
      }
      const target = srcInfo.target_identity;
      if (target?.relative_selector) hints.push(`Angular target locator: ${target.relative_selector}; matches: ${target.match_count}; scope: ${target.match_scope}`);
      else if (target?.relative_selector_reason) hints.push(`Angular target locator unavailable: ${target.relative_selector_reason}; use the DOM selector/path`);
      if (ng.api_issues?.length) hints.push(`Angular debug API issues: ${ng.api_issues.map(i => `${i.api}: ${i.reason}`).join(', ')}`);
      if (ng.directives?.length) hints.push(`Angular directives: ${ng.directives.join(', ')}`);
      if (ng.input_names?.length) hints.push(`Angular input names (no values): ${ng.input_names.join(', ')}`);
      if (ng.change_detection) hints.push(`Change detection: ${ng.change_detection}`);
      if (ng.version) hints.push(`Angular ${ng.version}; source: ${ng.version_source}`);
      return hints.length ? hints : null;
    }
    if (srcInfo?.componentName) hints.unshift(`Component: ${srcInfo.componentName}`);
    if (srcInfo?.ownerChain?.length) hints.push(`Component path: ${srcInfo.ownerChain.join(' > ')}`);
    return hints.length ? hints : null;
  }

  // `app-user-card.card#main` — the shape a developer greps for in templates.
  function angularHostSelector(host) {
    if (!host?.tag) return null;
    return host.tag
      + (host.classes || []).map(c => `.${CSS.escape(c)}`).join('');
  }


  function getDataAttributeInfo(element) {
    let current = element;
    let depth = 0;
    while (current && depth < 5) {
      const f = current.getAttribute('data-source-file') ||
        current.getAttribute('data-component-file') ||
        current.getAttribute('data-file');
      const l = current.getAttribute('data-source-line') || current.getAttribute('data-line');
      if (f) {
        return {
          filePath: normalizeSourcePath(f),
          lineRange: l ? `${l}-${parseInt(l) + 10}` : null,
          hasSourceMap: true
        };
      }
      const np = current.getAttribute('data-nextjs-path');
      if (np) return { filePath: normalizeSourcePath(np), lineRange: null, hasSourceMap: true };

      current = VibeShadowDOMUtils.getParentElement(current);
      depth++;
    }
    return null;
  }

  function normalizeSourcePath(fp) {
    let n = fp
      .replace(/^\[project\]\//, '')
      .replace(/^\[turbopack\]\//, '')
      .replace(/^\[next\]\//, '')
      .replace(/^.*\/(app\/.*?)$/, '$1')
      .replace(/^.*\/src\//, 'src/')
      .replace(/^.*\/components\//, 'components/')
      .replace(/^.*\/pages\//, 'pages/')
      .replace(/^.*\/app\/views\//, 'app/views/')
      .replace(/^.*\/app\/assets\//, 'app/assets/')
      .replace(/^.*\/app\/controllers\//, 'app/controllers/')
      .replace(/^.*\/app\/models\//, 'app/models/')
      .replace(/^.*\/app\/helpers\//, 'app/helpers/')
      .replace(/^.*\/templates\//, 'templates/')
      .replace(/^.*\/static\//, 'static/')
      .replace(/^.*\/public\//, 'public/')
      .replace(/^.*\/assets\//, 'assets/')
      .replace(/^.*\/js\//, 'js/')
      .replace(/^.*\/css\//, 'css/')
      .replace(/^.*\/scss\//, 'scss/')
      .replace(/^.*\/styles\//, 'styles/')
      .replace(/\?.*$/, '')
      .replace(/#.*$/, '');

    if (!n.startsWith('app/') && n.includes('/app/')) {
      n = 'app/' + n.split('/app/')[1];
    }
    return n;
  }

  function getProjectAreaFromURL() {
    const pathname = new URL(window.location.href).pathname;
    const segs = pathname.substring(1).split('/').filter(s => s);
    if (!segs.length) return 'home';
    const area = segs[0].toLowerCase();
    const map = {
      admin: 'admin', dashboard: 'dashboard', 'control-panel': 'admin', cp: 'admin',
      users: 'users', user: 'users', profile: 'users', profiles: 'users', account: 'users', accounts: 'users',
      products: 'products', product: 'products', items: 'products', item: 'products', catalog: 'products',
      orders: 'orders', order: 'orders', checkout: 'orders', cart: 'orders', shopping: 'orders',
      posts: 'content', post: 'content', articles: 'content', article: 'content', blog: 'content', news: 'content',
      settings: 'settings', config: 'settings', configuration: 'settings', preferences: 'settings',
      login: 'auth', signin: 'auth', signup: 'auth', register: 'auth', auth: 'auth', authentication: 'auth'
    };
    return map[area] || area;
  }

  // --- Context hints ---

  function generateContextHints(element) {
    const hints = [];
    const role = inferSemanticRole(element);
    if (role) hints.push(`UI section: ${role}`);

    const depth = getComponentDepth(element);
    if (depth > 1) hints.push(`Nested ${depth} levels deep in component hierarchy`);

    const fw = detectFrameworkPatterns(element);
    if (fw.length) hints.push(...fw);

    return hints.length ? hints : null;
  }

  // Shadow-aware closest: walks up via getParentElement so it crosses shadow boundaries
  function closestDeep(el, selector) {
    let current = el;
    while (current) {
      try { if (current.matches && current.matches(selector)) return current; } catch { /* skip */ }
      current = VibeShadowDOMUtils.getParentElement(current);
    }
    return null;
  }

  function inferSemanticRole(el) {
    if (closestDeep(el, 'nav, [role="navigation"]')) return 'navigation';
    if (closestDeep(el, 'header, [role="banner"]')) return 'header';
    if (closestDeep(el, 'footer, [role="contentinfo"]')) return 'footer';
    if (closestDeep(el, 'aside, [role="complementary"]')) return 'sidebar';
    if (closestDeep(el, 'main, [role="main"]')) return 'main-content';
    if (closestDeep(el, 'form, [role="form"]')) return 'form';
    if (closestDeep(el, '[role="dialog"], .modal, .popup, .overlay')) return 'modal';
    if (closestDeep(el, '.card, .item, .post, .article, [role="article"]')) return 'content-card';
    if (closestDeep(el, 'li, [role="listitem"], .list-item')) return 'list-item';
    if (el.matches('button, [role="button"], .btn, .button')) return 'button';
    if (el.matches('input, select, textarea, [role="textbox"]')) return 'form-input';
    if (closestDeep(el, 'table, [role="table"], [role="grid"]')) return 'table';
    return null;
  }

  function getComponentDepth(el) {
    let depth = 0, current = VibeShadowDOMUtils.getParentElement(el);
    while (current && depth < 10 && current.tagName !== 'BODY') {
      const cls = Array.from(current.classList);
      if (cls.some(c => /^[A-Z][a-zA-Z0-9]*/.test(c) || c.includes('component') || c.includes('container') || c.includes('wrapper'))) {
        depth++;
      }
      current = VibeShadowDOMUtils.getParentElement(current);
    }
    return depth;
  }

  function detectFrameworkPatterns(el) {
    const p = [];
    if (el.hasAttribute('data-testid')) p.push(`React test ID: ${el.getAttribute('data-testid')}`);
    if (el.closest('[data-nextjs-scroll-focus-boundary]') || document.querySelector('script[src*="_next"]')) {
      p.push('Next.js app detected');
    }
    const cls = Array.from(el.classList);
    if (cls.some(c => /^[a-z0-9]{6,}$/.test(c) || c.startsWith('css-') || c.startsWith('emotion-'))) {
      p.push('CSS-in-JS styling detected');
    }
    return p;
  }


  // --- Parent chain ---

  function getElementLocationPath(element, maxDepth = 4) {
    const segments = [];
    let current = element;
    while (current && current.tagName !== 'BODY' && segments.length < maxDepth) {
      segments.unshift(formatPathSegment(current));
      current = VibeShadowDOMUtils.getParentElement(current);
    }
    return segments.join(' > ');
  }

  function formatPathSegment(element) {
    const tag = element.tagName.toLowerCase();
    if (element.id && element.id !== 'undefined') return `${tag}#${sanitizePathValue(element.id)}`;

    const classes = getDisplayClasses(element).slice(0, 4);
    if (classes.length) {
      return `${tag}[class="${classes.map(c => sanitizePathValue(c, 48)).join(' ')}"]`;
    }

    const role = element.getAttribute('role');
    if (role) return `${tag}[role="${sanitizePathValue(role)}"]`;

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return `${tag}[aria-label="${sanitizePathValue(ariaLabel, 24)}"]`;

    const parent = VibeShadowDOMUtils.getParentElement(element);
    if (parent) {
      const siblings = Array.from(parent.children).filter(el => el.tagName === element.tagName);
      if (siblings.length > 1) {
        return `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`;
      }
    }

    return tag;
  }

  function sanitizePathValue(value, maxLen = 48) {
    return String(value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
  }

  function isGenericFrameworkClass(cls) {
    return [
      /^ng-tns-[\w-]+$/i,
      /^ng-star-inserted$/i,
      /^ng-trigger(?:-[\w-]+)?$/i,
      /^ng-[\w-]+-\d+$/i,
      /^cdk-[\w-]+(?:-\d+)?$/i,
      /^css-[a-z0-9]+$/i,
      /^sc-[a-z0-9]+$/i,
      /^jsx-\d+$/i,
      /^jss\d+$/i,
      /^__[\w-]+__$/i
    ].some((pattern) => pattern.test(cls));
  }

  function getDisplayClasses(source) {
    const classes = source instanceof Element
      ? Array.from(source.classList)
      : Array.isArray(source) ? source : [];

    return classes
      .filter(Boolean)
      .filter(c => !c.startsWith('vibe-'))
      .filter(isStableClass)
      .filter(c => !isGenericFrameworkClass(c));
  }

  function getParentChainContext(element, maxDepth = 3) {
    const chain = [];
    let current = VibeShadowDOMUtils.getParentElement(element);
    let depth = 0;
    while (current && depth < maxDepth && current.tagName !== 'BODY') {
      const info = {
        tag: current.tagName.toLowerCase(),
        classes: getDisplayClasses(current),
        id: current.id || null,
        role: current.getAttribute('role') || null,
        text_sample: textSample(current, 50)
      };
      if (info.classes.length || info.id || info.role ||
        ['nav', 'header', 'footer', 'main', 'section', 'article', 'aside'].includes(info.tag)) {
        chain.push(info);
      }
      current = VibeShadowDOMUtils.getParentElement(current);
      depth++;
    }
    return chain.length ? chain : null;
  }

  // --- Element finding (for badge re-rendering) ---

  function resolveSelector(selector) {
    if (!selector) return null;
    // Shadow compound selector: host >> host >> inner
    if (VibeShadowDOMUtils.isShadowSelector(selector)) {
      return VibeShadowDOMUtils.findByShadowSelector(document, selector);
    }
    // Regular selector — try deep (covers elements inside shadow roots)
    return VibeShadowDOMUtils.querySelectorDeep(document, selector);
  }

  // For shadow selectors, try to resolve the host chain even when the full
  // selector fails — this lets us scope text/class fallbacks to the correct
  // shadow root instead of searching the entire document.
  function resolveShadowRoot(selector) {
    if (!VibeShadowDOMUtils.isShadowSelector(selector)) return null;
    const parts = selector.split(VibeShadowDOMUtils.SHADOW_SEPARATOR).map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    // Walk the host chain (all parts except the last)
    let currentRoot = document;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        const el = currentRoot.querySelector(parts[i]);
        if (!el || !el.shadowRoot) return null;
        currentRoot = el.shadowRoot;
      } catch { return null; }
    }
    return currentRoot;
  }

  // Truncate + sanitize text for comparison (stored text is max 100 chars)
  function normalizeText(text) {
    if (!text) return '';
    return text.substring(0, 100).trim().replace(/[^\w\s]/g, '').trim();
  }

  function findElementBySelector(annotation) {
    try {
      const el = resolveSelector(annotation.selector);
      if (el) {
        // Verify text content to catch drifted selectors
        const expectedText = annotation.element_context?.text;
        if (expectedText) {
          const actualText = el.textContent?.substring(0, 100).trim();
          const changedText = annotation.pending_changes?.copyChange?.value?.substring(0, 100).trim();
          if (actualText === expectedText || textSample(el) === expectedText || (changedText && actualText === changedText)) return el;
          // Selector matched wrong element — fall through to fallbacks
        } else {
          return el;
        }
      }
    } catch { /* invalid selector */ }

    // For shadow selectors, try to scope fallback searches to the correct shadow root
    const scopeRoot = resolveShadowRoot(annotation.selector) || document;

    // Fallback: text matching (scoped to shadow root when possible, deep otherwise)
    if (annotation.element_context?.text && annotation.element_context?.tag) {
      const tag = annotation.element_context.tag;
      const sanitized = normalizeText(annotation.element_context.text);

      // Search scoped root first, fall back to deep search
      let candidates = scopeRoot !== document
        ? Array.from(scopeRoot.querySelectorAll(tag))
        : VibeShadowDOMUtils.querySelectorAllDeep(document, tag);

      // Also recognize older notes whose stored text predates boundary separation.
      const matchesText = el => normalizeText(el.textContent) === sanitized || normalizeText(textSample(el)) === sanitized;
      let matches = candidates.filter(matchesText);

      // If original text doesn't match, try the edited copy change value
      if (matches.length === 0 && annotation.pending_changes?.copyChange?.value) {
        const changedSanitized = normalizeText(annotation.pending_changes.copyChange.value);
        matches = candidates.filter(el => normalizeText(el.textContent) === changedSanitized);
      }

      // If scoped search found nothing, try deep search as last resort
      if (matches.length === 0 && scopeRoot !== document) {
        candidates = VibeShadowDOMUtils.querySelectorAllDeep(document, tag);
        matches = candidates.filter(matchesText);
      }

      if (matches.length === 1) return matches[0];

      // Narrow by classes
      if (matches.length > 1 && annotation.element_context.classes?.length) {
        const best = matches.find(el => {
          const cls = Array.from(el.classList);
          return annotation.element_context.classes.some(c => cls.includes(c));
        });
        if (best) return best;
      }

      // Narrow by position
      if (matches.length > 1 && annotation.element_context.position) {
        const pos = annotation.element_context.position;
        const best = matches.find(el => {
          const r = el.getBoundingClientRect();
          return Math.abs((r.left + window.scrollX) - pos.x) < 50 &&
            Math.abs((r.top + window.scrollY) - pos.y) < 50;
        });
        if (best) return best;
      }
    }

    // Fallback: class matching
    if (annotation.element_context?.tag && annotation.element_context?.classes?.length) {
      const stableClasses = annotation.element_context.classes.filter(isStableClass);
      if (stableClasses.length) {
        try {
          const sel = `${annotation.element_context.tag}.${stableClasses.map(c => CSS.escape(c)).join('.')}`;
          // Scope to shadow root if available
          const candidates = scopeRoot !== document
            ? Array.from(scopeRoot.querySelectorAll(sel))
            : VibeShadowDOMUtils.querySelectorAllDeep(document, sel);
          if (candidates.length === 1) return candidates[0];
        } catch { /* continue */ }
      }
    }

    // Fallback: data-vibe-id
    if (annotation.selector.includes('data-vibe-id')) {
      const m = annotation.selector.match(/data-vibe-id="([^"]+)"/);
      if (m) {
        const el = VibeShadowDOMUtils.querySelectorDeep(document, `[data-vibe-id="${m[1]}"]`);
        if (el) return el;
      }
    }

    return null;
  }

  // --- CSS variable scanner ---

  let cachedColorVars = null;

  function scanPageColorVariables() {
    if (cachedColorVars) return cachedColorVars;
    const vars = [];
    const seen = new Set();

    function scanStyleSheets(sheets) {
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.style) {
              for (const prop of rule.style) {
                if (prop.startsWith('--') && !seen.has(prop)) {
                  seen.add(prop);
                  const val = rule.style.getPropertyValue(prop).trim();
                  if (isColorValue(val)) {
                    const resolved = resolveColor(val);
                    if (resolved) vars.push({ name: prop, value: resolved });
                  }
                }
              }
            }
          }
        } catch (e) { /* CORS-blocked stylesheet, skip */ }
      }
    }

    // Scan document stylesheets
    try { scanStyleSheets(document.styleSheets); } catch (e) {}

    // Scan shadow root stylesheets (adoptedStyleSheets + inline <style>)
    try {
      const hosts = document.querySelectorAll('*');
      for (const el of hosts) {
        if (!el.shadowRoot) continue;
        try {
          if (el.shadowRoot.adoptedStyleSheets?.length) {
            scanStyleSheets(el.shadowRoot.adoptedStyleSheets);
          }
          if (el.shadowRoot.styleSheets?.length) {
            scanStyleSheets(el.shadowRoot.styleSheets);
          }
        } catch { /* skip */ }
      }
    } catch (e) {}

    // Dedupe by resolved color value
    const uniqueMap = new Map();
    for (const v of vars) {
      if (!uniqueMap.has(v.value)) uniqueMap.set(v.value, v);
    }
    cachedColorVars = Array.from(uniqueMap.values());
    return cachedColorVars;
  }

  function isColorValue(val) {
    if (!val || val === 'inherit' || val === 'initial' || val === 'unset') return false;
    if (/^#([0-9a-f]{3,8})$/i.test(val)) return true;
    if (/^(rgb|hsl)a?\s*\(/.test(val)) return true;
    // Test via temp element
    const el = document.createElement('span');
    el.style.color = '';
    el.style.color = val;
    return el.style.color !== '';
  }

  function resolveColor(val) {
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = val;
      const resolved = ctx.fillStyle;
      // Canvas returns '#000000' for invalid colors — only accept if input wasn't obviously wrong
      if (resolved === '#000000' && !/^#0{3,6}$/i.test(val) && !/rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/.test(val)) {
        return null;
      }
      return resolved;
    } catch (e) {
      return null;
    }
  }

const VibeElementContext = {
  generate,
  generateSelector,
  findElementBySelector,
  scanPageColorVariables,
  getDisplayClasses,
};
export default VibeElementContext;
