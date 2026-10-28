/*
 * Interactive Calendar Card for Home Assistant
 *
 * Self-contained: no helpers, scripts or browser_mod needed. Events are
 * created, edited and deleted through Home Assistant's calendar websocket
 * commands, and the popup is the card's own dialog.
 */
const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
const { html, css } = LitElement.prototype;

// Placeholder the old script wrote into every event; treated as "no info"
const PLACEHOLDER_DESC = "Created via Home Assistant Dashboard";
// A number means pixels; strings (e.g. "8rem", "90%") are used as-is
const cssSize = (v) => (typeof v === "number" ? `${v}px` : String(v));
// CalendarEntityFeature.UPDATE_EVENT (Google doesn't support it, local calendars do)
const FEATURE_CREATE = 1;
const FEATURE_DELETE = 2;
const FEATURE_UPDATE = 4;
// Used when a calendar in the config has no color set
const DEFAULT_PALETTE = ["#0a84ff", "#ff9f0a", "#ff375f", "#30d158", "#bf5af2", "#64d2ff", "#ffd60a"];

// ---- On-screen keyboard layout ------------------------------------------------
const KB_NUMBERS = "1234567890".split("");
const KB_LETTERS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"].map((r) => r.split(""));
const KB_SYMBOLS = [
  "@#$%&*-+=/".split(""),
  "()[]{}<>^~".split(""),
  ["\\", "!", "?", ":", ";", "'", "\"", "_"],
];

