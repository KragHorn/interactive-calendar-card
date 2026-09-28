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
const FEATURE_UPDATE = 4;
// Used when a calendar in the config has no color set
const DEFAULT_PALETTE = ["#0a84ff", "#ff9f0a", "#ff375f", "#30d158", "#bf5af2", "#64d2ff", "#ffd60a"];

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

    this._opts = {
      title: config.title || "",
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

  get _storageKey() {
    return `interactive-calendar-card-hidden:${this._calendars.map((c) => c.entity).join(",")}`;
  }

  _calName(cal) {
    return cal.name || this.hass?.states[cal.entity]?.attributes?.friendly_name || cal.entity;
  }

  // ---- Loading & syncing ------------------------------------------------------

  updated(changedProperties) {
    this._syncDialogOpen();
    if (!this.hass) return;

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
    const y = this.currentDate.getFullYear();
    const m = this.currentDate.getMonth();
    const [hh, mm] = this._opts.defaultStart.split(":").map(Number);
    const start = new Date(y, m, dayNumber, hh, mm);
    const end = new Date(start.getTime() + this._opts.defaultDuration * 60000);
    this._dialog = {
      mode: "create",
      ev: null,
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
    this._dialog = { ...this._dialog, mode: "view", form: null, error: "", confirmDelete: false };
  }

  _closeDialog() {
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
        await this.hass.callWS({ type: "calendar/event/create", entity_id: this._entityId, event });
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

  // ---- Rendering: dialog ------------------------------------------------------

  _renderDialog() {
    const d = this._dialog;
    return html`
      <dialog class="event-dialog"
              @close="${() => { this._dialog = null; }}"
              @cancel="${(e) => { if (this._dialog && this._dialog.busy) e.preventDefault(); }}"
              @click="${(e) => { if (e.target === e.currentTarget && !(this._dialog && this._dialog.busy)) this._closeDialog(); }}">
        ${d ? html`<div class="dialog-body">${d.mode === "view" ? this._renderView(d) : this._renderForm(d)}</div>` : ""}
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
        ${cal.primary ? html`
          <button class="btn danger ${d.confirmDelete ? "confirm" : ""}"
                  ?disabled="${d.busy}"
                  @click="${() => this._delete()}">
            ${d.busy ? "Deleting…" : d.confirmDelete ? "Tap again to delete" : "Delete"}
          </button>` : ""}
        <span class="spacer"></span>
        <button class="btn" ?disabled="${d.busy}" @click="${() => this._closeDialog()}">Close</button>
        ${cal.primary ? html`
          <button class="btn primary" ?disabled="${d.busy}" @click="${() => this._startEdit()}">Edit</button>` : ""}
      </div>
    `;
  }

  _renderForm(d) {
    const f = d.form;
    return html`
      <div class="dialog-title">
        <span class="title-bar" style="background:${this._primary.color}"></span>
        <span class="title-text">${d.mode === "edit" ? "Edit event" : "New event"}</span>
      </div>

      <label class="field">
        <span>Title</span>
        <input type="text" placeholder="Event title" autofocus
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
        <input type="text" placeholder="Optional" .value="${f.location}"
               @input="${(e) => this._setField("location", e.target.value)}">
      </label>

      <label class="field">
        <span>Info</span>
        <textarea rows="3" placeholder="Optional" .value="${f.description}"
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
        background: var(--ha-card-background, var(--card-background-color, #1c1c1e));
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
      .field input, .field textarea {
        font: inherit; font-size: 16px; /* 16px stops iOS zooming in on focus */
        color: var(--primary-text-color); background: var(--secondary-background-color);
        border: 1px solid var(--divider-color, #3a3a3c); border-radius: 8px;
        padding: 8px 10px; width: 100%; box-sizing: border-box; color-scheme: light dark;
      }
      .field textarea { resize: vertical; min-height: 64px; }
      .field input:focus, .field textarea:focus { outline: 2px solid var(--primary-color); outline-offset: -1px; }
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
    `;
  }
}

customElements.define("interactive-calendar-card", InteractiveCalendarCard);
