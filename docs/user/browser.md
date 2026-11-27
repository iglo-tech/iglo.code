# Built-in browser

iglo.code includes a built-in preview browser beside your conversation so you and your agents can inspect local dev servers, annotate UI issues, record flows, and test web apps without leaving the thread.

## Open and navigate

- Open the right panel in a thread and choose **Browser** (or click a running dev server in the thread's **Servers** list).
- **Where tabs run**: Tabs stream from the host's Chromium (about a 200 MB one-time download; see [Browser on a remote environment](./remote-access.md#browser-on-a-remote-environment) and [Browser host setup](./remote-access.md#browser-host-setup)). Browser tabs belong to the environment, so you and your agents see the same tabs from any device.
- **Find on page**: Press `mod+f` inside a browser tab (or use its **⋮** menu if the page intercepts `mod+f`).

## Profiles, viewports, and settings

Configure defaults in **Settings → Browser**:

- **Browser profiles**: Maintain separate cookie/storage profiles and set a **Default browser profile**.
- **Viewport, zoom & appearance**: Set **Default browser viewport** (fill, freeform, or phone/tablet presets with portrait/landscape rotation), **Default browser zoom**, and **Default browser appearance** (system/light/dark).
- **Links & search**: Configure **Open links in** and **Search engine**.

## Pick elements, annotate, and record

- **Element picker & annotations**: Pick elements or annotate regions on the page to attach them directly into the composer as inline context chips.
- **Screen recordings**: Record browser interactions directly from the tab toolbar. Configure **Browser recording frame rate**, **Show key presses in recordings**, and **Show mouse presses in recordings** in **Settings → Browser**.

## Agent browser access

Agents can open tabs, navigate, click, type, inspect accessibility snapshots, and take screenshots using iglo.code's `preview_*` tools.

- Toggle **Settings → Browser → Agent browser access** (per environment or project override; takes effect when the next agent session starts).
- **Floating preview**: By default, agent-opened tabs float over chat, and closing the right panel floats its browser tab (**Settings → Browser → Auto-show floating preview**). Turn this off to open agent tabs in the right panel instead and to close the panel without a float.
- **Take control**: Click **Take control** before interacting with an agent's tab, and release control when you want the agent to resume.
