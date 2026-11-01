// P0-T07 golden mock for `@tauri-apps/api/event`.
// Native-to-web events travel on window CustomEvents (`astra:*`, see
// `$shared/ipc/native-events`); this module only covers the Tauri channel
// surface the generated bindings reach for (listen/once/emit).

export type Event<T> = { event: string; id: number; payload: T };
export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

let nextId = 1;
const listeners = new Map<string, Map<number, EventCallback<never>>>();

function handlers(event: string): Map<number, EventCallback<never>> {
  let set = listeners.get(event);
  if (!set) {
    set = new Map();
    listeners.set(event, set);
  }
  return set;
}

export async function listen<T>(event: string, callback: EventCallback<T>): Promise<UnlistenFn> {
  const id = nextId++;
  handlers(event).set(id, callback as EventCallback<never>);
  return () => {
    listeners.get(event)?.delete(id);
  };
}

export async function once<T>(event: string, callback: EventCallback<T>): Promise<UnlistenFn> {
  const id = nextId++;
  const set = handlers(event);
  const wrapped = ((e: Event<T>) => {
    set.delete(id);
    callback(e);
  }) as EventCallback<never>;
  set.set(id, wrapped);
  return () => {
    set.delete(id);
  };
}

export async function emit<T>(event: string, payload?: T): Promise<void> {
  const id = nextId++;
  for (const callback of [...(listeners.get(event)?.values() ?? [])]) {
    callback({ event, id, payload: payload as T });
  }
}
