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

/**
 * group-store.js — reusable, ordered tunnel groups (Feature 140).
 *
 * A group is `{ id, label, color }` — purely organisational: a tunnel references
 * at most one group by `groupId`. Groups share the one definitions document with
 * tunnels / credentials / jump hosts (definitions-doc.js). Array position IS
 * display order (the `order` on a returned view is derived from the index, exactly
 * like tunnel-store), so ordering can never drift and no `order` field is stored.
 *
 * Unlike a credential / jump host, a group is NOT load-bearing: deleting one that
 * is still referenced is allowed — its tunnels fall back to ungrouped (their
 * `groupId` is cleared in the same write). Creating / updating a group whose
 * `label`/`color` is invalid is rejected (INVALID_GROUP).
 */
"use strict";

const io = require("./io");
const { readDoc, writeDoc } = require("./definitions-doc");
const { validateGroup, DEFAULT_GROUP_COLOR } = require("./validate");

/** Build the tagged error the IPC layer turns into a field-keyed envelope. */
function invalidGroupError(errors) {
  const err = new Error("invalid group");
  err.code = "INVALID_GROUP";
  err.errors = errors;
  return err;
}

class GroupStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    return readDoc(this._paths);
  }

  _writeGroups(doc, groups) {
    writeDoc(this._paths, { ...doc, groups });
  }

  /** Renderer view of a stored group: record + derived order. */
  _view(group, order) {
    return { ...group, order };
  }

  /** Every group, in stored order, with a derived `order`. */
  list() {
    return this._read().groups.map((g, i) => this._view(g, i));
  }

  /** One group by id, or null if absent. */
  get(id) {
    const doc = this._read();
    const i = doc.groups.findIndex((g) => g && g.id === id);
    return i === -1 ? null : this._view(doc.groups[i], i);
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /** Create a group. Rejects an invalid label / colour. */
  create(group) {
    const record = applyDefaults(group);
    const { valid, errors } = validateGroup(record);
    if (!valid) throw invalidGroupError(errors);

    const doc = this._read();
    record.id = io.newUUID();
    delete record.order; // derived from array position, never stored
    doc.groups.push(record);
    this._writeGroups(doc, doc.groups);
    return this._view(record, doc.groups.length - 1);
  }

  /** Patch a group. Throws NOT_FOUND / INVALID_GROUP. */
  update(id, patch) {
    const doc = this._read();
    const i = doc.groups.findIndex((g) => g && g.id === id);
    if (i === -1) throw io.notFoundError(`group not found: ${id}`);

    const merged = applyDefaults({ ...doc.groups[i], ...patch, id });
    // Feature 150: the schedule is authoritative — the editor sends a complete
    // group, so a `schedule` absent from `patch` was turned off by the user; drop
    // it rather than inherit the stale stored rule through the shallow merge.
    if (!("schedule" in patch)) delete merged.schedule;
    const { valid, errors } = validateGroup(merged);
    if (!valid) throw invalidGroupError(errors);

    delete merged.order;
    doc.groups[i] = merged;
    this._writeGroups(doc, doc.groups);
    return this._view(merged, i);
  }

  /**
   * Remove a group. Not delete-guarded: any tunnel that referenced it falls back
   * to ungrouped (its `groupId` is cleared in the SAME write, so a dangling
   * reference can never be left behind). Throws NOT_FOUND for an unknown id.
   */
  delete(id) {
    const doc = this._read();
    const i = doc.groups.findIndex((g) => g && g.id === id);
    if (i === -1) throw io.notFoundError(`group not found: ${id}`);

    doc.groups.splice(i, 1);
    const tunnels = doc.tunnels.map((t) => {
      if (t && t.groupId === id) {
        const { groupId, ...rest } = t;
        void groupId; // dropped: this tunnel falls back to ungrouped
        return rest;
      }
      return t;
    });
    writeDoc(this._paths, { ...doc, groups: doc.groups, tunnels });
    return { id };
  }

  /**
   * Reorder groups to match `ids`. Ids not present are ignored; any existing group
   * missing from `ids` is appended after the listed ones in its current order, so
   * a stale/partial list can never drop a group. Returns the new renderer view.
   */
  reorder(ids) {
    const doc = this._read();
    const order = Array.isArray(ids) ? ids : [];
    const byId = new Map(doc.groups.map((g) => [g && g.id, g]));

    const next = [];
    const placed = new Set();
    for (const id of order) {
      const group = byId.get(id);
      if (group && !placed.has(id)) {
        next.push(group);
        placed.add(id);
      }
    }
    for (const group of doc.groups) {
      if (group && !placed.has(group.id)) next.push(group);
    }

    this._writeGroups(doc, next);
    return next.map((g, i) => this._view(g, i));
  }
}

/** Fill the default colour so a group created without one lands on the palette. */
function applyDefaults(group) {
  const out = { ...group };
  if (out.color === undefined || out.color === null)
    out.color = DEFAULT_GROUP_COLOR;
  return out;
}

module.exports = { GroupStore };
