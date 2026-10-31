// Minimal Chrome DevTools Protocol driver shared by the e2e scripts (Node 22+: global WebSocket and fetch).
// Works against headless Chromium (web mode) and Electron (`--remote-debugging-port`).

import { writeFileSync } from 'node:fs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Console errors that are expected: the tests provoke 4xx responses on purpose (bad key, bad path, duplicates). */
const EXPECTED_LOG = /Failed to load resource: the server responded with a status of 4\d\d/;

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  n: { code: 'KeyN', vk: 78 },
};

export async function connect(port, { urlPrefix } = {}) {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = targets.find((t) => t.type === 'page' && (!urlPrefix || t.url.startsWith(urlPrefix)));
    } catch {
      // not up yet
    }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error(`no page target on CDP port ${port}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP websocket failed'));
  });

  let nextId = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      problems.push(`exception: ${d.text} ${d.exception?.description ?? ''}`.trim());
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      const { text, url } = msg.params.entry;
      if (!EXPECTED_LOG.test(text)) problems.push(`log.error: ${text} ${url ?? ''}`.trim());
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      if (process.env.E2E_TRACE)
        console.error(
          `[cdp ${new Date().toISOString().slice(17, 23)}] ${method} ${JSON.stringify(params).slice(0, 140)}`,
        );
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after 20 s`));
      }, 20000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('DOM.enable');
  // A window that is hidden or unfocused (Wayland, background workspace) stalls input events until the next frame.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send('Page.bringToFront').catch(() => {});

  /** Evaluates an expression in the page (awaits promises) and returns its JSON value. */
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const why = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`eval failed: ${expression.slice(0, 200)}\n${why}`);
    }
    return r.result?.value;
  };

  const waitFor = async (expression, label, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await ev(`Boolean(${expression})`)) return true;
      await sleep(100);
    }
    throw new Error(`timeout waiting for: ${label}`);
  };

  const viewport = (width, height) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const screenshot = async (path) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
  };

  const mouse = { x: 0, y: 0 };
  /** Real mouse click at the centre of the element `elementExpr` evaluates to (Radix menus ignore a bare `.click()`). */
  const click = async (elementExpr, label = elementExpr) => {
    const box = await ev(`(() => {
      const e = ${elementExpr};
      if (!e) return null;
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`click target not found: ${label}`);
    const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    // Move in steps like a hand would (Radix submenus watch the pointer path and close on a teleporting cursor).
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: mouse.x + ((box.x - mouse.x) * i) / 6,
        y: mouse.y + ((box.y - mouse.y) * i) / 6,
      });
    }
    mouse.x = box.x;
    mouse.y = box.y;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...at });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...at });
  };

  /** Real key press. `modifiers`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. Enter types a newline unless the app prevents it. */
  const key = async (name, modifiers = 0) => {
    const k = KEYS[name];
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, modifiers };
    const printable = k.text !== undefined && (modifiers & ~8) === 0;
    await send(
      'Input.dispatchKeyEvent',
      printable ? { type: 'keyDown', ...base, text: k.text } : { type: 'rawKeyDown', ...base },
    );
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  /** Sets a React-controlled input / textarea value. */
  const type = (selector, value) =>
    ev(`(() => {
      const e = document.querySelector(${JSON.stringify(selector)});
      if (!e) throw new Error('no element: ' + ${JSON.stringify(selector)});
      const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)});
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.focus();
      return true;
    })()`);

  /** Attaches files to the (hidden) composer file input, like picking them in the OS dialog. */
  const setFiles = async (files) => {
    const { root } = await send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid="file-input"]' });
    if (!nodeId) throw new Error('no file input on the page');
    await send('DOM.setFileInputFiles', { nodeId, files });
  };

  /** Expression for the first element matching `selector` whose text includes (or equals, with `exact`) `text`. */
  const byText = (selector, text, exact = false) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${
      exact ? `e.textContent.trim() === ${JSON.stringify(text)}` : `e.textContent.includes(${JSON.stringify(text)})`
    })`;

  const text = () => ev('document.body.innerText');

  return {
    send,
    ev,
    waitFor,
    viewport,
    screenshot,
    click,
    key,
    type,
    setFiles,
    byText,
    text,
    problems,
    close: () => ws.close(),
  };
}
