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

// update-notifier.js — surface the auto-update lifecycle (Feature 70). The main
// process runs the checks and download; it pushes each lifecycle event over the
// `porthippo:update-*` events (preload re-dispatches the `updater:*` channels).
// This module turns those into user-facing prompts: quiet toasts for a manual
// check, and — whenever a build has downloaded — a "restart to install" confirm
// that calls `updater.install()`. Silent startup checks stay silent (the `manual`
// flag), so the only unprompted UI is the ready-to-install offer.

import { PopupManager } from "./popup-manager.js";
import { t } from "./i18n.js";

export class UpdateNotifier {
  #porthippo;
  #handlers;

  constructor({ porthippo } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#handlers = {
      "porthippo:update-available": (e) => this.#onAvailable(e.detail),
      "porthippo:update-not-available": (e) => this.#onNotAvailable(e.detail),
      "porthippo:update-downloaded": (e) => this.#onDownloaded(e.detail),
      "porthippo:update-error": (e) => this.#onError(e.detail),
    };
  }

  install() {
    for (const [evt, fn] of Object.entries(this.#handlers)) {
      window.addEventListener(evt, fn);
    }
    return this;
  }

  uninstall() {
    for (const [evt, fn] of Object.entries(this.#handlers)) {
      window.removeEventListener(evt, fn);
    }
  }

  // An update was found; autoDownload pulls it in the background. Only tell the
  // user when THEY asked (a manual check) — silent startup checks stay quiet.
  #onAvailable(info) {
    if (!info?.manual) return;
    PopupManager.notify({
      title: t("update.title"),
      message: t("update.available", { version: info.version || "" }),
    });
  }

  #onNotAvailable(info) {
    if (!info?.manual) return;
    PopupManager.notify({
      title: t("update.title"),
      message:
        info.reason === "dev-build"
          ? t("update.devBuild")
          : t("update.upToDate"),
    });
  }

  // A downloaded update is ready — always offer to restart (the only path that
  // applies it now; otherwise it installs on the next normal quit).
  #onDownloaded(info) {
    PopupManager.confirm({
      title: t("update.ready.title"),
      message: t("update.ready.message", { version: info?.version || "" }),
      confirmLabel: t("update.ready.restart"),
      cancelLabel: t("update.ready.later"),
      onConfirm: () => this.#porthippo?.updater?.install?.(),
    });
  }

  #onError(info) {
    if (!info?.manual) return;
    PopupManager.notify({
      title: t("update.title"),
      message: t("update.error", { message: info?.message || "" }),
      okClass: "btn--danger",
    });
  }
}
