/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// icons.js — a tiny set of Feather-style inline SVG icons as static markup
// strings, used with `el("button", { html: icon.edit() })`. The markup is a
// fixed constant (never user data), so innerHTML use is XSS-safe. 16×16 on a 24
// viewBox, stroking currentColor so they inherit the button's colour.

function stroke(paths) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ` +
    `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

function fill(paths) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" ` +
    `viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">${paths}</svg>`
  );
}

// Tunnel forwarding-type glyphs (Feature 110): a 16×16 viewBox with a lighter 1.5
// stroke, tuned to sit beside 13 px row text and to grow with it — the SVG is sized
// in `em`, so it tracks the surrounding font. A filled "local anchor" dot plus
// directional arrows encode the type; monochrome via currentColor like the rest.
function stroke16(paths) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" ` +
    `viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  );
}

export const icons = {
  add: () =>
    stroke(
      '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    ),
  edit: () =>
    stroke(
      '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    ),
  // A document with a plus — "create a new record" (e.g. New jump host),
  // distinct from the bare `add` plus used for "add an existing one".
  filePlus: () =>
    stroke(
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
        '<polyline points="14 2 14 8 20 8"/>' +
        '<line x1="12" y1="18" x2="12" y2="12"/>' +
        '<line x1="9" y1="15" x2="15" y2="15"/>',
    ),
  power: () =>
    stroke(
      '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
    ),
  // The disarmed counterpart to `power`: the same glyph struck through with a
  // corner-to-corner slash (Feather's convention for its *-off variants), so
  // armed/disarmed differ in shape, not just colour — legible without colour.
  powerOff: () =>
    stroke(
      '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>' +
        '<line x1="12" y1="2" x2="12" y2="12"/>' +
        '<line x1="1" y1="1" x2="23" y2="23"/>',
    ),
  pause: () =>
    fill(
      '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    ),
  play: () => fill('<polygon points="6 4 20 12 6 20 6 4"/>'),
  chevronDown: () => stroke('<polyline points="6 9 12 15 18 9"/>'),
  // Shown on the Data Fields selector while a card is dragged over it — drop to
  // remove the field (see card-canvas.js / card-menu.js).
  trash: () =>
    stroke(
      '<polyline points="3 6 5 6 21 6"/>' +
        '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
        '<line x1="10" y1="11" x2="10" y2="17"/>' +
        '<line x1="14" y1="11" x2="14" y2="17"/>',
    ),
  // The cards (grid) + list glyphs for the header view-mode toggle. Each button
  // shows the glyph for the mode it switches TO (see app.js).
  cards: () =>
    stroke(
      '<rect x="3" y="3" width="7" height="7" rx="1"/>' +
        '<rect x="14" y="3" width="7" height="7" rx="1"/>' +
        '<rect x="14" y="14" width="7" height="7" rx="1"/>' +
        '<rect x="3" y="14" width="7" height="7" rx="1"/>',
    ),
  list: () =>
    stroke(
      '<line x1="8" y1="6" x2="21" y2="6"/>' +
        '<line x1="8" y1="12" x2="21" y2="12"/>' +
        '<line x1="8" y1="18" x2="21" y2="18"/>' +
        '<line x1="3" y1="6" x2="3.01" y2="6"/>' +
        '<line x1="3" y1="12" x2="3.01" y2="12"/>' +
        '<line x1="3" y1="18" x2="3.01" y2="18"/>',
    ),

  // A small clock, em-sized to sit beside row text like the type glyphs — the
  // scheduled-tunnel badge (Feature 150).
  clock: () =>
    stroke16('<circle cx="8" cy="8" r="6"/><path d="M8 4.6V8l2.4 1.4"/>'),

  // Forwarding-type glyphs — one per tunnel type, a consistent family (see stroke16).
  // Local: anchor dot + arrow out to the remote. Remote: far-side anchor + arrow back
  // in. Dynamic (SOCKS): local anchor fanning out to many destinations.
  tunnelLocal: () =>
    stroke16(
      '<circle cx="3.2" cy="8" r="1.5" fill="currentColor" stroke="none"/>' +
        '<path d="M4.9 8H11.9"/>' +
        '<path d="M9.5 5.4 12.3 8 9.5 10.6"/>',
    ),
  tunnelRemote: () =>
    stroke16(
      '<circle cx="12.8" cy="8" r="1.5" fill="currentColor" stroke="none"/>' +
        '<path d="M11.1 8H4.1"/>' +
        '<path d="M6.5 5.4 3.7 8 6.5 10.6"/>',
    ),
  tunnelDynamic: () =>
    stroke16(
      '<circle cx="3" cy="8" r="1.5" fill="currentColor" stroke="none"/>' +
        '<path d="M4.5 8H6"/>' +
        '<path d="M6 5.5V10.5"/>' +
        '<path d="M6 5.5H10.8"/><path d="M9.3 4.4 11.1 5.5 9.3 6.6"/>' +
        '<path d="M6 10.5H10.8"/><path d="M9.3 9.4 11.1 10.5 9.3 11.6"/>',
    ),
};
