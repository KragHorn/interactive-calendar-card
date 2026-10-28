# Interactive Calendar Card

A family-dashboard toolkit for Home Assistant, shipped as a **single JavaScript file**. It adds three cards:

| Card | What it does |
|---|---|
| `custom:interactive-calendar-card` | Month calendar across several calendars. Add, edit and delete events right from the dashboard. |
| `custom:family-hub-card` | Chores with star rewards, a weekly meal planner that fills your shopping list, and shared color-coded lists. |
| `custom:family-screensaver-card` | Optional stand-alone card that turns the dashboard into a photo frame when idle. |

Everything works with the visual editor and an **on-screen keyboard** for wall-mounted tablets. No helpers, scripts, automations or extra integrations are required.

---

## Contents

- [Installation](#installation)
- [Calendar card](#calendar-card)
- [Family Hub card](#family-hub-card)
- [Photo screensaver](#photo-screensaver)
- [Popups and transparent themes](#popups-and-transparent-themes)
- [On-screen keyboard](#on-screen-keyboard)
- [Troubleshooting](#troubleshooting)

---

## Installation

### HACS (recommended)

1. In HACS, open the **⋮** menu → **Custom repositories**.
2. Add `https://github.com/KragHorn/interactive-calendar-card` with the category **Dashboard**.
3. Find **Interactive Calendar Card** in HACS and click **Download**.
4. Hard-refresh your browser (Ctrl+Shift+R). On the mobile app, use **Settings → Companion app → Troubleshooting → Reset frontend cache**.

HACS adds the dashboard resource for you. If you use a YAML-mode dashboard, add it by hand:

```yaml
resources:
  - url: /hacsfiles/interactive-calendar-card/interactive-calendar-card.js
    type: module
```

### Manual

1. Copy `interactive-calendar-card.js` to `/config/www/`.
2. Go to **Settings → Dashboards → ⋮ → Resources** (turn on Advanced mode in your profile first).
3. Add `/local/interactive-calendar-card.js` as a **JavaScript module**.
4. Hard-refresh.

---

## Calendar card

Add it from the card picker (search "Interactive Calendar") and use the visual editor, or in YAML:

```yaml
type: custom:interactive-calendar-card
entities:
  - entity: calendar.family
    name: Family
    color: "#0a84ff"
    primary: true
  - entity: calendar.school
    name: School
    color: "#ff9f0a"
    style: outline
first_day: monday
time_format: 24h
```

### Features

- Month view across any number of calendar entities, with a clickable legend to show or hide each one (the choice is remembered per browser).
- Tap a day to add an event. Tap an event to view, edit or delete it.
- A calendar dropdown on the new-event form, so you can add to any calendar that accepts events.
- Edit and Delete buttons appear for every calendar that supports them. Read-only calendars (holidays, birthdays) are left alone.
- A sync button, plus optional auto-sync, for calendars that need refreshing (such as Google Calendar).
- Works fully in the visual editor.

### Options

| Option | Default | Description |
|---|---|---|
| `entities` | required | One calendar id, a list of ids, or a list of objects (see below). |
| `title` | none | Heading shown above the calendar. |
| `first_day` | `sunday` | `sunday` or `monday`. |
| `time_format` | `12h` | `12h` or `24h`. |
| `default_start_time` | `09:00` | Start time suggested for new events (`HH:MM`). |
| `default_duration` | `60` | Length in minutes suggested for new events. |
| `auto_sync_minutes` | `5` | How often to ask Home Assistant to refresh the calendars. `0` turns it off. |
| `show_legend` | `true` with 2+ calendars | Show the calendar legend. |
| `show_sync_button` | `true` | Show the sync button. |
| `hide_titles` | none | List of event titles to hide (not case-sensitive), e.g. `["Busy"]`. |
| `on_screen_keyboard` | `always` | `always`, `touch` (touchscreens only) or `off`. |
| `screensaver` | none | Photo screensaver settings. See [Photo screensaver](#photo-screensaver). |
| `popup_opacity` | none | How solid popups are, 0-100. See [Popups and transparent themes](#popups-and-transparent-themes). |
| `popup_color` | none | A solid color for popups (any CSS color). |
| `popup_blur` | none | Frosted-glass blur behind popups, in pixels. |

**Each item under `entities`:**

| Key | Description |
|---|---|
| `entity` | The calendar entity id. Required. |
| `name` | Display name. Defaults to the entity's friendly name. |
| `color` | Any CSS color. Defaults to a built-in palette. |
| `style` | `solid`, `soft` or `outline`. The primary calendar defaults to `solid`, the others to `soft`. |
| `primary` | `true` on one calendar. New events default to it. If none is marked, the first is primary. |

**Layout options** (a plain number means pixels; CSS units like `8rem` or `90%` also work): `max_width`, `day_height`, `header_font_size`, `event_font_size`, `day_number_font_size`, `event_radius`, `card_padding`, `day_gap`, and `today_color`.

---

## Family Hub card

```yaml
type: custom:family-hub-card
store: todo.family_hub_data
shopping_list: todo.shopping_list
pantry_list: todo.pantry
lists:
  - entity: todo.shopping_list
    name: Groceries
    color: "#30d158"
    icon: mdi:cart
  - todo.packing_list
```

### How it stores data

The card needs no helpers or automations. It saves everything inside Home Assistant itself, so every device sees the same data:

- **Lists** are ordinary Home Assistant to-do entities.
- **People, chores, stars, the meal plan and recipes** are saved as small records inside one **Local To-do** list, the `store`. Records are items whose title starts with `fh:`. Please don't edit or delete those by hand.

### Setup

1. Go to **Settings → Devices & services → Add integration → Local To-do** and create a list called **Family Hub Data**. Its entity id is `todo.family_hub_data`.
2. For the shopping list, add the built-in **Shopping List** integration (it provides `todo.shopping_list`), or use any other to-do entity such as Bring!, Todoist or Google Tasks.
3. Add the card and set `store`.
4. Open the **Chores** tab and tap ⚙️ to add people, chores and rewards.

The store must be a **Local To-do** list, because it keeps its records in item descriptions.

### Chores and stars

- Each person gets a tile with **Today** and **This week** chores, a star balance, and reward buttons.
- Checking a chore earns its stars. Un-checking takes them back, so nobody can farm stars by ticking a chore repeatedly.
- Daily chores reset at midnight and weekly chores on Monday. This is worked out from the date, so no automation is needed.
- Reward buttons spend stars. A reward needs a second tap to confirm, and shows how many stars are missing if there aren't enough.
- A banner shows who is in the lead.
- Add or remove people, chores and rewards in the ⚙️ screen. Removing a person also removes their chores.

### Meal planner

- A week grid with breakfast, lunch and dinner for each day. Tap a slot to pick a previous meal or type a new one.
- List a meal's ingredients, separated by commas. The card remembers them for next time.
- **Add ingredients to shopping list** merges the whole week's ingredients, removes duplicates, and adds only what's missing. Anything already on the shopping list, or on the optional `pantry_list`, is skipped. Items on the shopping list that are already ticked off count as needing to be bought again.
- **Clear the week** resets the plan (it asks for a second tap).

### Shared lists

- Pick the to-do lists to show with `lists`. Each can have its own `name`, `color` and `icon`. A plain entity id works too.
- Add items, tick them off, remove them, or clear everything that's done.
- Lists refresh automatically when they change on another device.

### Options

| Option | Default | Description |
|---|---|---|
| `store` | required | The Local To-do list used for the card's own data. |
| `shopping_list` | none | To-do entity the meal planner sends ingredients to. |
| `pantry_list` | none | Optional to-do entity of items you already have. |
| `lists` | `shopping_list` only | To-do entities for the Lists tab. Strings or `{entity, name, color, icon}`. |
| `tabs` | all three | Any of `chores`, `meals`, `lists`, in the order you want. |
| `default_tab` | first tab | Which tab opens first. |
| `on_screen_keyboard` | `always` | `always`, `touch` or `off`. |
| `screensaver` | none | Photo screensaver settings. |
| `popup_opacity` | none | How solid popups are, 0-100. See [Popups and transparent themes](#popups-and-transparent-themes). |
| `popup_color` | none | A solid color for popups (any CSS color). |
| `popup_blur` | none | Frosted-glass blur behind popups, in pixels. |

The visual editor covers all of these. Per-list names, colors and icons are set in YAML.

---

## Photo screensaver

After a period without touches, the dashboard turns into a slideshow of your photos with a clock. A tap closes it. Put the `screensaver:` block on the calendar card or the Family Hub card:

```yaml
screensaver:
  folder: media-source://media_source/local/family_photos
  idle_seconds: 120
  slide_seconds: 30
```

Or add the stand-alone card to any view:

```yaml
type: custom:family-screensaver-card
folder: media-source://media_source/local/family_photos
idle_seconds: 120
```

| Option | Default | Description |
|---|---|---|
| `folder` | none | A media folder, such as `media-source://media_source/local/family_photos`. Subfolders (two levels) are included. |
| `urls` | none | Extra image URLs (for example `/local/photo.jpg`). Can be used with or without `folder`. |
| `idle_seconds` | `120` | Seconds without activity before it starts. `0` turns it off. |
| `slide_seconds` | `30` | Seconds each photo is shown. |
| `show_clock` | `true` | Show the time and date. |
| `fit` | `cover` | `cover` fills the screen. `contain` shows the whole photo. |
| `navigate_path` | none | Dashboard path to open when it closes, e.g. `/lovelace/calendar`. |

**Adding photos:** upload them to your Home Assistant media storage (**Media** in the sidebar → **My media → Local media**) in a folder such as `family_photos`.

The screensaver only runs while a card with this setting is on the dashboard view that is open. To cover several views, put the setting on a card in each one.

---

## Popups and transparent themes

With a transparent or glass-style theme, popups (the event dialog, the Family Hub sheets and the on-screen keyboards) can be hard to read because the dashboard shows through them. Three options fix that. They work on both the calendar card and the Family Hub card, and they appear in the visual editor under **Popups (for transparent themes)**.

```yaml
popup_opacity: 90        # 0-100, how solid the popup is (100 = fully solid)
popup_color: "#14181f"   # optional solid color
popup_blur: 12           # optional frosted-glass blur, in pixels
```

| Option | Description |
|---|---|
| `popup_opacity` | `100` is fully solid. Lower values let the dashboard show through. |
| `popup_color` | Any CSS color. Opacity is applied to this color. |
| `popup_blur` | Blurs whatever is behind the popup, for a frosted-glass look. `0` or unset turns it off. |

If none of these are set, popups look exactly as your theme draws them.

**Tip:** if your theme's own popup color is already see-through, setting only `popup_opacity` can't make it more solid. Set `popup_color` to a solid color too, then adjust `popup_opacity` to taste.

Each card applies its own settings. If you use both cards, set the same values on each so the popups match.

---

## On-screen keyboard

Tapping a text box in the calendar's event popup or in the Family Hub card opens a built-in keyboard, so wall tablets don't need a physical one.

- Letters, numbers and symbols, with shift (double-tap for caps lock) and auto-capitalization after a full stop.
- Hold backspace to keep deleting. Typing respects the cursor position.
- Done closes the keyboard (or adds a line break in multi-line fields), and the arrow button hides it.
- Date and time fields still use the browser's native pickers.
- A physical keyboard works as normal.

Set `on_screen_keyboard: touch` to show it only on touchscreens, or `off` to use the device's own keyboard.

The Family Hub keyboard needs a recent browser (Chrome 114+, Safari 17+, Firefox 125+). On older ones it falls back to the device keyboard.

---

## Troubleshooting

**The card doesn't show up in the picker, or "Custom element doesn't exist".**
Check that the resource is registered under **Settings → Dashboards → ⋮ → Resources**, then hard-refresh (Ctrl+Shift+R). On the mobile app, reset the frontend cache. Open the file's URL in a browser tab to confirm it loads.

**I updated the file but nothing changed.**
HACS often serves the latest *release*, not the newest commit. Publish a new release, then use **⋮ → Update information → Redownload** on the card in HACS, and hard-refresh.

**To check you're running the current version**, open the browser console on a dashboard and run:

```js
customElements.get("family-hub-card")
```

If it prints `undefined`, the old file is loaded.

**Family Hub shows "Could not read …".**
`store` must be an existing **Local To-do** list. Check the entity id in **Developer tools → States**.

**Stars or the meal plan look out of date on another device.**
The card re-reads its data every 15 seconds and whenever the page becomes visible again.

**New events aren't offered for a calendar.**
The calendar entity must support creating events. Holiday, birthday and some read-only calendars don't.

---

## Notes

- Family Hub data is saved in a to-do list that anyone with dashboard access can change, so there is no parental lock on star balances.
