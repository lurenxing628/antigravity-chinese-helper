/** Small Chrome DevTools Protocol client using Node's built-in WebSocket. */
export class CdpClient {
  #socket;
  #pending = new Map();
  #listeners = new Map();
  #nextId = 1;
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result ?? {});
      } else if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) {
          try { listener(message.params ?? {}); } catch { /* Event handlers own their work. */ }
        }
      }
    });
    socket.addEventListener('close', () => this.#finish());
    socket.addEventListener('error', () => this.#finish());
  }

  static async connect(url, timeoutMs = 5000) {
    const socket = new WebSocket(url);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        socket.removeEventListener('close', failed);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('CDP connection failed')); };
      const timer = setTimeout(() => {
        cleanup();
        client.close();
        reject(new Error('CDP connection timed out'));
      }, timeoutMs);
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      socket.addEventListener('close', failed, { once: true });
    });
    return client;
  }

  get connected() { return !this.#closed && this.#socket.readyState === WebSocket.OPEN; }

  call(method, params = {}, timeoutMs = 8000) {
    if (!this.connected) return Promise.reject(new Error('CDP connection closed'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.#socket.send(JSON.stringify({ id, method, params })); }
      catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(listener);
    return () => this.#listeners.get(method)?.delete(listener);
  }

  #finish() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(new Error('CDP connection closed'));
    }
    this.#pending.clear();
    for (const listener of this.#listeners.get('close') ?? []) {
      try { listener(); } catch { /* Close is best effort. */ }
    }
    this.#listeners.clear();
  }

  close() {
    this.#finish();
    try { this.#socket.close(); } catch { /* Already closed. */ }
  }
}