// ---- Date helpers -----------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
// Date -> "YYYY-MM-DD" (for <input type="date">)
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Date -> "YYYY-MM-DDTHH:MM" (for <input type="datetime-local">)
const toDateTimeInput = (d) => `${toDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
// "YYYY-MM-DD" -> local midnight
const parseDateInput = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
// Date -> "YYYY-MM-DDTHH:MM:SS+HH:MM" so HA knows the exact moment
const toIsoWithOffset = (d) => {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${toDateTimeInput(d)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

class InteractiveCalendarCard extends LitElement {
  static get properties() {
    return {
      hass: {},
      config: {},
      currentDate: {},
      events: {},
      _hidden: {},
      _syncing: {},
      _dialog: {},
      _kb: {},
    };
  }

  constructor() {
    super();
    this.currentDate = new Date();
    this.events = [];
    this._calendars = [];
    this._hidden = new Set();
    this._syncing = false;
    this._dialog = null;   // { mode: "view" | "edit" | "create", ev, form, error, busy, confirmDelete }
    this._lastFetch = 0;
    this._lastSync = 0;
    this._fetchToken = 0;
    this._kb = null;       // null (hidden) or { shift: "off" | "once" | "lock", symbols: bool }
    this._kbEl = null;     // the input/textarea the keyboard is typing into
    this._kbLastShift = 0;
  }

  // ---- Visual editor hooks ----------------------------------------------------
  static getConfigElement() {
    return document.createElement("interactive-calendar-card-editor");
  }

  static getStubConfig(hass) {
    const cal = Object.keys((hass && hass.states) || {}).find((id) => id.startsWith("calendar."));
    return { entities: [cal || "calendar.my_calendar"] };
  }

  /*
   * entities can be a single id, a list of ids, or a list of objects:
   *   - entity: calendar.me          (required)
   *     name: Me                     (optional, defaults to the entity's friendly name)
   *     color: "#0a84ff"             (optional, any CSS color)
   *     style: solid | soft | outline
   *     primary: true                (the calendar new events go to; defaults to the first one)
   */
  setConfig(config) {
    if (!config.entities || config.entities.length === 0) {
      throw new Error("Please define your calendar entities!");
    }
    const list = Array.isArray(config.entities) ? config.entities : [config.entities];
    const calendars = list.map((c, i) => {
      const o = typeof c === "string" ? { entity: c } : c;
      if (!o || !o.entity) throw new Error(`Calendar #${i + 1} is missing "entity"`);
      return {
        entity: o.entity,
        name: o.name || null,
        color: o.color || DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
        style: o.style || null,
        primary: o.primary === true,
      };
    });
    let primaryIdx = calendars.findIndex((c) => c.primary);
    if (primaryIdx === -1) primaryIdx = 0;
    calendars.forEach((c, i) => {
      c.primary = i === primaryIdx;
      if (!c.style) c.style = c.primary ? "solid" : "soft";
    });

    const firstDay = String(config.first_day || "sunday").toLowerCase();
    if (!["sunday", "monday"].includes(firstDay)) {
      throw new Error('first_day must be "sunday" or "monday"');
    }
    const timeFormat = String(config.time_format || "12h").toLowerCase();
    if (!["12h", "24h"].includes(timeFormat)) {
      throw new Error('time_format must be "12h" or "24h"');
    }
    const defaultStart = String(config.default_start_time || "09:00");
    if (!/^\d{1,2}:\d{2}$/.test(defaultStart)) {
      throw new Error('default_start_time must look like "09:00"');
    }

    // Optional photo screensaver (see the Family Hub section at the bottom of this file)
    this._ssCfg = config.screensaver || null;

    // on_screen_keyboard: always (default) | touch (touchscreens only) | off
    const kbRaw = config.on_screen_keyboard;
    const keyboard = kbRaw === false || kbRaw === "off" ? "off" : kbRaw === "touch" ? "touch" : "always";

    this._opts = {
      title: config.title || "",
      keyboard,
      firstDay: firstDay === "monday" ? 1 : 0,
      hour12: timeFormat === "12h",
      showLegend: config.show_legend ?? calendars.length > 1,
      showSyncButton: config.show_sync_button !== false,
      autoSyncMs: Math.max(0, Number(config.auto_sync_minutes ?? 5)) * 60 * 1000,
      defaultStart: defaultStart.padStart(5, "0"),
      defaultDuration: Math.max(5, Number(config.default_duration ?? 60)),
      // Events whose title matches one of these (case-insensitive) are not shown
      hideTitles: new Set((config.hide_titles || []).map((t) => String(t).trim().toLowerCase())),
    };

    // Layout and text options become CSS variables on the card
    const vars = {
      "--icc-max-width": config.max_width,
      "--icc-day-height": config.day_height,
      "--icc-header-font-size": config.header_font_size,
      "--icc-event-font-size": config.event_font_size,
      "--icc-day-number-size": config.day_number_font_size,
      "--icc-event-radius": config.event_radius,
      "--icc-today-color": config.today_color,
      "--icc-card-padding": config.card_padding,
      "--icc-gap": config.day_gap,
    };
    fhApplyPopupVars(this, config);
    this._cardStyle = Object.entries(vars)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => (k === "--icc-today-color" ? `${k}:${v}` : `${k}:${cssSize(v)}`))
      .join(";");

    this.config = config;
    this._calendars = calendars;

    try {
      this._hidden = new Set(JSON.parse(localStorage.getItem(this._storageKey) || "[]"));
    } catch (e) {
      this._hidden = new Set();
    }
    this._lastFetch = 0;
  }

  getCardSize() {
    return 10;
  }

  get _primary() {
    return this._calendars.find((c) => c.primary);
  }

  get _entityId() {
    return this._primary.entity;
  }

  // What each calendar allows, from the entity's supported_features
  // (read-only calendars such as holidays or birthdays support none of these)
  _features(cal) {
    return (this.hass && this.hass.states[cal.entity] && this.hass.states[cal.entity].attributes.supported_features) || 0;
  }

  _canCreate(cal) { return !!(this._features(cal) & FEATURE_CREATE); }

  _canDelete(cal) { return !!(this._features(cal) & FEATURE_DELETE); }

  // Edit works in place, or (Google) as create + delete
  _canEdit(cal) {
    const f = this._features(cal);
    return !!(f & FEATURE_UPDATE) || (!!(f & FEATURE_CREATE) && !!(f & FEATURE_DELETE));
  }

  // Calendars a new event can go to, primary first
  get _writableCalendars() {
    return this._calendars
      .filter((c) => this._canCreate(c))
      .sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));
  }

  get _storageKey() {
    return `interactive-calendar-card-hidden:${this._calendars.map((c) => c.entity).join(",")}`;
  }

  _calName(cal) {
    return cal.name || this.hass?.states[cal.entity]?.attributes?.friendly_name || cal.entity;
  }

  // ---- Loading & syncing ------------------------------------------------------

  updated(changedProperties) {
    this._syncDialogOpen();
    const kbEl = this.renderRoot.querySelector(".kb[popover]");
    if (kbEl && typeof kbEl.showPopover === "function" && !kbEl.matches(":popover-open")) {
      try { kbEl.showPopover(); } catch (e) { /* already open */ }
    }
    if (!this.hass) return;
    if (this._ssCfg) FamilyScreensaver.configure(this._ssCfg, this.hass);

    if (this._opts.autoSyncMs && Date.now() - this._lastSync > this._opts.autoSyncMs) {
      // Pull fresh data from Google into HA, then redraw
      this.syncNow(true);
    } else if (changedProperties.has("currentDate")) {
      this.fetchCalendarEvents();
    } else if (changedProperties.has("hass") && Date.now() - this._lastFetch > 60000) {
      // hass changes on every state change in HA; only re-read HA's copy once a minute
      this.fetchCalendarEvents();
    }
  }

  // The card reads Home Assistant's local copy of the calendars. That copy only
  // refreshes from Google every ~15 minutes on its own, so this forces it.
  async syncNow(silent = false) {
    if (this._syncing) return;
    this._syncing = true;
    this._lastSync = Date.now();
    try {
      await this.hass.callService("homeassistant", "update_entity", {
        entity_id: this._calendars.map((c) => c.entity),
      });
      // Give the integration a moment to finish talking to Google
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error("Calendar sync failed:", err);
      if (!silent) this._toast(`Sync with Google failed: ${err.message || err}`);
    }
    await this.fetchCalendarEvents();
    this._syncing = false;
  }

  // "2026-09-07" (all-day) must be read as local midnight. new Date("2026-09-07")
  // reads it as UTC midnight, which puts all-day events on the previous day
  // anywhere west of UTC.
  _parseDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? parseDateInput(s) : new Date(s);
  }

  async fetchCalendarEvents() {
    if (!this.hass || !this._calendars.length) return;
    this._lastFetch = Date.now();
    const token = ++this._fetchToken;

    const startOfMonth = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth(), 1).toISOString();
    const endOfMonth = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const results = await Promise.allSettled(
      this._calendars.map((cal) =>
        this.hass
          .callApi("GET", `calendars/${cal.entity}?start=${startOfMonth}&end=${endOfMonth}`)
          .then((evts) =>
            (evts || []).map((ev) => ({
              ...ev,
              _cal: cal,
              _allDay: !ev.start.dateTime,
              _start: this._parseDate(ev.start.dateTime || ev.start.date),
              _end: this._parseDate(ev.end.dateTime || ev.end.date),
            }))
          )
      )
    );

    // A newer fetch (e.g. after changing month quickly) has started; drop this one
    if (token !== this._fetchToken) return;

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`Error fetching ${this._calendars[i].entity}:`, r.reason);
      }
    });
    this.events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  changeMonth(offset) {
    this.currentDate = new Date(this.currentDate.getFullYear(), this.currentDate.getMonth() + offset, 1);
  }

  _toggleCalendar(entity) {
    const hidden = new Set(this._hidden);
    if (hidden.has(entity)) hidden.delete(entity);
    else hidden.add(entity);
    this._hidden = hidden;
    try {
      localStorage.setItem(this._storageKey, JSON.stringify([...hidden]));
    } catch (e) { /* storage unavailable, toggle just won't persist */ }
  }

  // ---- Opening the dialog -----------------------------------------------------

  handleDayClick(dayNumber, e) {
    if (e.target.closest(".calendar-event-tag")) return;
    const writable = this._writableCalendars;
    if (!writable.length) {
      this._toast("None of these calendars allow adding events");
      return;
    }
    const y = this.currentDate.getFullYear();
    const m = this.currentDate.getMonth();
    const [hh, mm] = this._opts.defaultStart.split(":").map(Number);
    const start = new Date(y, m, dayNumber, hh, mm);
    const end = new Date(start.getTime() + this._opts.defaultDuration * 60000);
    this._dialog = {
      mode: "create",
      ev: null,
      calEntity: writable[0].entity,
      form: {
        summary: "",
        allDay: false,
        start: toDateTimeInput(start),
        end: toDateTimeInput(end),
        startDate: toDateInput(start),
        endDate: toDateInput(start),
        description: "",
        location: "",
      },
      error: "",
      busy: false,
      confirmDelete: false,
    };
  }

  handleEventClick(ev, e) {
    e.stopPropagation();
    this._dialog = { mode: "view", ev, form: null, error: "", busy: false, confirmDelete: false };
  }

  _startEdit() {
    this._kbClose();
    const ev = this._dialog.ev;
    const desc = this._plainText(ev.description);
    // Google's all-day end date is the day *after* the last day; the form shows the last day
    const lastDay = ev._allDay
      ? new Date(ev._end.getFullYear(), ev._end.getMonth(), ev._end.getDate() - 1)
      : ev._end;
    const startDate = toDateInput(ev._start);
    this._dialog = {
      ...this._dialog,
      mode: "edit",
      error: "",
      confirmDelete: false,
      form: {
        summary: ev.summary || "",
        allDay: ev._allDay,
        start: ev._allDay ? `${startDate}T09:00` : toDateTimeInput(ev._start),
        end: ev._allDay ? `${startDate}T10:00` : toDateTimeInput(ev._end),
        startDate,
        endDate: toDateInput(lastDay < ev._start ? ev._start : lastDay),
        description: desc === PLACEHOLDER_DESC ? "" : desc,
        location: ev.location || "",
      },
    };
  }

  _backToView() {
    this._kbClose();
    this._dialog = { ...this._dialog, mode: "view", form: null, error: "", confirmDelete: false };
  }

  _closeDialog() {
    this._kbClose();
    this._dialog = null;
  }

  // Keep the native <dialog> open/closed in step with this._dialog
  _syncDialogOpen() {
    const dlg = this.renderRoot && this.renderRoot.querySelector("dialog");
    if (!dlg) return;
    if (this._dialog && !dlg.open) dlg.showModal();
    else if (!this._dialog && dlg.open) dlg.close();
  }

  // ---- Form handling ----------------------------------------------------------

  _setField(name, value) {
    const f = { ...this._dialog.form, [name]: value };
    // Moving the start past the end drags the end along
    if (name === "start" && !f.allDay) {
      const s = new Date(f.start);
      const e = new Date(f.end);
      if (!isNaN(s) && (isNaN(e) || e <= s)) f.end = toDateTimeInput(new Date(s.getTime() + 3600000));
    }
    if (name === "startDate" && f.endDate < f.startDate) f.endDate = f.startDate;
    this._dialog = { ...this._dialog, form: f, error: "" };
  }

  _setAllDay(on) {
    const f = { ...this._dialog.form, allDay: on };
    if (on) {
      f.startDate = f.start.slice(0, 10) || f.startDate;
      f.endDate = f.end.slice(0, 10) || f.endDate;
    } else {
      f.start = `${f.startDate}T${f.start.slice(11, 16) || "09:00"}`;
      f.end = `${f.endDate}T${f.end.slice(11, 16) || "10:00"}`;
    }
    this._dialog = { ...this._dialog, form: f, error: "" };
  }

  // Turns the form into the event object HA's calendar websocket expects
  _buildEvent(form) {
    const summary = form.summary.trim();
    if (!summary) throw new Error("Please enter a title.");

    let dtstart;
    let dtend;
    if (form.allDay) {
      if (!form.startDate || !form.endDate) throw new Error("Please pick a start and end date.");
      const s = parseDateInput(form.startDate);
      const last = parseDateInput(form.endDate);
      if (last < s) throw new Error("The end date is before the start date.");
      dtstart = form.startDate;
      dtend = toDateInput(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
    } else {
      const s = new Date(form.start);
      const e = new Date(form.end);
      if (isNaN(s) || isNaN(e)) throw new Error("Please pick a start and end time.");
      if (e <= s) throw new Error("The end has to be after the start.");
      dtstart = toIsoWithOffset(s);
      dtend = toIsoWithOffset(e);
    }

    const event = { summary, dtstart, dtend };
    const description = form.description.trim();
    const location = form.location.trim();
    if (description) event.description = description;
    if (location) event.location = location;
    return event;
  }

  async _save() {
    const d = this._dialog;
    let event;
    try {
      event = this._buildEvent(d.form);
    } catch (err) {
      this._dialog = { ...d, error: err.message };
      return;
    }

    this._dialog = { ...d, busy: true, error: "" };
    const ev = d.ev;
    try {
      if (!ev) {
        await this.hass.callWS({ type: "calendar/event/create", entity_id: d.calEntity, event });
      } else {
        const entity = ev._cal.entity;
        const features = this.hass.states[entity]?.attributes?.supported_features || 0;
        if (features & FEATURE_UPDATE) {
          const msg = {
            type: "calendar/event/update",
            entity_id: entity,
            uid: ev.uid,
            event: { description: "", location: "", ...event },
          };
          if (ev.recurrence_id) msg.recurrence_id = ev.recurrence_id;
          await this.hass.callWS(msg);
        } else {
          // Google can't update in place: create the new version, then remove the old one
          await this.hass.callWS({ type: "calendar/event/create", entity_id: entity, event });
          await this._deleteEvent(ev);
        }
      }
    } catch (err) {
      console.error("Saving event failed:", err);
      if (this._dialog) {
        this._dialog = { ...this._dialog, busy: false, error: `Could not save: ${err.message || err.code || err}` };
      }
      return;
    }

    this._closeDialog();
    this._toast(ev ? "Event updated" : "Event added");
    setTimeout(() => this.syncNow(true), 800);
  }

  async _delete() {
    const d = this._dialog;
    // First tap arms the button, second tap deletes
    if (!d.confirmDelete) {
      this._dialog = { ...d, confirmDelete: true };
      return;
    }
    this._dialog = { ...d, busy: true, error: "" };
    try {
      await this._deleteEvent(d.ev);
    } catch (err) {
      console.error("Deleting event failed:", err);
      if (this._dialog) {
        this._dialog = { ...this._dialog, busy: false, confirmDelete: false, error: `Could not delete: ${err.message || err.code || err}` };
      }
      return;
    }
    this._closeDialog();
    this._toast("Event deleted");
    setTimeout(() => this.syncNow(true), 800);
  }

  // HA has no delete action; deletion is a websocket command that needs the uid
  async _deleteEvent(ev) {
    if (!ev.uid) throw new Error("Event has no uid, cannot delete");
    const msg = { type: "calendar/event/delete", entity_id: ev._cal.entity, uid: ev.uid };
    // For recurring events this deletes just the clicked occurrence
    if (ev.recurrence_id) msg.recurrence_id = ev.recurrence_id;
    await this.hass.callWS(msg);
  }

  _toast(message) {
    this.dispatchEvent(new CustomEvent("hass-notification", {
      detail: { message },
      bubbles: true,
      composed: true,
    }));
  }

  // ---- Formatting -------------------------------------------------------------

  _formatWhen(ev) {
    const dateOpts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
    const timeOpts = { hour: "numeric", minute: "2-digit", hour12: this._opts.hour12 };
    const s = ev._start;
    const e = ev._end;
    const d = (x) => x.toLocaleDateString([], dateOpts);
    const t = (x) => x.toLocaleTimeString([], timeOpts);

    if (ev._allDay) {
      const lastDay = new Date(e.getFullYear(), e.getMonth(), e.getDate() - 1);
      return lastDay <= s ? `${d(s)}, all day` : `${d(s)} – ${d(lastDay)}, all day`;
    }
    if (s.toDateString() === e.toDateString()) return `${d(s)}, ${t(s)} – ${t(e)}`;
    return `${d(s)} ${t(s)} – ${d(e)} ${t(e)}`;
  }

  // Google descriptions can contain HTML; show them as plain text
  _plainText(text) {
    if (!text) return "";
    const withBreaks = String(text).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
    const doc = new DOMParser().parseFromString(withBreaks, "text/html");
    return (doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Pick black or white text so solid badges stay readable on any hex color
  _textColorFor(color) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((color || "").trim());
    if (!m) return "#ffffff";
    let hex = m[1];
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.62 ? "#1c1c1e" : "#ffffff";
  }

  // ---- On-screen keyboard -----------------------------------------------------
  // It is rendered inside the <dialog>: a modal dialog makes everything outside
  // it inert, so a keyboard living elsewhere on the page could not be tapped.

  get _kbEnabled() {
    const mode = this._opts.keyboard;
    return (
      mode === "always" ||
      (mode === "touch" && !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._kbBsStop();
  }

  _kbClose() {
    this._kbBsStop();
    this._kb = null;
    this._kbEl = null;
  }

  // Focus moving into a text field opens the keyboard. Date pickers and the
  // checkbox close it. Buttons leave it alone so a tap on Save is never lost to
  // a layout shift.
  _onDialogFocusIn(e) {
    if (!this._kbEnabled || !this._dialog || this._dialog.mode === "view") return;
    const el = e.target;
    if (!el || !el.matches) return;
    if (el.closest(".kb")) return;
    if (el.matches("[data-kb]")) {
      const prev = this._kb || { symbols: false, shift: "off" };
      this._kbEl = el;
      this._kb = { ...prev, shift: prev.shift === "lock" ? "lock" : this._kbAutoShift(el) };
      this.updateComplete.then(() => requestAnimationFrame(() => {
        if (el.isConnected) el.scrollIntoView({ block: "nearest" });
      }));
    } else if (el.matches("input, select")) {
      this._kbClose();
    }
  }

  // Capitalise at the start of the field and after . ! ? or a new line
  _kbAutoShift(el) {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    return before === "" || /[.!?]\s$/.test(before) || /\n$/.test(before) ? "once" : "off";
  }

  _kbAfterEdit(el) {
    if (this._kb && this._kb.shift !== "lock") {
      this._kb = { ...this._kb, shift: this._kbAutoShift(el) };
    }
  }

  _kbType(text) {
    const el = this._kbEl;
    if (!el || !el.isConnected) return;
    if (this.renderRoot.activeElement !== el) el.focus({ preventScroll: true });
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.setRangeText(text, start, end, "end");
    // Reuse the inputs' own @input handlers so the form state stays in sync
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this._kbAfterEdit(el);
  }

  _kbBackspace() {
    const el = this._kbEl;
    if (!el || !el.isConnected) return;
    if (this.renderRoot.activeElement !== el) el.focus({ preventScroll: true });
    let start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    if (start === end) {
      if (start === 0) return;
      const code = el.value.charCodeAt(start - 1);
      start -= code >= 0xdc00 && code <= 0xdfff && start > 1 ? 2 : 1; // emoji / surrogate pairs
    }
    el.setRangeText("", start, end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    this._kbAfterEdit(el);
  }

  // Hold backspace to keep deleting
  _kbBsDown(e) {
    e.preventDefault();
    this._kbBsStop();
    this._kbBackspace();
    this._kbBsTimer = setTimeout(() => {
      this._kbBsInt = setInterval(() => this._kbBackspace(), 55);
    }, 380);
  }

  _kbBsStop() {
    clearTimeout(this._kbBsTimer);
    clearInterval(this._kbBsInt);
  }

  // One tap = capitalise the next letter, double tap = caps lock
  _kbShift() {
    const now = Date.now();
    const dbl = now - this._kbLastShift < 350;
    this._kbLastShift = now;
    const cur = this._kb.shift;
    const next = cur === "lock" ? "off" : dbl ? "lock" : cur === "off" ? "once" : "off";
    this._kb = { ...this._kb, shift: next };
  }

  _kbEnter() {
    const el = this._kbEl;
    if (el && el.tagName === "TEXTAREA") {
      this._kbType("\n");
    } else {
      if (el) el.blur();
      this._kbClose();
    }
  }

  _renderKeyboard() {
    const kb = this._kb;
    const upper = kb.shift !== "off";
    const isArea = !!this._kbEl && this._kbEl.tagName === "TEXTAREA";
    const letters = kb.symbols ? KB_SYMBOLS : KB_LETTERS;

    const key = (label, onClick, cls = "") => html`
      <button type="button" tabindex="-1" class="kb-key ${cls}" @click="${onClick}">${label}</button>`;
    const ch = (c) => {
      const out = upper ? c.toUpperCase() : c;
      return key(out, () => this._kbType(out));
    };

    return html`
      <div class="kb" popover="manual" @mousedown="${(e) => e.preventDefault()}">
        <div class="kb-row">${KB_NUMBERS.map(ch)}</div>
        <div class="kb-row">${letters[0].map(ch)}</div>
        <div class="kb-row kb-inset">${letters[1].map(ch)}</div>
        <div class="kb-row">
          ${kb.symbols ? "" : key(kb.shift === "lock" ? "⇪" : "⇧", () => this._kbShift(), `kb-wide ${upper ? "kb-on" : ""}`)}
          ${letters[2].map(ch)}
          <button type="button" tabindex="-1" class="kb-key kb-wide" aria-label="Backspace"
                  @pointerdown="${(e) => this._kbBsDown(e)}"
                  @pointerup="${() => this._kbBsStop()}"
                  @pointerleave="${() => this._kbBsStop()}"
                  @pointercancel="${() => this._kbBsStop()}">⌫</button>
        </div>
        <div class="kb-row">
          ${key(kb.symbols ? "ABC" : "?123", () => { this._kb = { ...this._kb, symbols: !kb.symbols }; }, "kb-wide")}
          ${key("⌄", () => this._kbHide())}
          ${ch(",")}
          ${key("space", () => this._kbType(" "), "kb-space")}
          ${ch(".")}
          ${key(isArea ? "↵" : "Done", () => this._kbEnter(), "kb-wide kb-accent")}
        </div>
      </div>
    `;
  }

  // Hide button: close the keyboard but keep the dialog
  _kbHide() {
    const el = this._kbEl;
    if (el) el.blur();
    this._kbClose();
  }

  // ---- Rendering: dialog ------------------------------------------------------

  _renderDialog() {
    const d = this._dialog;
    const formMode = !!d && d.mode !== "view";
    const kbMode = formMode && this._kbEnabled;   // dialog sits at the top so the keyboard fits below it
    const kbOpen = kbMode && !!this._kb;
    return html`
      <dialog class="event-dialog ${kbMode ? "kb-mode" : ""} ${kbOpen ? "kb-open" : ""}"
              @focusin="${(e) => this._onDialogFocusIn(e)}"
              @close="${() => { this._dialog = null; this._kbClose(); }}"
              @cancel="${(e) => { if (this._dialog && this._dialog.busy) e.preventDefault(); }}"
              @click="${(e) => { if (e.target === e.currentTarget && !(this._dialog && this._dialog.busy)) this._closeDialog(); }}">
        ${d ? html`<div class="dialog-body">${d.mode === "view" ? this._renderView(d) : this._renderForm(d)}</div>` : ""}
        ${kbOpen ? this._renderKeyboard() : ""}
      </dialog>
    `;
  }

  _renderView(d) {
    const ev = d.ev;
    const cal = ev._cal;
    const desc = this._plainText(ev.description);
    const showDesc = desc && desc !== PLACEHOLDER_DESC;
    const mapsUrl = ev.location
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}`
      : "";

    return html`
      <div class="dialog-title">
        <span class="title-bar" style="background:${cal.color}"></span>
        <span class="title-text">${ev.summary || "(No title)"}</span>
      </div>

      <div class="info-row">
        <ha-icon icon="mdi:clock-outline"></ha-icon>
        <span>${this._formatWhen(ev)}</span>
      </div>
      <div class="info-row">
        <ha-icon icon="mdi:calendar-blank-outline"></ha-icon>
        <span>${this._calName(cal)}</span>
      </div>
      ${ev.location ? html`
        <div class="info-row">
          <ha-icon icon="mdi:map-marker-outline"></ha-icon>
          <a href="${mapsUrl}" target="_blank" rel="noopener noreferrer">${ev.location}</a>
        </div>` : ""}
      ${ev.rrule || ev.recurrence_id ? html`
        <div class="info-row">
          <ha-icon icon="mdi:repeat"></ha-icon>
          <span>Part of a recurring series</span>
        </div>` : ""}
      ${showDesc ? html`<div class="info-desc">${desc}</div>` : ""}

      ${d.error ? html`<div class="dialog-error">${d.error}</div>` : ""}

      <div class="dialog-footer">
        ${this._canDelete(cal) ? html`
          <button class="btn danger ${d.confirmDelete ? "confirm" : ""}"
                  ?disabled="${d.busy}"
                  @click="${() => this._delete()}">
            ${d.busy ? "Deleting…" : d.confirmDelete ? "Tap again to delete" : "Delete"}
          </button>` : ""}
        <span class="spacer"></span>
        <button class="btn" ?disabled="${d.busy}" @click="${() => this._closeDialog()}">Close</button>
        ${this._canEdit(cal) ? html`
          <button class="btn primary" ?disabled="${d.busy}" @click="${() => this._startEdit()}">Edit</button>` : ""}
      </div>
    `;
  }

  _renderForm(d) {
    const f = d.form;
    const writable = this._writableCalendars;
    const target = d.mode === "edit"
      ? d.ev._cal
      : this._calendars.find((c) => c.entity === d.calEntity) || this._primary;
    return html`
      <div class="dialog-title">
        <span class="title-bar" style="background:${target.color}"></span>
        <span class="title-text">${d.mode === "edit" ? "Edit event" : "New event"}</span>
      </div>

      ${d.mode === "create" && writable.length > 1 ? html`
        <label class="field">
          <span>Calendar</span>
          <select @change="${(e) => { this._dialog = { ...this._dialog, calEntity: e.target.value }; }}">
            ${writable.map((c) => html`
              <option value="${c.entity}" ?selected="${c.entity === d.calEntity}">${this._calName(c)}</option>`)}
          </select>
        </label>` : ""}

      <label class="field">
        <span>Title</span>
        <input type="text" placeholder="Event title" autofocus data-kb autocomplete="off"
               inputmode="${this._kbEnabled ? "none" : "text"}"
               .value="${f.summary}"
               @input="${(e) => this._setField("summary", e.target.value)}"
               @keydown="${(e) => { if (e.key === "Enter") this._save(); }}">
      </label>

      <label class="check">
        <input type="checkbox" .checked="${f.allDay}" @change="${(e) => this._setAllDay(e.target.checked)}">
        All day
      </label>

      <div class="field-row">
        ${f.allDay ? html`
          <label class="field">
            <span>Start date</span>
            <input type="date" .value="${f.startDate}" @input="${(e) => this._setField("startDate", e.target.value)}">
          </label>
          <label class="field">
            <span>End date</span>
            <input type="date" .value="${f.endDate}" @input="${(e) => this._setField("endDate", e.target.value)}">
          </label>
        ` : html`
          <label class="field">
            <span>Starts</span>
            <input type="datetime-local" .value="${f.start}" @input="${(e) => this._setField("start", e.target.value)}">
          </label>
          <label class="field">
            <span>Ends</span>
            <input type="datetime-local" .value="${f.end}" @input="${(e) => this._setField("end", e.target.value)}">
          </label>
        `}
      </div>

      <label class="field">
        <span>Address</span>
        <input type="text" placeholder="Optional" .value="${f.location}" data-kb autocomplete="off"
               inputmode="${this._kbEnabled ? "none" : "text"}"
               @input="${(e) => this._setField("location", e.target.value)}">
      </label>

      <label class="field">
        <span>Info</span>
        <textarea rows="3" placeholder="Optional" .value="${f.description}" data-kb
                  inputmode="${this._kbEnabled ? "none" : "text"}"
                  @input="${(e) => this._setField("description", e.target.value)}"></textarea>
      </label>

      ${d.error ? html`<div class="dialog-error">${d.error}</div>` : ""}

      <div class="dialog-footer">
        <span class="spacer"></span>
        <button class="btn" ?disabled="${d.busy}"
                @click="${() => (d.mode === "edit" ? this._backToView() : this._closeDialog())}">Cancel</button>
        <button class="btn primary" ?disabled="${d.busy}" @click="${() => this._save()}">
          ${d.busy ? "Saving…" : "Save"}
        </button>
      </div>
    `;
  }

  // ---- Rendering: calendar ----------------------------------------------------

  _renderLegend() {
    if (!this._opts.showLegend) return "";
    return html`
      <div class="legend">
        ${this._calendars.map((cal) => {
          const off = this._hidden.has(cal.entity);
          return html`
            <button class="legend-item ${off ? "off" : ""}"
                    title="${off ? "Show" : "Hide"} ${this._calName(cal)}"
                    @click="${() => this._toggleCalendar(cal.entity)}">
              <span class="legend-dot" style="background:${cal.color}"></span>
              ${this._calName(cal)}
            </button>
          `;
        })}
      </div>
    `;
  }

  _renderTag(ev, dayStart, dayEnd) {
    const cal = ev._cal;
    let timeString = "";
    // Only show the time on the day the event starts
    if (!ev._allDay && ev._start >= dayStart && ev._start < dayEnd) {
      timeString = ev._start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: this._opts.hour12 });
    }
    const tagStyle = `--tag-color:${cal.color};--tag-text:${this._textColorFor(cal.color)}`;
    return html`
      <div class="calendar-event-tag style-${cal.style}"
           style="${tagStyle}"
           title="${ev.summary || "(No title)"} (${this._calName(cal)})"
           @click="${(e) => this.handleEventClick(ev, e)}">
        <div class="event-summary"><span>${ev.summary || "(No title)"}</span></div>
        ${timeString ? html`<div class="event-time">${timeString}</div>` : ""}
      </div>
    `;
  }

  render() {
    const year = this.currentDate.getFullYear();
    const month = this.currentDate.getMonth();
    const monthName = this.currentDate.toLocaleString("default", { month: "long" });
    // How many blank cells before day 1, given the chosen first day of the week
    const firstDayIndex = (new Date(year, month, 1).getDay() - this._opts.firstDay + 7) % 7;
    const totalDays = new Date(year, month + 1, 0).getDate();
    const today = new Date();
    const isCurrentMonth = today.getFullYear() === year && today.getMonth() === month;

    const visibleEvents = this.events
      .filter((ev) => !this._hidden.has(ev._cal.entity))
      .filter((ev) => !this._opts.hideTitles.has((ev.summary || "").trim().toLowerCase()))
      // All-day first (holidays, birthdays), then primary calendar, then by start time
      .sort((a, b) =>
        (b._allDay - a._allDay) ||
        (b._cal.primary - a._cal.primary) ||
        (a._start - b._start)
      );

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const orderedNames = [...dayNames.slice(this._opts.firstDay), ...dayNames.slice(0, this._opts.firstDay)];
    const weekdayLabels = orderedNames.map((d) => html`<div class="weekday-header">${d}</div>`);
    const blankCells = [];
    for (let i = 0; i < firstDayIndex; i++) {
      blankCells.push(html`<div class="day-cell blank"></div>`);
    }

    const dayCells = [];
    for (let day = 1; day <= totalDays; day++) {
      const dayStart = new Date(year, month, day);
      const dayEnd = new Date(year, month, day + 1);

      // An event shows on every day it overlaps (multi-day holidays, trips...).
      // All-day end dates from Google are exclusive, so this works for them too.
      const dayEvents = visibleEvents.filter((ev) =>
        ev._end > ev._start
          ? ev._start < dayEnd && ev._end > dayStart
          : ev._start >= dayStart && ev._start < dayEnd
      );

      const isToday = isCurrentMonth && today.getDate() === day;
      dayCells.push(html`
        <div class="day-cell ${isToday ? "today-highlight" : ""}" @click="${(e) => this.handleDayClick(day, e)}">
          <span class="day-number ${isToday ? "today-number" : ""}">${day}</span>
          <div class="events-container">${dayEvents.map((ev) => this._renderTag(ev, dayStart, dayEnd))}</div>
        </div>
      `);
    }

    return html`
      <ha-card style="${this._cardStyle}">
        ${this._opts.title ? html`<div class="card-title">${this._opts.title}</div>` : ""}
        <div class="calendar-header-nav">
          <div class="calendar-title-text">${monthName} ${year}</div>
          <div class="nav-button-group">
            ${this._opts.showSyncButton ? html`
              <button class="nav-btn sync-btn ${this._syncing ? "spinning" : ""}"
                      title="Sync with Google Calendar"
                      ?disabled="${this._syncing}"
                      @click="${() => this.syncNow()}">⟳</button>` : ""}
            <button class="nav-btn" @click="${() => this.changeMonth(-1)}">◀</button>
            <button class="nav-btn" @click="${() => this.changeMonth(1)}">▶</button>
          </div>
        </div>
        ${this._renderLegend()}
        <div class="weekdays-grid">${weekdayLabels}</div>
        <div class="days-grid">${blankCells}${dayCells}</div>
      </ha-card>
      ${this._renderDialog()}
    `;
  }

  static get styles() {
    return css`
      ha-card { 
        padding: var(--icc-card-padding, 24px); width: 100%; box-sizing: border-box;
        max-width: var(--icc-max-width, none); margin: 0 auto;
        background-color: var(--ha-card-background, var(--card-background-color, #1c1c1e));
        border-radius: var(--ha-card-border-radius, 12px);
        border: 1px solid var(--ha-card-border-color, var(--divider-color, #2c2c2e));
      }
      .calendar-header-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
      .card-title { font-size: 0.85rem; font-weight: 600; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
      .calendar-title-text { font-size: var(--icc-header-font-size, 1.5rem); font-weight: 600; color: var(--primary-text-color, #ffffff); letter-spacing: -0.5px; }
      .nav-button-group { display: flex; gap: 6px; }
      .nav-btn { 
        background-color: var(--secondary-background-color, #2c2c2e); border: 1px solid var(--divider-color, #3a3a3c); 
        color: var(--primary-text-color, #ffffff); font-size: 0.9rem; padding: 8px 14px; border-radius: 8px; cursor: pointer; 
      }
      .nav-btn:hover { background-color: var(--divider-color, #3a3a3c); }
      .sync-btn { font-size: 1rem; line-height: 1; }
      .sync-btn:disabled { cursor: default; opacity: 0.7; }
      .sync-btn.spinning { animation: icc-spin 1s linear infinite; }
      @keyframes icc-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .sync-btn.spinning { animation: none; } }

      .legend { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
      .legend-item {
        display: inline-flex; align-items: center; gap: 6px;
        background: none; border: 1px solid var(--divider-color, #3a3a3c); border-radius: 999px;
        color: var(--primary-text-color); font: inherit; font-size: 0.8rem; padding: 4px 10px; cursor: pointer;
      }
      .legend-item:hover { background-color: var(--secondary-background-color); }
      .legend-item.off { opacity: 0.45; }
      .legend-item.off .legend-dot { background: transparent !important; box-shadow: inset 0 0 0 1.5px var(--secondary-text-color); }
      .legend-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }

      .weekdays-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: var(--icc-gap, 10px); margin-bottom: 12px; border-bottom: 1px solid var(--divider-color, #2c2c2e); padding-bottom: 8px; }
      .weekday-header { font-weight: 600; color: var(--secondary-text-color); font-size: 0.85rem; text-align: center; text-transform: uppercase; }
      .days-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: var(--icc-gap, 10px); width: 100%; }
      .day-cell { 
        min-height: var(--icc-day-height, 105px); padding: 10px; border: 1px solid var(--ha-card-border-color, var(--divider-color, #2c2c2e)); 
        background-color: rgba(var(--rgb-primary-background-color), 0.3); border-radius: 8px; cursor: pointer; 
        display: flex; flex-direction: column; justify-content: flex-start; align-items: stretch; overflow: hidden; 
      }
      .day-cell:hover { background-color: var(--secondary-background-color); }
      .today-highlight { border: 2px solid var(--icc-today-color, var(--accent-color)) !important; background-color: rgba(var(--rgb-primary-color), 0.06) !important; }
      .blank { border: 1px solid transparent; background: none; cursor: default; }
      .blank:hover { background: none; }
      .day-number { font-weight: 500; font-size: var(--icc-day-number-size, 1rem); margin-bottom: 8px; text-align: left; color: var(--primary-text-color); }
      .today-number { color: var(--icc-today-color, var(--accent-color)); font-weight: 700; }
      .events-container { display: flex; flex-direction: column; gap: 3px; width: 100%; overflow: hidden; }

      /* Badges: --tag-color / --tag-text are set per calendar */
      .calendar-event-tag { 
        background-color: var(--tag-color, var(--accent-color)); color: var(--tag-text, var(--text-primary-color)); 
        font-size: var(--icc-event-font-size, 0.66rem); padding: 3px 6px; border-radius: var(--icc-event-radius, 5px); display: flex; flex-direction: column; gap: 1px;
        line-height: 1.2; box-sizing: border-box; max-width: 100%; overflow: hidden; 
      }
      .calendar-event-tag.style-soft {
        background-color: color-mix(in srgb, var(--tag-color) 22%, transparent);
        color: var(--primary-text-color);
        border-left: 3px solid var(--tag-color);
        padding-left: 4px;
      }
      .calendar-event-tag.style-outline {
        background-color: transparent;
        color: var(--primary-text-color);
        border: 1px solid var(--tag-color);
      }
      .calendar-event-tag { cursor: pointer; }
      .calendar-event-tag:hover { filter: brightness(1.12); }

      .event-summary { display: flex; align-items: center; width: 100%; font-weight: 600; min-width: 0; }
      .event-summary span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .event-time { font-weight: 500; font-size: 0.9em; opacity: 0.88; white-space: nowrap; }

      /* ---- Event dialog ---- */
      .event-dialog {
        border: none; padding: 0; border-radius: 16px;
        width: min(460px, calc(100vw - 32px)); max-height: calc(100vh - 48px);
        background: var(--icc-popup-bg, var(--ha-card-background, var(--card-background-color, #1c1c1e)));
        -webkit-backdrop-filter: var(--icc-popup-filter, none); backdrop-filter: var(--icc-popup-filter, none);
        color: var(--primary-text-color);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      }
      .event-dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
      .dialog-body { padding: 20px; display: flex; flex-direction: column; gap: 12px; }
      .dialog-title { display: flex; align-items: stretch; gap: 10px; font-size: 1.15rem; font-weight: 600; line-height: 1.3; }
      .title-bar { width: 4px; border-radius: 2px; flex: none; }
      .title-text { overflow-wrap: anywhere; }

      .info-row { display: flex; align-items: flex-start; gap: 10px; font-size: 0.9rem; line-height: 1.4; }
      .info-row ha-icon { --mdc-icon-size: 18px; color: var(--secondary-text-color); flex: none; margin-top: 1px; }
      .info-row a { color: var(--primary-color); overflow-wrap: anywhere; }
      .info-desc {
        white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.85rem; line-height: 1.45;
        color: var(--secondary-text-color); background: var(--secondary-background-color);
        border-radius: 8px; padding: 10px 12px; max-height: 30vh; overflow: auto;
      }

      .field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; font-size: 0.8rem; color: var(--secondary-text-color); }
      .field input, .field textarea, .field select {
        font: inherit; font-size: 16px; /* 16px stops iOS zooming in on focus */
        color: var(--primary-text-color); background: var(--secondary-background-color);
        border: 1px solid var(--divider-color, #3a3a3c); border-radius: 8px;
        padding: 8px 10px; width: 100%; box-sizing: border-box; color-scheme: light dark;
      }
      .field textarea { resize: vertical; min-height: 64px; }
      .field input:focus, .field textarea:focus, .field select:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
      .field-row { display: flex; flex-wrap: wrap; gap: 10px; }
      .field-row .field { min-width: 180px; }
      .check { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer; }
      .check input { width: 16px; height: 16px; margin: 0; accent-color: var(--primary-color); }

      .dialog-error { color: var(--error-color, #ff453a); font-size: 0.85rem; }
      .dialog-footer { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
      .spacer { flex: 1; }
      .btn {
        font: inherit; font-size: 0.8rem; font-weight: 600; padding: 6px 12px; border-radius: 8px; cursor: pointer;
        border: 1px solid var(--divider-color, #3a3a3c); background: none; color: var(--primary-text-color);
      }
      .btn:hover { background: var(--secondary-background-color); }
      .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      .btn.primary:hover { filter: brightness(1.1); }
      .btn.danger { color: var(--error-color, #ff453a); border-color: transparent; padding-left: 4px; }
      .btn.danger.confirm { background: var(--error-color, #ff453a); color: #fff; padding-left: 12px; }
      .btn:disabled { opacity: 0.6; cursor: default; }

      /* ---- On-screen keyboard ---- */
      .event-dialog {
        overflow-y: auto;
        --kb-key: clamp(34px, 6.8vh, 46px);
        --kb-h: calc(5 * (var(--kb-key) + 6px) + 18px + env(safe-area-inset-bottom, 0px));
      }
      /* Top-aligned whenever the keyboard is enabled, so nothing jumps when it opens */
      .event-dialog.kb-mode { margin: 12px auto auto; }
      .event-dialog.kb-open {
        max-height: calc(100vh - var(--kb-h) - 24px);
        max-height: calc(100dvh - var(--kb-h) - 24px);
      }
      .kb {
        position: fixed; top: auto; left: 0; right: 0; bottom: 0; margin: 0 auto; z-index: 1;
        height: auto; overflow: visible; border: 0;
        width: min(100vw, 760px); box-sizing: border-box;
        padding: 6px 6px calc(8px + env(safe-area-inset-bottom, 0px));
        display: flex; flex-direction: column; gap: 6px;
        background: var(--icc-popup-bg, var(--secondary-background-color, #2c2c2e));
        -webkit-backdrop-filter: var(--icc-popup-filter, none); backdrop-filter: var(--icc-popup-filter, none);
        border-top: 1px solid var(--divider-color, #3a3a3c);
        border-radius: 14px 14px 0 0;
        box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.35);
        user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation;
      }
      .kb[popover]:not(:popover-open) { display: none; }
      .kb-row { display: flex; gap: 5px; justify-content: center; }
      .kb-inset { padding: 0 4.5%; }
      .kb-key {
        flex: 1 1 0; min-width: 0; height: var(--kb-key); padding: 0;
        font: inherit; font-size: 1.05rem; font-weight: 500; cursor: pointer;
        color: var(--primary-text-color); background: var(--card-background-color, #1c1c1e);
        border: 1px solid var(--divider-color, #3a3a3c); border-radius: 8px;
        -webkit-tap-highlight-color: transparent;
      }
      .kb-key:active { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      .kb-wide { flex: 1.5 1 0; font-size: 0.85rem; font-weight: 600; }
      .kb-space { flex: 5 1 0; font-size: 0.85rem; color: var(--secondary-text-color); }
      .kb-on { background: color-mix(in srgb, var(--primary-color) 35%, var(--card-background-color, #1c1c1e)); border-color: var(--primary-color); }
      .kb-accent { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
    `;
  }
}

customElements.define("interactive-calendar-card", InteractiveCalendarCard);

// =============================================================================
// Visual editor
// =============================================================================
const EDITOR_LABELS = {
  entity: "Calendar",
  name: "Display name",
  color: "Color (any CSS color)",
  style: "Event style",
  title: "Card title",
  first_day: "First day of the week",
  time_format: "Time format",
  default_start_time: "Default start time",
  default_duration: "Default event length",
  auto_sync_minutes: "Auto-sync every (0 = off)",
  on_screen_keyboard: "On-screen keyboard",
  show_legend: "Show legend",
  show_sync_button: "Show sync button",
  hide_titles: "Hide events with these titles",
  max_width: "Max card width",
  day_height: "Day cell min height",
  header_font_size: "Month title size",
  event_font_size: "Event text size",
  day_number_font_size: "Day number size",
  event_radius: "Event corner radius",
  card_padding: "Card padding",
  day_gap: "Gap between days",
  today_color: "Today highlight color",
  popup_opacity: "Popup opacity",
  popup_color: "Popup color (solid, any CSS color)",
  popup_blur: "Popup background blur",
};

const EDITOR_HELPERS = {
  hide_titles: "Type a title and press Enter. Matching is not case-sensitive.",
  max_width: "A number means pixels. Units work too, e.g. 8rem or 90%.",
  day_height: "A number means pixels. Units work too, e.g. 8rem.",
  on_screen_keyboard: "Shown when you tap a text box in the event popup.",
  popup_opacity: "100 = fully solid. Lower it to let the dashboard show through.",
  popup_color: "Optional. Pick a solid color if your theme makes popups see-through.",
  popup_blur: "Frosted-glass effect behind popups. 0 = off.",
};

// Layout values that may be a plain number (pixels) or a CSS size string
const EDITOR_SIZE_KEYS = [
  "max_width", "day_height", "header_font_size", "event_font_size",
  "day_number_font_size", "event_radius", "card_padding", "day_gap",
];

const POPUP_FIELDS = [
  { name: "popup_opacity", selector: { number: { min: 0, max: 100, mode: "box", unit_of_measurement: "%" } } },
  { name: "popup_color", selector: { text: {} } },
  { name: "popup_blur", selector: { number: { min: 0, max: 50, mode: "box", unit_of_measurement: "px" } } },
];

const EDITOR_SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    type: "grid", name: "", schema: [
      { name: "first_day", selector: { select: { mode: "dropdown", options: [
        { value: "sunday", label: "Sunday" }, { value: "monday", label: "Monday" },
      ] } } },
      { name: "time_format", selector: { select: { mode: "dropdown", options: [
        { value: "12h", label: "12-hour" }, { value: "24h", label: "24-hour" },
      ] } } },
    ],
  },
  {
    type: "grid", name: "", schema: [
      { name: "default_start_time", selector: { time: {} } },
      { name: "default_duration", selector: { number: { min: 5, max: 1440, mode: "box", unit_of_measurement: "min" } } },
    ],
  },
  { name: "auto_sync_minutes", selector: { number: { min: 0, max: 1440, mode: "box", unit_of_measurement: "min" } } },
  { name: "on_screen_keyboard", selector: { select: { mode: "dropdown", options: [
    { value: "always", label: "Always" },
    { value: "touch", label: "Touchscreens only" },
    { value: "off", label: "Off" },
  ] } } },
  {
    type: "grid", name: "", schema: [
      { name: "show_legend", selector: { boolean: {} } },
      { name: "show_sync_button", selector: { boolean: {} } },
    ],
  },
  { name: "hide_titles", selector: { text: { multiple: true } } },
  { type: "expandable", name: "", title: "Popups (for transparent themes)", schema: POPUP_FIELDS },
  {
    type: "expandable", name: "", title: "Layout and text", schema: [
      {
        type: "grid", name: "", schema: [
          { name: "max_width", selector: { text: {} } },
          { name: "day_height", selector: { text: {} } },
          { name: "header_font_size", selector: { text: {} } },
          { name: "event_font_size", selector: { text: {} } },
          { name: "day_number_font_size", selector: { text: {} } },
          { name: "event_radius", selector: { text: {} } },
          { name: "card_padding", selector: { text: {} } },
          { name: "day_gap", selector: { text: {} } },
        ],
      },
      { name: "today_color", selector: { text: {} } },
    ],
  },
];

const CAL_SCHEMA = [
  { name: "entity", required: true, selector: { entity: { domain: "calendar" } } },
  {
    type: "grid", name: "", schema: [
      { name: "name", selector: { text: {} } },
      { name: "color", selector: { text: {} } },
    ],
  },
  { name: "style", selector: { select: { mode: "dropdown", options: [
    { value: "solid", label: "Solid" },
    { value: "soft", label: "Soft" },
    { value: "outline", label: "Outline" },
  ] } } },
];

// Keys whose value differs between two objects (ha-form returns the whole form
// every time, but only the keys the user actually changed should be saved)
const editorDiff = (next, prev) => {
  const out = {};
  new Set([...Object.keys(next), ...Object.keys(prev)]).forEach((k) => {
    if (JSON.stringify(next[k]) !== JSON.stringify(prev[k])) out[k] = next[k];
  });
  return out;
};

const editorIsEmpty = (v) =>
  v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

class InteractiveCalendarCardEditor extends LitElement {
  static get properties() {
    return { hass: {}, _config: {} };
  }

  setConfig(config) {
    this._config = config;
  }

  _fire(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  // ---- Calendars ---------------------------------------------------------------

  // Always work on copies, as objects, whatever shape the YAML used
  _cals() {
    const e = this._config.entities;
    const list = Array.isArray(e) ? e : e ? [e] : [];
    return list.map((c) => (typeof c === "string" ? { entity: c } : { ...c }));
  }

  _primaryIdx(cals) {
    const i = cals.findIndex((c) => c.primary === true);
    return i === -1 ? 0 : i;
  }

  _calData(cals, i) {
    const cal = cals[i];
    return {
      entity: cal.entity,
      name: cal.name,
      color: cal.color,
      style: cal.style || (i === this._primaryIdx(cals) ? "solid" : "soft"),
    };
  }

  _saveCals(cals) {
    const entities = cals.map((c) => {
      const o = { ...c };
      Object.keys(o).forEach((k) => {
        if (editorIsEmpty(o[k]) || o[k] === false) delete o[k];
      });
      // Keep the YAML tidy: a calendar with only an entity is just the id
      return Object.keys(o).length === 1 && o.entity ? o.entity : o;
    });
    this._fire({ ...this._config, entities });
  }

  _calChanged(i, e) {
    e.stopPropagation();
    const cals = this._cals();
    const changes = editorDiff(e.detail.value || {}, this._calData(cals, i));
    for (const [k, v] of Object.entries(changes)) {
      if (k === "entity" && !v) continue;   // never leave a calendar without an entity
      if (editorIsEmpty(v)) delete cals[i][k];
      else cals[i][k] = v;
    }
    this._saveCals(cals);
  }

  _setColor(i, value) {
    const cals = this._cals();
    cals[i].color = value;
    this._saveCals(cals);
  }

  _makePrimary(i) {
    const cals = this._cals();
    cals.forEach((c) => delete c.primary);
    if (i !== 0) cals[i].primary = true;
    this._saveCals(cals);
  }

  _removeCal(i) {
    const cals = this._cals();
    if (cals.length < 2) return;
    const wasPrimary = this._primaryIdx(cals) === i;
    cals.splice(i, 1);
    if (wasPrimary) cals.forEach((c) => delete c.primary);
    this._saveCals(cals);
  }

  _addCal(e) {
    e.stopPropagation();
    const entity = e.detail.value && e.detail.value.entity;
    if (!entity) return;
    const cals = this._cals();
    cals.push({ entity });
    this._saveCals(cals);
  }

  // ---- Global options -------------------------------------------------------------

  _globalData() {
    const c = this._config;
    const kb = c.on_screen_keyboard;
    const d = {
      title: c.title,
      first_day: c.first_day ?? "sunday",
      time_format: c.time_format ?? "12h",
      default_start_time: `${String(c.default_start_time ?? "09:00").padStart(5, "0")}:00`,
      default_duration: c.default_duration ?? 60,
      auto_sync_minutes: c.auto_sync_minutes ?? 5,
      on_screen_keyboard: kb === false || kb === "off" ? "off" : kb === "touch" ? "touch" : "always",
      show_legend: c.show_legend ?? this._cals().length > 1,
      show_sync_button: c.show_sync_button !== false,
      hide_titles: c.hide_titles || [],
      today_color: c.today_color,
      popup_opacity: c.popup_opacity,
      popup_color: c.popup_color,
      popup_blur: c.popup_blur,
    };
    EDITOR_SIZE_KEYS.forEach((k) => {
      if (c[k] !== undefined && c[k] !== null) d[k] = String(c[k]);
    });
    return d;
  }

  _globalChanged(e) {
    e.stopPropagation();
    const changes = editorDiff(e.detail.value || {}, this._globalData());
    const cfg = { ...this._config };
    for (const [k, v] of Object.entries(changes)) {
      let val = v;
      if (k === "default_start_time" && typeof val === "string") val = val.slice(0, 5);
      // "105" must be saved as the number 105, or the card would treat it as a CSS string without units
      if (EDITOR_SIZE_KEYS.includes(k) && typeof val === "string" && /^\d+(\.\d+)?$/.test(val.trim())) {
        val = Number(val);
      }
      if (editorIsEmpty(val)) delete cfg[k];
      else cfg[k] = val;
    }
    this._fire(cfg);
  }

  // ---- Rendering -------------------------------------------------------------------

  _renderCal(cals, i) {
    const cal = cals[i];
    const isPrimary = this._primaryIdx(cals) === i;
    const swatch = /^#[0-9a-f]{6}$/i.test(cal.color || "")
      ? cal.color
      : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length];
    return html`
      <div class="cal">
        <div class="cal-head">
          <input type="color" title="Pick a color" .value="${swatch}"
                 @change="${(e) => this._setColor(i, e.target.value)}">
          <span class="cal-title">Calendar ${i + 1}</span>
          ${isPrimary
            ? html`<span class="chip" title="New events are added to this calendar">Primary</span>`
            : html`<button class="link" @click="${() => this._makePrimary(i)}">Make primary</button>`}
          <span class="spacer"></span>
          <button class="icon-btn" title="Remove calendar" ?disabled="${cals.length < 2}"
                  @click="${() => this._removeCal(i)}">
            <ha-icon icon="mdi:delete-outline"></ha-icon>
          </button>
        </div>
        <ha-form
          .hass="${this.hass}"
          .data="${this._calData(cals, i)}"
          .schema="${CAL_SCHEMA}"
          .computeLabel="${(s) => EDITOR_LABELS[s.name] || s.name}"
          @value-changed="${(e) => this._calChanged(i, e)}"></ha-form>
      </div>
    `;
  }

  render() {
    if (!this.hass || !this._config) return html``;
    const cals = this._cals();
    const used = cals.map((c) => c.entity).filter(Boolean);
    const addSchema = [{ name: "entity", selector: { entity: { domain: "calendar", exclude_entities: used } } }];
    return html`
      <div class="section-title">Calendars</div>
      ${cals.map((_, i) => this._renderCal(cals, i))}
      <ha-form
        .hass="${this.hass}"
        .data="${{}}"
        .schema="${addSchema}"
        .computeLabel="${() => "Add another calendar"}"
        @value-changed="${(e) => this._addCal(e)}"></ha-form>

      <div class="section-title">Options</div>
      <ha-form
        .hass="${this.hass}"
        .data="${this._globalData()}"
        .schema="${EDITOR_SCHEMA}"
        .computeLabel="${(s) => EDITOR_LABELS[s.name] || s.title || s.name}"
        .computeHelper="${(s) => EDITOR_HELPERS[s.name]}"
        @value-changed="${(e) => this._globalChanged(e)}"></ha-form>
    `;
  }

  static get styles() {
    return css`
      :host { display: block; }
      .section-title { font-weight: 600; margin: 16px 0 8px; color: var(--primary-text-color); }
      .section-title:first-child { margin-top: 0; }
      .cal {
        border: 1px solid var(--divider-color); border-radius: 10px;
        padding: 10px 12px 6px; margin-bottom: 12px;
      }
      .cal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .cal-title { font-weight: 500; color: var(--primary-text-color); }
      .spacer { flex: 1; }
      .chip {
        font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 999px;
        color: var(--text-primary-color, #fff); background: var(--primary-color);
      }
      .link {
        background: none; border: none; padding: 0; cursor: pointer;
        font: inherit; font-size: 0.85rem; color: var(--primary-color);
      }
      .icon-btn {
        background: none; border: none; cursor: pointer; padding: 4px; border-radius: 50%;
        color: var(--secondary-text-color); display: inline-flex;
      }
      .icon-btn:hover:not(:disabled) { color: var(--error-color, #db4437); }
      .icon-btn:disabled { opacity: 0.35; cursor: default; }
      input[type="color"] {
        width: 30px; height: 26px; padding: 0; cursor: pointer;
        border: 1px solid var(--divider-color); border-radius: 6px; background: none;
      }
    `;
  }
}

customElements.define("interactive-calendar-card-editor", InteractiveCalendarCardEditor);

// Lets the card show up in the "Add card" picker
window.customCards = window.customCards || [];
window.customCards.push({
  type: "interactive-calendar-card",
  name: "Interactive Calendar Card",
  description: "Month calendar with add, edit and delete, multiple calendars and an on-screen keyboard.",
});

// =============================================================================
// FAMILY HUB
//   family-hub-card         chores + stars, meal planner, shared lists
//   family-screensaver-card optional stand-alone photo screensaver
//
// Everything is stored in Home Assistant itself, so every device sees the same
// data and nothing else has to be installed:
//   - Lists (groceries, packing...) are ordinary to-do entities.
//   - People, chores, stars, meal plan and recipes are saved as small JSON
//     records inside ONE Local To-do list (the `store`). Records are items whose
//     title starts with "fh:". Don't edit or delete those items by hand.
// =============================================================================

const FH_PALETTE = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff", "#ffd60a"];
const FH_DAYS = [
  ["mon", "Mon", "Monday"], ["tue", "Tue", "Tuesday"], ["wed", "Wed", "Wednesday"], ["thu", "Thu", "Thursday"],
  ["fri", "Fri", "Friday"], ["sat", "Sat", "Saturday"], ["sun", "Sun", "Sunday"],
];
const FH_MEALS = [["breakfast", "Breakfast", "🍳"], ["lunch", "Lunch", "🥪"], ["dinner", "Dinner", "🍽️"]];
const FH_PEOPLE_EMOJI = ["🦊", "🐼", "🦁", "🐯", "🐸", "🦄", "🐙", "🚀", "⭐", "🎮", "⚽", "🎨"];
const FH_REWARD_EMOJI = ["🍦", "🎬", "🎮", "🎁", "🍕", "🛍️", "🎢", "📱"];
const FH_DEFAULT_RECIPES = {
  "Pancakes": ["Pancake mix", "Eggs", "Milk", "Maple syrup"],
  "Oatmeal": ["Oats", "Milk", "Brown sugar"],
  "Sandwiches": ["Bread", "Deli meat", "Cheese", "Lettuce"],
  "Tacos": ["Taco shells", "Ground beef", "Taco seasoning", "Shredded cheese", "Salsa", "Lettuce"],
  "Spaghetti": ["Spaghetti", "Pasta sauce", "Ground beef", "Parmesan"],
  "Chicken & rice": ["Chicken", "Rice", "Broccoli"],
  "Pizza night": ["Pizza dough", "Pizza sauce", "Mozzarella", "Pepperoni"],
  "Leftovers": [],
};

const fhPad = (n) => String(n).padStart(2, "0");
const fhYmd = (d) => `${d.getFullYear()}-${fhPad(d.getMonth() + 1)}-${fhPad(d.getDate())}`;
const fhMonday = (d) => {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};
const fhId = () => Math.random().toString(36).slice(2, 8);
const fhClone = (v) => JSON.parse(JSON.stringify(v));
const fhKbSupported = () => typeof HTMLElement.prototype.showPopover === "function";

// Popup look, shared by every popup in this file (event dialog, Family Hub sheets,
// both keyboards). With none of the options set nothing changes.
//   popup_opacity: 0-100   how solid the popup background is (100 = fully solid)
//   popup_color:   any CSS color; use a solid one if the theme's popups are see-through
//   popup_blur:    px of frosted-glass blur behind the popup
function fhApplyPopupVars(el, cfg) {
  const op = cfg.popup_opacity;
  const hasOp = op !== undefined && op !== null && op !== "" && Number.isFinite(Number(op));
  if (cfg.popup_color || hasOp) {
    const base = cfg.popup_color
      || "var(--ha-dialog-surface-background, var(--mdc-theme-surface, var(--card-background-color, #1c1c1e)))";
    const pct = hasOp ? Math.min(100, Math.max(0, Number(op))) : 100;
    el.style.setProperty("--icc-popup-bg", pct >= 100 ? base : `color-mix(in srgb, ${base} ${pct}%, transparent)`);
  } else {
    el.style.removeProperty("--icc-popup-bg");
  }
  const blur = Number(cfg.popup_blur);
  if (blur > 0) el.style.setProperty("--icc-popup-filter", `blur(${blur}px)`);
  else el.style.removeProperty("--icc-popup-filter");
}

async function fhTodoItems(hass, entity) {
  const res = await hass.callWS({ type: "todo/item/list", entity_id: entity });
  return (res && res.items) || [];
}

// -----------------------------------------------------------------------------
// On-screen keyboard (one shared instance, shown as a top-layer popover so it
// stays tappable above everything and never blocks the page)
// -----------------------------------------------------------------------------
class FamilyHubKeyboard extends LitElement {
  static get properties() {
    return { _shift: {}, _sym: {}, _area: {} };
  }

  constructor() {
    super();
    this._shift = "off";
    this._sym = false;
    this._area = false;
    this._el = null;
    this._lastShift = 0;
  }

  connectedCallback() {
    super.connectedCallback();
    this.setAttribute("popover", "manual");
    this._noBlur = (e) => e.preventDefault();   // keep focus (and the caret) in the text box
    this.addEventListener("mousedown", this._noBlur);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("mousedown", this._noBlur);
    this._bsStop();
  }

  get isOpen() {
    return this.matches(":popover-open");
  }

  show(el) {
    this._el = el;
    this._area = el.tagName === "TEXTAREA";
    this._shift = this._auto(el);
    if (!this.isOpen) this.showPopover();
  }

  hide() {
    this._bsStop();
    this._el = null;
    if (this.isOpen) this.hidePopover();
    window.dispatchEvent(new CustomEvent("fh-kb-hidden"));
  }

  _auto(el) {
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    return before === "" || /[.!?]\s$/.test(before) || /\n$/.test(before) ? "once" : "off";
  }

  _fire(el) {
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    if (this._shift !== "lock") this._shift = this._auto(el);
  }

  _type(text) {
    const el = this._el;
    if (!el || !el.isConnected) return;
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    el.setRangeText(text, s, e, "end");
    this._fire(el);
  }

  _backspace() {
    const el = this._el;
    if (!el || !el.isConnected) return;
    let s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? s;
    if (s === e) {
      if (s === 0) return;
      const c = el.value.charCodeAt(s - 1);
      s -= c >= 0xdc00 && c <= 0xdfff && s > 1 ? 2 : 1;
    }
    el.setRangeText("", s, e, "end");
    this._fire(el);
  }

  _bsDown(e) {
    e.preventDefault();
    this._bsStop();
    this._backspace();
    this._bsTimer = setTimeout(() => { this._bsInt = setInterval(() => this._backspace(), 55); }, 380);
  }

  _bsStop() {
    clearTimeout(this._bsTimer);
    clearInterval(this._bsInt);
  }

  _toggleShift() {
    const now = Date.now();
    const dbl = now - this._lastShift < 350;
    this._lastShift = now;
    this._shift = this._shift === "lock" ? "off" : dbl ? "lock" : this._shift === "off" ? "once" : "off";
  }

  // Enter: textareas get a new line. Otherwise the text box's own Enter handler
  // runs (e.g. "add item"); if it doesn't claim the key, the keyboard closes.
  _enter() {
    const el = this._el;
    if (!el) return;
    if (el.tagName === "TEXTAREA") return this._type("\n");
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true });
    el.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      el.blur();
      this.hide();
    }
  }

  render() {
    const upper = this._shift !== "off";
    const rows = this._sym ? KB_SYMBOLS : KB_LETTERS;
    const key = (label, fn, cls = "") =>
      html`<button type="button" tabindex="-1" class="k ${cls}" @click="${fn}">${label}</button>`;
    const ch = (c) => {
      const out = upper ? c.toUpperCase() : c;
      return key(out, () => this._type(out));
    };
    return html`
      <div class="r">${KB_NUMBERS.map(ch)}</div>
      <div class="r">${rows[0].map(ch)}</div>
      <div class="r inset">${rows[1].map(ch)}</div>
      <div class="r">
        ${this._sym ? "" : key(this._shift === "lock" ? "⇪" : "⇧", () => this._toggleShift(), `w ${upper ? "on" : ""}`)}
        ${rows[2].map(ch)}
        <button type="button" tabindex="-1" class="k w" aria-label="Backspace"
                @pointerdown="${(e) => this._bsDown(e)}" @pointerup="${() => this._bsStop()}"
                @pointerleave="${() => this._bsStop()}" @pointercancel="${() => this._bsStop()}">⌫</button>
      </div>
      <div class="r">
        ${key(this._sym ? "ABC" : "?123", () => { this._sym = !this._sym; }, "w")}
        ${key("⌄", () => { if (this._el) this._el.blur(); this.hide(); })}
        ${ch(",")}
        ${key("space", () => this._type(" "), "space")}
        ${ch(".")}
        ${key(this._area ? "↵" : "Done", () => this._enter(), "w accent")}
      </div>`;
  }

  static get styles() {
    return css`
      :host {
        inset: auto 0 0 0; margin: 0 auto; width: min(100vw, 760px); height: auto; overflow: visible;
        box-sizing: border-box; border: 0; padding: 6px 6px calc(8px + env(safe-area-inset-bottom, 0px));
        flex-direction: column; gap: 6px;
        background: var(--icc-popup-bg, var(--secondary-background-color, #2c2c2e)); color: var(--primary-text-color, #fff);
        -webkit-backdrop-filter: var(--icc-popup-filter, none); backdrop-filter: var(--icc-popup-filter, none);
        border-radius: 14px 14px 0 0; box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.35);
        user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation;
        --key: clamp(34px, 6.8vh, 46px);
      }
      :host(:popover-open) { display: flex; }
      .r { display: flex; gap: 5px; justify-content: center; }
      .inset { padding: 0 4.5%; }
      .k {
        flex: 1 1 0; min-width: 0; height: var(--key); padding: 0; font: inherit; font-size: 1.05rem; font-weight: 500;
        cursor: pointer; color: var(--primary-text-color); background: var(--card-background-color, #1c1c1e);
        border: 1px solid var(--divider-color, #3a3a3c); border-radius: 8px; -webkit-tap-highlight-color: transparent;
      }
      .k:active { background: var(--primary-color); border-color: var(--primary-color); color: #fff; }
      .w { flex: 1.5 1 0; font-size: 0.85rem; font-weight: 600; }
      .space { flex: 5 1 0; font-size: 0.85rem; color: var(--secondary-text-color); }
      .on { background: color-mix(in srgb, var(--primary-color) 35%, var(--card-background-color, #1c1c1e)); border-color: var(--primary-color); }
      .accent { background: var(--primary-color); border-color: var(--primary-color); color: #fff; }
    `;
  }
}
customElements.define("family-hub-keyboard", FamilyHubKeyboard);

const fhKeyboard = () => {
  let k = document.querySelector("family-hub-keyboard");
  if (!k) {
    k = document.createElement("family-hub-keyboard");
    document.body.appendChild(k);
  }
  return k;
};
const fhKbHide = () => {
  if (!fhKbSupported()) return;
  const k = document.querySelector("family-hub-keyboard");
  if (k) k.hide();
};

// -----------------------------------------------------------------------------
// Photo screensaver (one per page). Starts after `idle_seconds` without a touch,
// any tap closes it.
//   screensaver:
//     folder: media-source://media_source/local/family_photos   # or:
//     urls: [https://..., /local/photo.jpg]
//     idle_seconds: 120        # 0 = off
//     slide_seconds: 30
//     show_clock: true
//     fit: cover               # or contain
//     navigate_path: /lovelace/calendar   # where to go when it closes (optional)
// -----------------------------------------------------------------------------
const FamilyScreensaver = {
  cfg: null,
  hass: null,
  _sig: "",
  _bound: false,
  _timer: null,
  _slides: null,
  _clock: null,
  _el: null,
  _armedAt: 0,

  configure(cfg, hass) {
    this.hass = hass;
    const sig = JSON.stringify(cfg || {});
    if (sig === this._sig) return;
    this._sig = sig;
    this.cfg = cfg && typeof cfg === "object" ? cfg : null;
    this._stop(false);
    if (!this.cfg || this.cfg.idle_seconds === 0) {
      clearTimeout(this._timer);
      return;
    }
    if (!this._bound) {
      this._bound = true;
      ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"].forEach((t) =>
        window.addEventListener(t, () => this._activity(), { passive: true, capture: true }));
    }
    this._arm();
  },

  _activity() {
    if (this._el) return;
    if (Date.now() - this._armedAt < 1000) return;   // pointermove fires constantly
    this._arm();
  },

  _arm() {
    clearTimeout(this._timer);
    this._armedAt = Date.now();
    if (!this.cfg) return;
    const secs = Number(this.cfg.idle_seconds ?? 120);
    if (!(secs > 0)) return;
    this._timer = setTimeout(() => this._start(), secs * 1000);
  },

  async _start() {
    if (this._el || !this.cfg) return;
    const el = document.createElement("div");
    el.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;background:#000;color:#fff;cursor:none;overflow:hidden;font-family:var(--paper-font-body1_-_font-family,system-ui,sans-serif);";
    const fit = this.cfg.fit === "contain" ? "contain" : "cover";
    const layer = () => {
      const d = document.createElement("div");
      d.style.cssText = `position:absolute;inset:0;background:center/${fit} no-repeat;opacity:0;transition:opacity 2s ease;`;
      return d;
    };
    const a = layer();
    const b = layer();
    el.append(a, b);
    if (this.cfg.show_clock !== false) {
      const clock = document.createElement("div");
      clock.style.cssText =
        "position:absolute;left:4vw;bottom:5vh;text-shadow:0 2px 12px rgba(0,0,0,.8);pointer-events:none;";
      el.append(clock);
      this._clock = clock;
      this._tick();
      this._clockTimer = setInterval(() => this._tick(), 15000);
    }
    el.addEventListener("click", () => this._stop(true));
    window.addEventListener("keydown", this._onKey = () => this._stop(true), { once: true });
    document.body.appendChild(el);
    this._el = el;
    this._layers = [a, b];
    this._front = 0;

    let ids = [];
    try {
      ids = await this._collect();
    } catch (e) {
      console.warn("Family Hub screensaver: could not read photos", e);
    }
    if (!this._el) return;
    ids.sort(() => Math.random() - 0.5);
    this._slides = ids;
    this._idx = -1;
    this._next();
    const every = Math.max(5, Number(this.cfg.slide_seconds ?? 30)) * 1000;
    this._slideTimer = setInterval(() => this._next(), every);
  },

  _tick() {
    if (!this._clock) return;
    const now = new Date();
    this._clock.innerHTML =
      `<div style="font-size:9vh;font-weight:300;line-height:1">${now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</div>` +
      `<div style="font-size:3vh;opacity:.9;margin-top:1vh">${now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>`;
  },

  async _collect(id = this.cfg.folder, depth = 0) {
    const out = Array.isArray(this.cfg.urls) ? [...this.cfg.urls] : [];
    if (!id) return out;
    const res = await this.hass.callWS({ type: "media_source/browse_media", media_content_id: id });
    for (const c of res.children || []) {
      if (c.media_class === "image") out.push(c.media_content_id);
      else if (c.can_expand && depth < 2) out.push(...(await this._collect(c.media_content_id, depth + 1)));
    }
    return out;
  },

  async _resolve(id) {
    if (!id.startsWith("media-source://")) return id;
    const r = await this.hass.callWS({ type: "media_source/resolve_media", media_content_id: id, expires: 4 * 3600 });
    return this.hass.hassUrl ? this.hass.hassUrl(r.url) : r.url;
  },

  async _next() {
    if (!this._el || !this._slides || !this._slides.length) return;
    for (let tries = 0; tries < 4; tries++) {
      this._idx = (this._idx + 1) % this._slides.length;
      try {
        const url = await this._resolve(this._slides[this._idx]);
        await new Promise((ok, no) => {
          const img = new Image();
          img.onload = ok;
          img.onerror = no;
          img.src = url;
        });
        if (!this._el) return;
        const back = this._layers[1 - this._front];
        const front = this._layers[this._front];
        back.style.backgroundImage = `url("${url}")`;
        back.style.opacity = "1";
        front.style.opacity = "0";
        this._front = 1 - this._front;
        return;
      } catch (e) { /* try the next photo */ }
    }
  },

  _stop(rearm) {
    clearInterval(this._slideTimer);
    clearInterval(this._clockTimer);
    if (this._onKey) window.removeEventListener("keydown", this._onKey);
    this._onKey = null;
    if (this._el) {
      this._el.remove();
      this._el = null;
      const path = this.cfg && this.cfg.navigate_path;
      if (path && rearm) {
        window.history.pushState(null, "", path);
        window.dispatchEvent(new CustomEvent("location-changed"));
      }
    }
    this._clock = null;
    if (rearm) this._arm();
  },
};

// Stand-alone card: drop it on any view just to switch the screensaver on
class FamilyScreensaverCard extends LitElement {
  static get properties() {
    return { hass: {} };
  }

  setConfig(config) {
    this._cfg = config;
  }

  getCardSize() {
    return 1;
  }

  updated() {
    if (this.hass && this._cfg) FamilyScreensaver.configure(this._cfg, this.hass);
  }

  render() {
    if (!this._cfg) return html``;
    const s = Number(this._cfg.idle_seconds ?? 120);
    return html`<ha-card><div class="n">📷 Photo screensaver ${s > 0 ? `starts after ${s}s idle` : "is off"}</div></ha-card>`;
  }

  static get styles() {
    return css`.n { padding: 10px 14px; font-size: 0.85rem; color: var(--secondary-text-color); }`;
  }
}
customElements.define("family-screensaver-card", FamilyScreensaverCard);

// -----------------------------------------------------------------------------
// The Family Hub card
// -----------------------------------------------------------------------------
class FamilyHubCard extends LitElement {
  static get properties() {
    return {
      hass: {}, _tab: {}, _error: {}, _sheet: {}, _form: {}, _meal: {}, _toastMsg: {},
      _kbOpen: {}, _listEntity: {}, _listItems: {}, _arm: {},
    };
  }

  static getConfigElement() {
    return document.createElement("family-hub-card-editor");
  }

  static getStubConfig(hass) {
    const todos = Object.keys((hass && hass.states) || {}).filter((e) => e.startsWith("todo."));
    return {
      store: todos.find((e) => e.includes("family_hub")) || "todo.family_hub_data",
      shopping_list: todos.find((e) => e.includes("shopping")) || "todo.shopping_list",
    };
  }

  constructor() {
    super();
    this._tab = null;
    this._docs = {};          // key -> { uid, data }, not reactive: render via requestUpdate()
    this._loaded = false;
    this._error = "";
    this._sheet = null;
    this._form = {};
    this._meal = null;
    this._toastMsg = "";
    this._kbOpen = false;
    this._listEntity = "";
    this._listItems = {};
    this._listStates = {};
    this._arm = "";
    this._q = Promise.resolve();
    this._pending = 0;
    this._optimistic = [];    // taps not saved yet, replayed on top of every refresh
  }

  setConfig(config) {
    if (!config.store) {
      throw new Error("Set `store` to a Local To-do list, e.g. store: todo.family_hub_data");
    }
    const tabs = (config.tabs || ["chores", "meals", "lists"]).filter((t) => ["chores", "meals", "lists"].includes(t));
    let lists = (config.lists || []).map((l) => (typeof l === "string" ? { entity: l } : { ...l }));
    if (!lists.length && config.shopping_list) lists = [{ entity: config.shopping_list }];
    lists.forEach((l, i) => { l.color = l.color || FH_PALETTE[i % FH_PALETTE.length]; });
    this._cfg = { ...config, tabs: tabs.length ? tabs : ["chores"], lists };
    fhApplyPopupVars(this, config);
    if (!this._tab || !this._cfg.tabs.includes(this._tab)) {
      this._tab = this._cfg.tabs.includes(config.default_tab) ? config.default_tab : this._cfg.tabs[0];
    }
  }

  getCardSize() {
    return 8;
  }

  connectedCallback() {
    super.connectedCallback();
    this._onKbHidden = () => { this._kbOpen = false; };
    window.addEventListener("fh-kb-hidden", this._onKbHidden);
    this._poller = setInterval(() => this._poll(), 15000);
    this._onVis = () => { if (!document.hidden) this._poll(); };
    document.addEventListener("visibilitychange", this._onVis);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("fh-kb-hidden", this._onKbHidden);
    document.removeEventListener("visibilitychange", this._onVis);
    clearInterval(this._poller);
    fhKbHide();
  }

  updated(changed) {
    if (changed.has("hass") && this.hass && this._cfg) {
      if (this._cfg.screensaver) FamilyScreensaver.configure(this._cfg.screensaver, this.hass);
      if (!this._started) {
        this._started = true;
        this._poll();
      }
      // A list's open-item count changed somewhere else: refresh it
      const l = this._curList;
      if (l && this._tab === "lists") {
        const st = this.hass.states[l.entity] && this.hass.states[l.entity].state;
        if (st !== this._listStates[l.entity]) {
          this._listStates[l.entity] = st;
          this._fetchList(l.entity);
        }
      }
    }
    const pop = this.renderRoot.querySelector(".sheet");
    if (pop && typeof pop.showPopover === "function" && !pop.matches(":popover-open")) {
      try { pop.showPopover(); } catch (e) { /* already open */ }
    }
  }

  // ---- Storage ----------------------------------------------------------------

  async _fetchDocs() {
    const items = await fhTodoItems(this.hass, this._cfg.store);
    const docs = {};
    for (const it of items) {
      if (typeof it.summary !== "string" || !it.summary.startsWith("fh:")) continue;
      const key = it.summary.slice(3);
      if (docs[key]) continue;
      let data = null;
      try { data = it.description ? JSON.parse(it.description) : null; } catch (e) { /* ignore bad JSON */ }
      docs[key] = { uid: it.uid, data };
    }
    return docs;
  }

  async _poll() {
    if (this._pending || !this.hass || !this._cfg) return;
    try {
      this._docs = await this._fetchDocs();
      this._error = "";
      this._loaded = true;
    } catch (e) {
      this._error = `Could not read ${this._cfg.store}. Is it a Local To-do list? (${e.message || e.code || e})`;
    }
    this.requestUpdate();
    const l = this._curList;
    if (l && this._tab === "lists") this._fetchList(l.entity);
  }

  async _saveDoc(key, data) {
    const json = JSON.stringify(data);
    const d = this._docs[key];
    const target = { entity_id: this._cfg.store };
    if (d && d.uid) {
      await this.hass.callService("todo", "update_item", { item: d.uid, description: json }, target);
    } else {
      await this.hass.callService("todo", "add_item", { item: `fh:${key}`, description: json }, target);
      this._docs = await this._fetchDocs();
    }
  }

  _peek(key, def) {
    const d = this._docs[key];
    return d && d.data != null ? d.data : def;
  }

  _ctx() {
    const self = this;
    const work = {};
    return {
      get(key, def) {
        if (!(key in work)) work[key] = fhClone(self._peek(key, def));
        return work[key];
      },
      commit() {
        Object.keys(work).forEach((k) => {
          if (self._docs[k]) self._docs[k].data = work[k];
          else self._docs[k] = { uid: null, data: work[k] };
        });
      },
      async flush() {
        for (const k of Object.keys(work)) await self._saveDoc(k, work[k]);
      },
    };
  }

  // Runs `fn` instantly on the local copy (so taps feel immediate), then again on
  // fresh server data and saves it. Operations run one at a time, and taps that
  // are still waiting to be saved are replayed on top of each refresh so the
  // screen never jumps back.
  async _op(fn) {
    this._pending++;
    this._optimistic.push(fn);
    try {
      const c = this._ctx();
      fn(c);
      c.commit();
      this.requestUpdate();
    } catch (e) { /* the real run below reports errors */ }
    await (this._q = this._q.then(async () => {
      this._docs = await this._fetchDocs();
      const c = this._ctx();
      fn(c);
      c.commit();
      this._reapply(fn);
      await c.flush();
      this._optimistic = this._optimistic.filter((f) => f !== fn);
      this._reapply(null);
    }).catch((e) => {
      console.error("Family Hub:", e);
      this._optimistic = this._optimistic.filter((f) => f !== fn);
      this._notify(`Could not save: ${e.message || e.code || e}`);
    }));
    this._pending--;
    if (!this._pending) await this._poll();
  }

  _reapply(skip) {
    const rc = this._ctx();
    this._optimistic.filter((f) => f !== skip).forEach((f) => {
      try { f(rc); } catch (e) { /* ignore */ }
    });
    rc.commit();
    this.requestUpdate();
  }

  _notify(msg) {
    this._toastMsg = msg;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { this._toastMsg = ""; }, 3500);
  }

  // ---- Chores -----------------------------------------------------------------

  _period(c) {
    const n = new Date();
    return c.freq === "weekly" ? `w${fhYmd(fhMonday(n))}` : fhYmd(n);
  }

  _keyCurrent(k) {
    const p = String(k).split("@")[1];
    const n = new Date();
    return p === fhYmd(n) || p === `w${fhYmd(fhMonday(n))}`;
  }

  _isDone(c) {
    const d = this._peek("done", { keys: [] });
    return d.keys.includes(`${c.id}@${this._period(c)}`);
  }

  _toggleChore(chore) {
    return this._op((ctx) => {
      const done = ctx.get("done", { keys: [] });
      const stars = ctx.get("stars", {});
      const key = `${chore.id}@${this._period(chore)}`;
      const i = done.keys.indexOf(key);
      const pts = Number(chore.stars) || 0;
      if (i < 0) {
        done.keys.push(key);
        stars[chore.who] = (stars[chore.who] || 0) + pts;
      } else {
        done.keys.splice(i, 1);                                    // un-checking takes the stars back,
        stars[chore.who] = Math.max(0, (stars[chore.who] || 0) - pts); // so it can't be used to farm them
      }
      done.keys = done.keys.filter((k) => this._keyCurrent(k));
    });
  }

  _confirm(key, fn) {
    if (this._arm === key) {
      this._arm = "";
      fn();
      return;
    }
    this._arm = key;
    clearTimeout(this._armT);
    this._armT = setTimeout(() => { this._arm = ""; }, 3000);
  }

  _redeem(person, reward) {
    const bal = (this._peek("stars", {})[person.id]) || 0;
    if (bal < reward.cost) {
      this._notify(`${person.name} needs ${reward.cost - bal} more ⭐ for ${reward.name}`);
      return;
    }
    this._confirm(`r${person.id}${reward.id}`, () => {
      this._op((ctx) => {
        const stars = ctx.get("stars", {});
        if ((stars[person.id] || 0) < reward.cost) return;
        stars[person.id] -= reward.cost;
      });
      this._notify(`🎉 ${person.name} spent ${reward.cost} ⭐ on ${reward.name}`);
    });
  }

  _setup(fn) {
    return this._op((ctx) => fn(ctx.get("setup", { people: [], chores: [], rewards: [] })));
  }

  _f(key, val) {
    this._form = { ...this._form, [key]: val };
  }

  _addPerson() {
    const f = this._form;
    const name = (f.pName || "").trim();
    if (!name) return this._notify("Type a name first");
    const idx = this._peek("setup", { people: [] }).people.length;
    this._setup((s) => s.people.push({
      id: fhId(), name, emoji: f.pEmoji || FH_PEOPLE_EMOJI[0], color: f.pColor || FH_PALETTE[idx % FH_PALETTE.length],
    }));
    this._form = { ...f, pName: "" };
  }

  _removePerson(id) {
    this._setup((s) => {
      s.people = s.people.filter((p) => p.id !== id);
      s.chores = s.chores.filter((c) => c.who !== id);
    });
  }

  _addChore() {
    const f = this._form;
    const title = (f.cTitle || "").trim();
    const people = this._peek("setup", { people: [] }).people;
    const who = f.cWho || (people[0] && people[0].id);
    if (!title) return this._notify("Type the chore first");
    if (!who) return this._notify("Add a person first");
    const stars = Math.max(0, parseInt(f.cStars, 10) || 1);
    this._setup((s) => s.chores.push({ id: fhId(), title, who, freq: f.cFreq || "daily", stars }));
    this._form = { ...f, cTitle: "" };
  }

  _addReward() {
    const f = this._form;
    const name = (f.rName || "").trim();
    const cost = parseInt(f.rCost, 10);
    if (!name || !(cost > 0)) return this._notify("Give the reward a name and a star cost");
    this._setup((s) => s.rewards.push({ id: fhId(), name, cost, icon: f.rIcon || FH_REWARD_EMOJI[0] }));
    this._form = { ...f, rName: "", rCost: "" };
  }

  // ---- Meals ------------------------------------------------------------------

  _openMeal(day, meal) {
    const slot = `${day[0]}.${meal[0]}`;
    const name = this._peek("plan", {})[slot] || "";
    const recipes = this._peek("recipes", FH_DEFAULT_RECIPES);
    this._meal = {
      slot, label: `${day[2]} ${meal[1].toLowerCase()}`, name,
      ingredients: (recipes[name] || []).join(", "),
    };
    this._sheet = "meal";
  }

  _pickRecipe(name) {
    const recipes = this._peek("recipes", FH_DEFAULT_RECIPES);
    this._meal = { ...this._meal, name, ingredients: (recipes[name] || []).join(", ") };
  }

  _saveMeal() {
    const m = this._meal;
    const name = m.name.trim();
    const ings = m.ingredients.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    this._op((ctx) => {
      const plan = ctx.get("plan", {});
      if (name) plan[m.slot] = name;
      else delete plan[m.slot];
      if (name) ctx.get("recipes", FH_DEFAULT_RECIPES)[name] = ings;
    });
    this._closeSheet();
  }

  _clearWeek() {
    this._confirm("clearweek", () => this._op((ctx) => {
      const plan = ctx.get("plan", {});
      Object.keys(plan).forEach((k) => delete plan[k]);
    }));
  }

  async _sendGroceries() {
    const shop = this._cfg.shopping_list;
    if (!shop) return this._notify("Set `shopping_list:` in the card settings first");
    try {
      const plan = this._peek("plan", {});
      const recipes = this._peek("recipes", FH_DEFAULT_RECIPES);
      const need = [];
      const seen = new Set();
      Object.values(plan).forEach((meal) => (recipes[meal] || []).forEach((ing) => {
        const k = ing.toLowerCase();
        if (!seen.has(k)) { seen.add(k); need.push(ing); }
      }));
      const have = new Set();
      for (const e of [shop, this._cfg.pantry_list].filter(Boolean)) {
        for (const it of await fhTodoItems(this.hass, e)) {
          if (e === shop && it.status === "completed") continue;   // already bought
          have.add(String(it.summary).toLowerCase());
        }
      }
      const add = need.filter((i) => !have.has(i.toLowerCase()));
      for (const item of add) await this.hass.callService("todo", "add_item", { item }, { entity_id: shop });
      this._notify(add.length
        ? `🛒 Added ${add.length} item${add.length > 1 ? "s" : ""} to the shopping list`
        : "Nothing to add. It's all on the list or in the pantry.");
    } catch (e) {
      this._notify(`Could not update the shopping list: ${e.message || e.code || e}`);
    }
  }

  // ---- Lists ------------------------------------------------------------------

  get _curList() {
    const ls = this._cfg ? this._cfg.lists : [];
    return ls.find((l) => l.entity === this._listEntity) || ls[0];
  }

  _listName(l) {
    const st = this.hass && this.hass.states[l.entity];
    return l.name || (st && st.attributes.friendly_name) || l.entity;
  }

  async _fetchList(entity) {
    try {
      const items = await fhTodoItems(this.hass, entity);
      this._listItems = { ...this._listItems, [entity]: items };
    } catch (e) {
      this._listItems = { ...this._listItems, [entity]: [] };
    }
  }

  _selectList(l) {
    this._listEntity = l.entity;
    this._fetchList(l.entity);
  }

  async _toggleItem(l, it) {
    const status = it.status === "completed" ? "needs_action" : "completed";
    this._listItems = {
      ...this._listItems,
      [l.entity]: (this._listItems[l.entity] || []).map((x) => (x.uid === it.uid ? { ...x, status } : x)),
    };
    try {
      await this.hass.callService("todo", "update_item", { item: it.uid, status }, { entity_id: l.entity });
    } catch (e) { this._notify(`Could not update: ${e.message || e.code || e}`); }
    this._fetchList(l.entity);
  }

  async _removeItems(l, uids) {
    this._listItems = {
      ...this._listItems,
      [l.entity]: (this._listItems[l.entity] || []).filter((x) => !uids.includes(x.uid)),
    };
    try {
      await this.hass.callService("todo", "remove_item", { item: uids }, { entity_id: l.entity });
    } catch (e) { this._notify(`Could not remove: ${e.message || e.code || e}`); }
    this._fetchList(l.entity);
  }

  async _addItem(l) {
    const text = (this._form.newItem || "").trim();
    if (!text) return;
    this._form = { ...this._form, newItem: "" };
    try {
      await this.hass.callService("todo", "add_item", { item: text }, { entity_id: l.entity });
    } catch (e) { this._notify(`Could not add: ${e.message || e.code || e}`); }
    this._fetchList(l.entity);
  }

  // ---- Keyboard / sheets -------------------------------------------------------

  _kbOn() {
    const m = this._cfg.on_screen_keyboard;
    if (!fhKbSupported() || m === false || m === "off") return false;
    if (m === "touch") return !!window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    return true;
  }

  _onFocusIn(e) {
    const el = e.target;
    if (!el || !el.matches || !this._kbOn()) return;
    if (el.matches("[data-kb]")) {
      this._kbOpen = true;
      fhApplyPopupVars(fhKeyboard(), this._cfg);
      fhKeyboard().show(el);
      this.updateComplete.then(() => requestAnimationFrame(() => {
        if (el.isConnected) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }));
    } else if (el.matches("input, select, textarea")) {
      fhKbHide();
    }
  }

  _onFocusOut() {
    setTimeout(() => {
      const a = this.renderRoot.activeElement;
      if (!a || !a.matches || !a.matches("[data-kb]")) fhKbHide();
    }, 80);
  }

  _closeSheet() {
    this._sheet = null;
    this._form = {};
    this._meal = null;
    this._kbOpen = false;
    fhKbHide();
  }

  _in(key, ph, extra = {}) {
    return html`<input class="in" data-kb type="text" autocomplete="off"
                       inputmode="${this._kbOn() ? "none" : (extra.mode || "text")}"
                       placeholder="${ph}" .value="${this._form[key] || ""}"
                       @input="${(e) => this._f(key, e.target.value)}"
                       @keydown="${(e) => { if (e.key === "Enter" && extra.enter) { e.preventDefault(); extra.enter(); } }}">`;
  }

  // ---- Rendering -------------------------------------------------------------------

  render() {
    if (!this._cfg) return html``;
    const labels = { chores: "⭐ Chores", meals: "🍽️ Meals", lists: "📝 Lists" };
    const body = this._error
      ? html`<div class="empty err">${this._error}<br><br>Create a <b>Local To-do</b> list (for example named
          “Family Hub Data”) and set it as <code>store:</code>. This card keeps its settings in it.</div>`
      : !this._loaded
        ? html`<div class="empty">Loading…</div>`
        : this._tab === "chores" ? this._renderChores()
          : this._tab === "meals" ? this._renderMeals() : this._renderLists();
    return html`
      <ha-card @focusin="${(e) => this._onFocusIn(e)}" @focusout="${() => this._onFocusOut()}">
        <div class="top">
          <div class="tabs">
            ${this._cfg.tabs.length > 1 ? this._cfg.tabs.map((t) => html`
              <button class="tab ${t === this._tab ? "on" : ""}" @click="${() => { this._tab = t; if (t === "lists") this._poll(); }}">${labels[t]}</button>`) : ""}
          </div>
          ${this._tab === "chores" && this._loaded && !this._error
            ? html`<button class="gear" title="People, chores and rewards" @click="${() => { this._sheet = "manage"; }}">⚙️</button>` : ""}
        </div>
        ${body}
        ${this._kbOpen ? html`<div style="height:310px"></div>` : ""}
        ${this._toastMsg ? html`<div class="toast">${this._toastMsg}</div>` : ""}
        ${this._sheet ? this._renderSheet() : ""}
      </ha-card>`;
  }

  _renderChores() {
    const setup = this._peek("setup", { people: [], chores: [], rewards: [] });
    if (!setup.people.length) {
      return html`<div class="empty">No family members yet.<br>Tap ⚙️ to add people, chores and rewards.</div>`;
    }
    const stars = this._peek("stars", {});
    const leader = [...setup.people].sort((a, b) => (stars[b.id] || 0) - (stars[a.id] || 0))[0];
    return html`
      ${setup.people.length > 1 && (stars[leader.id] || 0) > 0
        ? html`<div class="leader">🏆 ${leader.name} is in the lead with ${stars[leader.id]} ⭐</div>` : ""}
      <div class="people">${setup.people.map((p) => this._renderPerson(p, setup, stars))}</div>`;
  }

  _renderPerson(p, setup, stars) {
    const bal = stars[p.id] || 0;
    const mine = setup.chores.filter((c) => c.who === p.id);
    const group = (title, freq) => {
      const list = mine.filter((c) => c.freq === freq);
      if (!list.length) return "";
      const done = list.filter((c) => this._isDone(c)).length;
      return html`
        <div class="grp">${title}<span>${done}/${list.length}</span></div>
        ${list.map((c) => {
          const d = this._isDone(c);
          return html`<button class="chore ${d ? "done" : ""}" style="--c:${p.color}" @click="${() => this._toggleChore(c)}">
            <span class="box">${d ? "✓" : ""}</span><span class="t">${c.title}</span><span class="pts">+${c.stars}⭐</span>
          </button>`;
        })}`;
    };
    return html`
      <div class="person" style="--c:${p.color}">
        <div class="phead">
          <span class="av" style="background:${p.color}">${p.emoji}</span>
          <span class="pname">${p.name}</span>
          <span class="bal">${bal} ⭐</span>
        </div>
        ${group("Today", "daily")}${group("This week", "weekly")}
        ${!mine.length ? html`<div class="muted">No chores yet. Tap ⚙️ to add some.</div>` : ""}
        ${setup.rewards.length ? html`
          <div class="grp">Rewards</div>
          <div class="rewards">${setup.rewards.map((r) => {
            const armed = this._arm === `r${p.id}${r.id}`;
            return html`<button class="reward ${bal >= r.cost ? "" : "locked"} ${armed ? "arm" : ""}" @click="${() => this._redeem(p, r)}">
              <span>${r.icon}</span><span>${armed ? "Tap again" : r.name}</span><small>${r.cost} ⭐</small></button>`;
          })}</div>` : ""}
      </div>`;
  }

  _renderMeals() {
    const plan = this._peek("plan", {});
    const today = (new Date().getDay() + 6) % 7;
    return html`
      <div class="week-scroll"><div class="week">
        ${FH_DAYS.map((d, i) => html`
          <div class="day ${i === today ? "today" : ""}">
            <div class="dname">${d[1]}</div>
            ${FH_MEALS.map((m) => {
              const v = plan[`${d[0]}.${m[0]}`];
              return html`<button class="meal ${v ? "set" : ""}" @click="${() => this._openMeal(d, m)}">
                <small>${m[2]} ${m[1]}</small><span>${v || "+"}</span></button>`;
            })}
          </div>`)}
      </div></div>
      <div class="actions">
        <button class="btn primary" @click="${() => this._sendGroceries()}">🛒 Add ingredients to shopping list</button>
        <button class="btn ${this._arm === "clearweek" ? "danger" : ""}" @click="${() => this._clearWeek()}">${this._arm === "clearweek" ? "Tap again to clear" : "Clear the week"}</button>
      </div>`;
  }

  _renderLists() {
    const lists = this._cfg.lists;
    if (!lists.length) {
      return html`<div class="empty">Add your to-do lists under <code>lists:</code> in the card settings.</div>`;
    }
    const l = this._curList;
    const items = this._listItems[l.entity];
    const open = (items || []).filter((i) => i.status !== "completed");
    const done = (items || []).filter((i) => i.status === "completed");
    const row = (it) => html`
      <div class="li ${it.status === "completed" ? "done" : ""}">
        <button class="chk" style="--c:${l.color}" @click="${() => this._toggleItem(l, it)}">${it.status === "completed" ? "✓" : ""}</button>
        <span class="lt">${it.summary}</span>
        <button class="x" title="Remove" @click="${() => this._removeItems(l, [it.uid])}">✕</button>
      </div>`;
    return html`
      <div class="chips">${lists.map((x) => {
        const n = this.hass.states[x.entity] ? this.hass.states[x.entity].state : "";
        return html`<button class="chip ${x.entity === l.entity ? "on" : ""}" style="--c:${x.color}" @click="${() => this._selectList(x)}">
          ${x.icon ? html`<ha-icon icon="${x.icon}"></ha-icon>` : ""}${this._listName(x)}${n && n !== "0" && /^\d+$/.test(n) ? html`<b>${n}</b>` : ""}</button>`;
      })}</div>
      <div class="listcard" style="--c:${l.color}">
        <div class="add">
          <input class="in" data-kb type="text" autocomplete="off" placeholder="Add an item…"
                 inputmode="${this._kbOn() ? "none" : "text"}" .value="${this._form.newItem || ""}"
                 @input="${(e) => this._f("newItem", e.target.value)}"
                 @keydown="${(e) => { if (e.key === "Enter") { e.preventDefault(); this._addItem(l); } }}">
          <button class="btn primary" @mousedown="${(e) => e.preventDefault()}" @click="${() => this._addItem(l)}">Add</button>
        </div>
        ${items === undefined ? html`<div class="muted">Loading…</div>`
          : !items.length ? html`<div class="muted">Nothing here yet.</div>` : ""}
        ${open.map(row)}
        ${done.length ? html`
          <div class="grp">Done<span><button class="link" @click="${() => this._removeItems(l, done.map((x) => x.uid))}">Clear done</button></span></div>
          ${done.map(row)}` : ""}
      </div>`;
  }

  _renderSheet() {
    const kb = this._kbOpen ? "kb" : "";
    const body = this._sheet === "meal" ? this._renderMealSheet() : this._renderManage();
    return html`
      <div class="sheet ${fhKbSupported() ? "" : "nopop"}" popover="manual"
           @click="${(e) => { if (e.target === e.currentTarget) this._closeSheet(); }}">
        <div class="panel ${kb}">${body}</div>
      </div>`;
  }

  _renderMealSheet() {
    const m = this._meal;
    const recipes = this._peek("recipes", FH_DEFAULT_RECIPES);
    const names = Object.keys(recipes).filter((n) => !m.name || n.toLowerCase().includes(m.name.toLowerCase()));
    return html`
      <div class="stitle">${m.label}</div>
      <input class="in" data-kb type="text" autocomplete="off" placeholder="What's for ${m.label.split(" ")[1] || "the meal"}?"
             inputmode="${this._kbOn() ? "none" : "text"}" .value="${m.name}"
             @input="${(e) => { this._meal = { ...this._meal, name: e.target.value }; }}">
      <div class="sugg">${names.slice(0, 12).map((n) => html`
        <button class="chip" @click="${() => this._pickRecipe(n)}">${n}</button>`)}</div>
      <label class="lbl">Ingredients (separate with commas). Used for the shopping list.</label>
      <textarea class="in" data-kb rows="3" inputmode="${this._kbOn() ? "none" : "text"}"
                .value="${m.ingredients}"
                @input="${(e) => { this._meal = { ...this._meal, ingredients: e.target.value }; }}"></textarea>
      <div class="srow">
        <button class="btn" @click="${() => this._closeSheet()}">Cancel</button>
        <button class="btn" @click="${() => { this._meal = { ...this._meal, name: "", ingredients: "" }; this._saveMeal(); }}">Clear</button>
        <button class="btn primary" @click="${() => this._saveMeal()}">Save</button>
      </div>`;
  }

  _renderManage() {
    const s = this._peek("setup", { people: [], chores: [], rewards: [] });
    const f = this._form;
    const del = (key, fn) => html`<button class="x ${this._arm === key ? "arm" : ""}" @click="${() => this._confirm(key, fn)}">${this._arm === key ? "Tap again" : "✕"}</button>`;
    const person = (id) => (s.people.find((p) => p.id === id) || {}).name || "?";
    return html`
      <div class="stitle">Family settings <button class="btn primary" @click="${() => this._closeSheet()}">Done</button></div>

      <h4>People</h4>
      ${s.people.map((p) => html`<div class="mrow"><span class="av" style="background:${p.color}">${p.emoji}</span><span class="grow">${p.name}</span>${del(`p${p.id}`, () => this._removePerson(p.id))}</div>`)}
      <div class="addbox">
        ${this._in("pName", "Name")}
        <div class="picks">${FH_PEOPLE_EMOJI.map((e) => html`<button class="pick ${(f.pEmoji || FH_PEOPLE_EMOJI[0]) === e ? "on" : ""}" @click="${() => this._f("pEmoji", e)}">${e}</button>`)}</div>
        <div class="picks">${FH_PALETTE.map((c) => html`<button class="sw ${(f.pColor || FH_PALETTE[s.people.length % FH_PALETTE.length]) === c ? "on" : ""}" style="background:${c}" @click="${() => this._f("pColor", c)}"></button>`)}</div>
        <button class="btn primary" @click="${() => this._addPerson()}">Add person</button>
      </div>

      <h4>Chores</h4>
      ${s.chores.map((c) => html`<div class="mrow"><span class="grow">${c.title}<small> · ${person(c.who)} · ${c.freq} · +${c.stars}⭐</small></span>${del(`c${c.id}`, () => this._setup((x) => { x.chores = x.chores.filter((y) => y.id !== c.id); }))}</div>`)}
      <div class="addbox">
        ${this._in("cTitle", "New chore, e.g. Make your bed")}
        <div class="two">
          <select class="in" @change="${(e) => this._f("cWho", e.target.value)}">
            ${s.people.map((p) => html`<option value="${p.id}" ?selected="${(f.cWho || (s.people[0] && s.people[0].id)) === p.id}">${p.name}</option>`)}
          </select>
          <select class="in" @change="${(e) => this._f("cFreq", e.target.value)}">
            <option value="daily" ?selected="${(f.cFreq || "daily") === "daily"}">Every day</option>
            <option value="weekly" ?selected="${f.cFreq === "weekly"}">Every week</option>
          </select>
          ${this._in("cStars", "Stars (1)", { mode: "numeric" })}
        </div>
        <button class="btn primary" @click="${() => this._addChore()}">Add chore</button>
      </div>

      <h4>Rewards</h4>
      ${s.rewards.map((r) => html`<div class="mrow"><span>${r.icon}</span><span class="grow">${r.name}<small> · ${r.cost}⭐</small></span>${del(`w${r.id}`, () => this._setup((x) => { x.rewards = x.rewards.filter((y) => y.id !== r.id); }))}</div>`)}
      <div class="addbox">
        <div class="two">${this._in("rName", "Reward, e.g. Movie night")}${this._in("rCost", "Cost in stars", { mode: "numeric" })}</div>
        <div class="picks">${FH_REWARD_EMOJI.map((e) => html`<button class="pick ${(f.rIcon || FH_REWARD_EMOJI[0]) === e ? "on" : ""}" @click="${() => this._f("rIcon", e)}">${e}</button>`)}</div>
        <button class="btn primary" @click="${() => this._addReward()}">Add reward</button>
      </div>`;
  }

  static get styles() {
    return css`
      :host { display: block; }
      ha-card { padding: 12px; position: relative; color: var(--primary-text-color); }
      button { font: inherit; color: inherit; cursor: pointer; }
      .top { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .tabs { display: flex; gap: 6px; flex: 1; flex-wrap: wrap; }
      .tab { padding: 8px 14px; border-radius: 999px; border: 1px solid var(--divider-color); background: none; font-weight: 500; }
      .tab.on { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      .gear { background: none; border: none; font-size: 1.4rem; padding: 4px 8px; }
      .empty { padding: 28px 12px; text-align: center; color: var(--secondary-text-color); line-height: 1.5; }
      .empty.err { color: var(--error-color, #db4437); }
      .muted { color: var(--secondary-text-color); font-size: 0.85rem; padding: 6px 2px; }
      .leader { text-align: center; padding: 8px; margin-bottom: 10px; border-radius: 10px; background: var(--secondary-background-color); font-weight: 500; }
      .people { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
      .person { border-radius: 14px; padding: 12px; background: var(--secondary-background-color); border-top: 4px solid var(--c); }
      .phead { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .av { width: 38px; height: 38px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 1.3rem; flex: none; }
      .pname { font-size: 1.15rem; font-weight: 600; flex: 1; }
      .bal { font-size: 1.15rem; font-weight: 700; color: #ffb300; }
      .grp { display: flex; justify-content: space-between; align-items: center; margin: 12px 2px 6px; font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--secondary-text-color); }
      .chore { display: flex; align-items: center; gap: 10px; width: 100%; margin-bottom: 6px; padding: 12px; text-align: left; border: 1px solid var(--divider-color); border-radius: 10px; background: var(--card-background-color); }
      .chore .box { width: 26px; height: 26px; border-radius: 8px; border: 2px solid var(--c); display: inline-flex; align-items: center; justify-content: center; flex: none; font-weight: 700; color: #fff; }
      .chore.done .box { background: var(--c); }
      .chore.done .t { text-decoration: line-through; opacity: 0.55; }
      .chore .t { flex: 1; }
      .pts { font-size: 0.8rem; color: var(--secondary-text-color); }
      .rewards { display: flex; flex-wrap: wrap; gap: 6px; }
      .reward { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 12px; min-width: 84px; border-radius: 10px; border: 1px solid var(--divider-color); background: var(--card-background-color); }
      .reward small { color: var(--secondary-text-color); }
      .reward.locked { opacity: 0.5; }
      .reward.arm { background: var(--primary-color); color: #fff; border-color: var(--primary-color); opacity: 1; }
      .week-scroll { overflow-x: auto; }
      .week { display: grid; grid-template-columns: repeat(7, minmax(112px, 1fr)); gap: 8px; min-width: 800px; }
      .day { display: flex; flex-direction: column; gap: 6px; }
      .dname { text-align: center; font-weight: 600; padding: 4px; border-radius: 8px; }
      .day.today .dname { background: var(--primary-color); color: var(--text-primary-color, #fff); }
      .meal { display: flex; flex-direction: column; gap: 2px; min-height: 62px; padding: 8px; text-align: left; border: 1px dashed var(--divider-color); border-radius: 10px; background: none; }
      .meal small { color: var(--secondary-text-color); font-size: 0.7rem; }
      .meal span { font-weight: 500; }
      .meal.set { border-style: solid; background: var(--secondary-background-color); }
      .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
      .btn { padding: 10px 16px; border-radius: 10px; border: 1px solid var(--divider-color); background: none; font-weight: 500; }
      .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
      .btn.danger { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); color: #fff; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 999px; border: 2px solid var(--c, var(--divider-color)); background: none; }
      .chip.on { background: var(--c, var(--primary-color)); color: #fff; }
      .chip b { font-size: 0.75rem; padding: 1px 7px; border-radius: 999px; background: rgba(0, 0, 0, 0.25); }
      .listcard { border-radius: 14px; padding: 12px; background: var(--secondary-background-color); border-top: 4px solid var(--c); }
      .add { display: flex; gap: 8px; margin-bottom: 8px; }
      .add .in { flex: 1; }
      .li { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px solid var(--divider-color); }
      .li.done .lt { text-decoration: line-through; opacity: 0.55; }
      .lt { flex: 1; overflow-wrap: anywhere; }
      .chk { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--c); background: none; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; color: #fff; flex: none; padding: 0; }
      .li.done .chk { background: var(--c); }
      .x { background: none; border: none; color: var(--secondary-text-color); padding: 6px 8px; border-radius: 8px; }
      .x.arm { background: var(--error-color, #db4437); color: #fff; }
      .link { background: none; border: none; color: var(--primary-color); padding: 0; text-transform: none; letter-spacing: 0; }
      .in { font: inherit; font-size: 16px; width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 10px; color: var(--primary-text-color); background: var(--card-background-color); border: 1px solid var(--divider-color); color-scheme: light dark; }
      textarea.in { resize: vertical; }
      .in:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
      .toast { position: sticky; bottom: 8px; margin-top: 10px; padding: 10px 14px; border-radius: 10px; background: var(--primary-text-color); color: var(--card-background-color); text-align: center; }

      /* Pop-up sheets: top layer, so they sit above everything without blocking the keyboard */
      .sheet { inset: 0; margin: 0; width: 100%; height: 100%; max-width: none; max-height: none; border: 0; padding: 0; background: rgba(0, 0, 0, 0.55); align-items: center; justify-content: center; }
      .sheet:popover-open { display: flex; }
      .sheet.nopop { position: fixed; z-index: 9999; display: flex; }
      .panel { box-sizing: border-box; width: min(560px, 94vw); max-height: 90vh; overflow-y: auto; padding: 16px; border-radius: 16px; background: var(--icc-popup-bg, var(--card-background-color)); -webkit-backdrop-filter: var(--icc-popup-filter, none); backdrop-filter: var(--icc-popup-filter, none); color: var(--primary-text-color); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); display: flex; flex-direction: column; gap: 10px; }
      .panel.kb { max-height: calc(100dvh - 330px); align-self: flex-start; margin-top: 12px; }
      .stitle { display: flex; justify-content: space-between; align-items: center; font-size: 1.2rem; font-weight: 600; }
      h4 { margin: 12px 0 0; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--secondary-text-color); }
      .mrow { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--divider-color); }
      .mrow small { color: var(--secondary-text-color); }
      .grow { flex: 1; }
      .addbox { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 12px; background: var(--secondary-background-color); }
      .two { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
      .picks { display: flex; flex-wrap: wrap; gap: 6px; }
      .pick { width: 40px; height: 40px; font-size: 1.3rem; border-radius: 10px; border: 2px solid transparent; background: var(--card-background-color); padding: 0; }
      .pick.on { border-color: var(--primary-color); }
      .sw { width: 32px; height: 32px; border-radius: 50%; border: 3px solid transparent; padding: 0; }
      .sw.on { border-color: var(--primary-text-color); }
      .sugg { display: flex; flex-wrap: wrap; gap: 6px; }
      .sugg .chip { padding: 6px 12px; border-color: var(--divider-color); }
      .lbl { font-size: 0.8rem; color: var(--secondary-text-color); }
      .srow { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
    `;
  }
}
customElements.define("family-hub-card", FamilyHubCard);

// -----------------------------------------------------------------------------
// Visual editor for the Family Hub card
// -----------------------------------------------------------------------------
const FH_EDITOR_LABELS = {
  store: "Data store (Local To-do list)",
  shopping_list: "Shopping list (meal planner sends ingredients here)",
  pantry_list: "Pantry list (optional: things you already have)",
  lists: "Shared lists",
  default_tab: "Opens on",
  on_screen_keyboard: "On-screen keyboard",
  screensaver: "Photo screensaver",
  idle_seconds: "Start after (seconds, 0 = off)",
  folder: "Photo folder",
  slide_seconds: "Seconds per photo",
  show_clock: "Show clock",
  navigate_path: "When closed, go to (optional)",
  popup_opacity: "Popup opacity",
  popup_color: "Popup color (solid, any CSS color)",
  popup_blur: "Popup background blur",
};
const FH_EDITOR_SCHEMA = [
  { name: "store", required: true, selector: { entity: { domain: "todo" } } },
  { name: "shopping_list", selector: { entity: { domain: "todo" } } },
  { name: "pantry_list", selector: { entity: { domain: "todo" } } },
  { name: "lists", selector: { entity: { domain: "todo", multiple: true } } },
  {
    type: "grid", name: "", schema: [
      { name: "default_tab", selector: { select: { mode: "dropdown", options: [
        { value: "chores", label: "Chores" }, { value: "meals", label: "Meals" }, { value: "lists", label: "Lists" },
      ] } } },
      { name: "on_screen_keyboard", selector: { select: { mode: "dropdown", options: [
        { value: "always", label: "Always" }, { value: "touch", label: "Touchscreens only" }, { value: "off", label: "Off" },
      ] } } },
    ],
  },
  { type: "expandable", name: "", title: "Popups (for transparent themes)", schema: POPUP_FIELDS },
  {
    type: "expandable", name: "screensaver", title: "Photo screensaver", schema: [
      { name: "folder", selector: { text: {} } },
      {
        type: "grid", name: "", schema: [
          { name: "idle_seconds", selector: { number: { min: 0, max: 86400, mode: "box" } } },
          { name: "slide_seconds", selector: { number: { min: 5, max: 3600, mode: "box" } } },
        ],
      },
      { name: "show_clock", selector: { boolean: {} } },
      { name: "navigate_path", selector: { text: {} } },
    ],
  },
];

class FamilyHubCardEditor extends LitElement {
  static get properties() {
    return { hass: {}, _config: {} };
  }

  setConfig(config) {
    this._config = config;
  }

  _data() {
    const c = this._config;
    return { ...c, lists: (c.lists || []).map((l) => (typeof l === "string" ? l : l.entity)) };
  }

  _changed(e) {
    e.stopPropagation();
    const v = { ...(e.detail.value || {}) };
    const old = this._config.lists || [];
    // Keep per-list name/color/icon that can only be set in YAML
    if (Array.isArray(v.lists)) {
      v.lists = v.lists.map((ent) => old.find((o) => typeof o === "object" && o.entity === ent) || ent);
    }
    const clean = {};
    Object.entries(v).forEach(([k, val]) => {
      if (val === undefined || val === null || val === "" || (Array.isArray(val) && !val.length)) return;
      if (k === "screensaver" && typeof val === "object") {
        const ss = {};
        Object.entries(val).forEach(([sk, sv]) => { if (sv !== undefined && sv !== null && sv !== "") ss[sk] = sv; });
        if (!Object.keys(ss).length) return;
        clean[k] = ss;
        return;
      }
      clean[k] = val;
    });
    this._config = clean;
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: clean }, bubbles: true, composed: true }));
  }

  render() {
    if (!this.hass || !this._config) return html``;
    return html`
      <ha-form .hass="${this.hass}" .data="${this._data()}" .schema="${FH_EDITOR_SCHEMA}"
               .computeLabel="${(s) => FH_EDITOR_LABELS[s.name] || s.title || s.name}"
               .computeHelper="${(s) => EDITOR_HELPERS[s.name]}"
               @value-changed="${(e) => this._changed(e)}"></ha-form>
      <p class="note">List names, colors and icons can be set in YAML:
        <code>lists: [{entity: todo.shopping_list, name: Groceries, color: "#30d158", icon: mdi:cart}]</code></p>`;
  }

  static get styles() {
    return css`.note { font-size: 0.8rem; color: var(--secondary-text-color); margin: 12px 0 0; } code { word-break: break-all; }`;
  }
}
customElements.define("family-hub-card-editor", FamilyHubCardEditor);

window.customCards = window.customCards || [];
window.customCards.push(
  {
    type: "family-hub-card",
    name: "Family Hub",
    description: "Chores with star rewards, weekly meal planner with shopping-list push, shared lists, and a photo screensaver.",
  },
  {
    type: "family-screensaver-card",
    name: "Family photo screensaver",
    description: "Turns the dashboard into a photo frame after a period of no activity.",
  },
);
