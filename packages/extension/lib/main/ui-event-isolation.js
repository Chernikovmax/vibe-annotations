const ISOLATED_EVENT_TYPES = new Set([
  'pointerdown', 'pointerup', 'pointermove', 'pointercancel',
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout',
  'click', 'dblclick', 'auxclick', 'contextmenu',
  'touchstart', 'touchmove', 'touchend', 'touchcancel',
  'keydown', 'keyup', 'keypress',
  'focus', 'blur', 'focusin', 'focusout',
  'input', 'beforeinput', 'change', 'paste', 'compositionstart', 'compositionupdate', 'compositionend', 'wheel',
  'dragstart', 'drag', 'dragend', 'drop',
]);
const installations = new WeakMap();

export function installUiEventIsolation() {
  // Installation is one-way; never restore over a patch installed later.
  const proto = EventTarget.prototype;
  if (installations.has(proto)) return;
  const nativeAdd = proto.addEventListener;
  const nativeRemove = proto.removeEventListener;
  const getSignalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
  let registeredHost = null;
  let state = { active: false, inspecting: false, region: false, gesture: null };

  function onRegister(event) {
    if (event.type === 'vibe-ui:register') {
      const target = event.target;
      if (target?.id !== 'vibe-annotations-root'
        || (registeredHost?.isConnected && target !== registeredHost)) return;
      registeredHost = target;
      state = { active: false, inspecting: false, region: false, gesture: null };
    } else if (event.type === 'vibe-ui:state' && event.target === registeredHost) {
      const detail = event.detail || {};
      state = {
        active: !!detail.active,
        inspecting: !!detail.inspecting,
        region: !!detail.region,
        gesture: detail.gesture || null,
      };
    }
  }
  nativeAdd.call(document, 'vibe-ui:register', onRegister, true);
  nativeAdd.call(document, 'vibe-ui:state', onRegister, true);

  function isRoot(target) {
    return target === window || target === document || target === document.body || target === document.documentElement;
  }
  const records = new WeakMap();
  function shouldSuppress(event) {
    if (!state.active || !registeredHost?.isConnected) return false;
    if (event.composedPath().includes(registeredHost)) return true;
    if (state.inspecting && (event.type === 'pointerdown' || event.type === 'mousedown')) {
      return event.button === undefined || (event.button === 0 && event.isPrimary !== false);
    }
    if (state.inspecting && event.type === 'keydown' && (event.key === 'Enter' || event.key === 'Escape')) return true;
    if (state.region && event.type === 'keydown' && event.key === 'Escape') return true;
    const gesture = state.gesture;
    if (!gesture) return false;
    if ((event.type === 'pointerup' || event.type === 'pointercancel') && event.pointerId === gesture.pointerId) return true;
    if (event.type === 'mouseup' && event.pointerId === undefined && gesture.phase === 'up') return true;
    return (event.type === 'click' || event.type === 'mouseup') && event.pointerId !== undefined && event.pointerId === gesture.pointerId;
  }

  function bucketFor(target, type, capture, create) {
    let types = records.get(target);
    if (!types && create) records.set(target, types = new Map());
    let captures = types?.get(type);
    if (!captures && create) types.set(type, captures = new Map());
    let callbacks = captures?.get(capture);
    if (!callbacks && create) captures.set(capture, callbacks = new Map());
    return { types, captures, callbacks };
  }

  function removeEntry(target, entry) {
    if (!entry.live) return;
    entry.live = false;
    nativeRemove.call(target, entry.type, entry.wrapper, entry.capture);
    if (entry.signal && entry.abortHandler) nativeRemove.call(entry.signal, 'abort', entry.abortHandler);
    const { types, captures, callbacks } = bucketFor(target, entry.type, entry.capture, false);
    callbacks?.delete(entry.listener);
    if (callbacks?.size === 0) captures.delete(entry.capture);
    if (captures?.size === 0) types.delete(entry.type);
    if (types?.size === 0) records.delete(target);
  }
  function isDictionary(options) {
    return options !== null && (typeof options === 'object' || typeof options === 'function');
  }

  function captureOption(options) {
    return isDictionary(options) ? !!options.capture : !!options;
  }


  proto.addEventListener = function (rawType, listener, options) {
    const type = String(rawType);
    if ((!listener || (typeof listener !== 'function' && typeof listener !== 'object'))
      || !ISOLATED_EVENT_TYPES.has(type) || !isRoot(this)) return nativeAdd.call(this, type, listener, options);
    const dictionary = isDictionary(options);
    const capture = captureOption(options);
    const once = dictionary ? !!options.once : false;
    const passive = dictionary ? options.passive : undefined;
    const signal = dictionary ? options.signal : undefined;
    const { callbacks } = bucketFor(this, type, capture, true);
    const existing = callbacks.get(listener);
    if (existing) {
      if (signal != null) getSignalAborted.call(signal);
      return;
    }
    const target = this;
    const entry = { type, listener, capture, once, signal, wrapper: null, abortHandler: null, live: true };
    entry.wrapper = function (event) {
      if (shouldSuppress(event)) return;
      if (entry.once) removeEntry(target, entry);
      if (typeof listener === 'function') return Reflect.apply(listener, this, [event]);
      const method = listener.handleEvent;
      return Reflect.apply(method, listener, [event]);
    };
    callbacks.set(listener, entry);
    try {
      nativeAdd.call(target, type, entry.wrapper, { capture, passive, signal });
      if (signal != null && getSignalAborted.call(signal)) {
        removeEntry(target, entry);
        return;
      }
      if (signal) {
        entry.abortHandler = () => removeEntry(target, entry);
        nativeAdd.call(signal, 'abort', entry.abortHandler, { once: true });
      }
    } catch (error) {
      removeEntry(target, entry);
      throw error;
    }
  };

  proto.removeEventListener = function (rawType, listener, options) {
    const type = String(rawType);
    if ((!listener || (typeof listener !== 'function' && typeof listener !== 'object'))
      || !ISOLATED_EVENT_TYPES.has(type) || !isRoot(this)) return nativeRemove.call(this, type, listener, options);
    const capture = captureOption(options);
    const entry = bucketFor(this, type, capture, false).callbacks?.get(listener);
    if (entry) removeEntry(this, entry);
    else return nativeRemove.call(this, type, listener, capture);
  };
  installations.set(proto, { nativeAdd, nativeRemove });
}
