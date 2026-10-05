/**
 * Health banners for the Dashboard. In-memory, one banner per id:
 * `set` adds or replaces, `dismiss` hides until the next `set` of that id, `clear` removes, `list` is newest first.
 */

export type HealthLevel = "info" | "warn";

export interface HealthItem {
  id: string;
  level: HealthLevel;
  text: string;
  at: string; // ISO
}

interface Slot extends HealthItem {
  seq: number; // set order, breaks ties between equal `at`s
  dismissed: boolean;
}

/** Set when an overlay's Auto Quality steps down, cleared when it reports stable again. */
export const OVERLAY_QUALITY_HEALTH_ID = "overlay-quality";
export const overlaySteppedDownText = (level: number): string => `Overlay stepped down to Level ${level} — Auto Quality is managing it`;

/** Chatter Dancers: set when the broadcaster token lacks `user:read:chat` (boot) or Twitch refuses the chat subscription; cleared once chat is heard. */
export const CHAT_HEALTH_ID = "chat-unheard";
export const CHAT_UNHEARD_TEXT = "Connect the broadcaster account again to hear chat: click the broadcaster link on the Config page";

export class Health {
  readonly #slots = new Map<string, Slot>();
  readonly #now: () => Date;
  #seq = 0;

  constructor(opts: { now?: () => Date } = {}) {
    this.#now = opts.now ?? (() => new Date());
  }

  /** Add or replace the banner with this id; a replaced banner is visible again even if it had been dismissed. */
  set(id: string, level: HealthLevel, text: string): void {
    this.#slots.set(id, { id, level, text, at: this.#now().toISOString(), seq: ++this.#seq, dismissed: false });
  }

  clear(id: string): void {
    this.#slots.delete(id);
  }

  /** Hide the banner until the next `set` of the same id. Unknown ids are ignored. */
  dismiss(id: string): void {
    const slot = this.#slots.get(id);
    if (slot) slot.dismissed = true;
  }

  /** Visible banners, sorted by `at` descending (newest first). */
  list(): HealthItem[] {
    return [...this.#slots.values()]
      .filter((s) => !s.dismissed)
      .sort((a, b) => (a.at === b.at ? b.seq - a.seq : a.at < b.at ? 1 : -1))
      .map(({ id, level, text, at }) => ({ id, level, text, at }));
  }
}
