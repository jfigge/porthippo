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

// host-key-prompt.js — app-wide SSH host-key (TOFU) mediation. The engine can't
// decide trust on its own, so on an unknown key it broadcasts
// `porthippo:hostkey-unknown` and holds the connection pending until the renderer
// answers via `hostkeys.trust(promptId)` / `hostkeys.reject(promptId)`. This
// module turns that broadcast into a PopupManager confirm; a *changed* key
// (`porthippo:hostkey-changed`) is a hard reject already made by the engine, so it
// only warns. It is app-wide state any panel might care about, so it lives here
// rather than inside the Definition view.

import { PopupManager } from "./popup-manager.js";
import { t } from "./i18n.js";

export class HostKeyPrompt {
  #porthippo;
  #onUnknown;
  #onChanged;

  constructor({ porthippo } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#onUnknown = (e) => this.#promptUnknown(e.detail);
    this.#onChanged = (e) => this.#warnChanged(e.detail);
  }

  install() {
    window.addEventListener("porthippo:hostkey-unknown", this.#onUnknown);
    window.addEventListener("porthippo:hostkey-changed", this.#onChanged);
    return this;
  }

  uninstall() {
    window.removeEventListener("porthippo:hostkey-unknown", this.#onUnknown);
    window.removeEventListener("porthippo:hostkey-changed", this.#onChanged);
  }

  #promptUnknown(info) {
    if (!info || !info.promptId) return;
    const { promptId, host, port, fingerprint, hop } = info;
    const noteParts = [`${t("hostkey.fingerprint")}: ${fingerprint || "—"}`];
    if (hop) noteParts.push(t("hostkey.hop", { hop }));

    PopupManager.confirm({
      title: t("hostkey.unknown.title"),
      message: `${t("hostkey.unknown.message", { host, port })} ${t(
        "hostkey.unknown.question",
      )}`,
      note: noteParts.join(" · "),
      confirmLabel: t("common.trust"),
      cancelLabel: t("common.reject"),
      confirmClass: "btn--primary",
      onConfirm: () => this.#porthippo?.hostkeys?.trust?.(promptId),
      onCancel: () => this.#porthippo?.hostkeys?.reject?.(promptId),
    });
  }

  #warnChanged(info) {
    const host = info?.host ?? "?";
    const port = info?.port ?? "?";
    PopupManager.notify({
      title: t("hostkey.changed.title"),
      message: t("hostkey.changed.message", { host, port }),
      okLabel: t("common.dismiss"),
      okClass: "btn--danger",
    });
  }
}
