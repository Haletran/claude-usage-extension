import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const API_URL = 'https://api.anthropic.com/api/oauth/usage';

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Claude Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();

        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        const iconPath = GLib.build_filenamev([this._extensionPath, 'claude-icon-22.png']);
        const gicon = Gio.icon_new_for_string(iconPath);
        this._icon = new St.Icon({
            gicon: gicon,
            style_class: 'claude-icon',
            icon_size: 16,
        });
        this._box.add_child(this._icon);

        this._panelDataBox = new St.BoxLayout({
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._panelDataBox);

        this.add_child(this._box);

        this._panelUIs = {};
        this._profileUIs = [];
        this._backoffLevel = 0;
        this._pendingFetches = 0;
        this._isLocked = false;
        this._cycleHadError = false;
        this._destroyed = false;

        // File-activity-driven refresh state.
        this._fileMonitors = [];
        // Per-profile debounce: { [profileIndex]: { debounceId, maxWaitId, lastRefreshMs } }
        this._profileTimers = {};

        this._settingsChangedId = this._settings.connect('changed', (settings, key) => {
            if (key === 'refresh-interval') {
                this._restartTimer();
            } else if (key === 'display-mode') {
                this._updateDisplayMode();
            } else if (key === 'show-icon') {
                this._updateIconVisibility();
            } else if (key === 'proxy-url') {
                this._recreateSession();
            } else if (key === 'icon-style') {
                this._updateIconStyle();
            } else if (key === 'profiles') {
                this._clearAllProfileTimers();
                this._rebuildUI();
                this._setupFileMonitors();
                this._refreshUsage();
            } else if (key === 'debounce-delay' || key === 'debounce-min-interval') {
                this._clearAllProfileTimers();
            } else if (key === 'file-monitoring-enabled') {
                this._clearAllProfileTimers();
                this._setupFileMonitors();
            }
        });

        // Build the panel widgets immediately so the icon shows up, but defer
        // everything that touches DBus / disk / network to an idle callback so
        // enable() returns instantly and never blocks session startup.
        this._rebuildUI();
        this._updateIconVisibility();
        this._updateIconStyle();

        // Refresh "Last updated: Xm ago" strings each time the popup opens.
        this.menu.connect('open-state-changed', (menu, open) => {
            if (open) this._refreshAllLastUpdatedLabels();
        });

        this._initId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._initId = 0;
            if (this._destroyed) {
                return GLib.SOURCE_REMOVE;
            }
            this._setupIdleMonitor();
            this._setupFileMonitors();
            this._refreshUsage();
            this._startTimer();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getProfiles() {
        try {
            const profiles = JSON.parse(this._settings.get_string('profiles'));
            if (Array.isArray(profiles) && profiles.length > 0) {
                return profiles;
            }
        } catch (e) {
            // fall through to default
        }
        return [{ name: 'Default', path: '~/.claude', showInPanel: true }];
    }

    _expandPath(path) {
        if (path === '~') {
            return GLib.get_home_dir();
        }
        if (path.startsWith('~/')) {
            return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
        }
        return path;
    }

    _rebuildUI() {
        const profiles = this._getProfiles();
        this._buildProfilesMenu(profiles);
        this._buildPanelUIs(profiles);
    }

    _setupIdleMonitor() {
        // Pause polling while the session is locked / the screensaver is active.
        // Build the proxy ASYNCHRONOUSLY: during login the ScreenSaver service
        // may not be up yet, and a synchronous init() would block the shell's
        // main thread (stalling session startup).
        Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null,
            'org.gnome.ScreenSaver',
            '/org/gnome/ScreenSaver',
            'org.gnome.ScreenSaver',
            null,
            (source, result) => {
                try {
                    this._screenSaverProxy = Gio.DBusProxy.new_finish(result);
                } catch (e) {
                    console.error('Claude Usage: Failed to set up idle monitor:', e.message);
                    this._screenSaverProxy = null;
                    return;
                }

                if (this._destroyed) {
                    return;
                }

                this._screenSaverSignalId = this._screenSaverProxy.connectSignal(
                    'ActiveChanged',
                    (proxy, sender, [active]) => {
                        this._isLocked = active;
                        if (active) {
                            // Stop all work while locked.
                            this._stopTimer();
                            this._teardownFileMonitors();
                            this._clearAllProfileTimers();
                        } else {
                            // Resume: refresh immediately, restart the timer, and
                            // re-attach the file monitors.
                            this._refreshUsage();
                            this._restartTimer();
                            this._setupFileMonitors();
                        }
                    }
                );
            }
        );
    }

    // --- File-activity-driven refresh ---------------------------------------
    //
    // Claude Code appends to session transcripts under
    // <config>/projects/<project>/*.jsonl while you work. We watch those
    // directories and treat any change as "active usage". A change starts a
    // debounce timer; when activity goes quiet for <debounce-delay> seconds we
    // do a single refresh. A max-wait ceiling guarantees that even during
    // continuous activity we still refresh at least once per interval.
    //
    // inotify is not recursive, so we attach a monitor to projects/ itself
    // (to catch new project dirs) and to each existing project subdirectory.

    _setupFileMonitors() {
        this._teardownFileMonitors();

        if (this._isLocked) {
            return;
        }

        if (!this._settings.get_boolean('file-monitoring-enabled')) {
            return;
        }

        const profiles = this._getProfiles();
        profiles.forEach((profile, profileIndex) => {
            const projectsDir = GLib.build_filenamev([
                this._expandPath(profile.path),
                'projects',
            ]);
            this._watchDir(projectsDir, profileIndex);
            this._watchSubdirsAsync(projectsDir, profileIndex);
        });
    }

    _watchSubdirsAsync(projectsDir, profileIndex) {
        // Watch each immediate subdirectory where the .jsonl files live.
        // Done asynchronously so we never block the main thread on disk I/O.
        const dir = Gio.File.new_for_path(projectsDir);
        dir.enumerate_children_async(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW,
            null,
            (source, result) => {
                if (this._destroyed) return;
                let enumerator;
                try {
                    enumerator = dir.enumerate_children_finish(result);
                } catch (e) {
                    // projects/ may not exist yet; the monitor on it will pick
                    // up new dirs once they appear.
                    return;
                }
                this._processEnumeratorBatch(projectsDir, enumerator, profileIndex);
            }
        );
    }

    _processEnumeratorBatch(projectsDir, enumerator, profileIndex) {
        enumerator.next_files_async(
            32,
            GLib.PRIORITY_LOW,
            null,
            (source, result) => {
                if (this._destroyed) {
                    enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                    return;
                }
                let infos;
                try {
                    infos = enumerator.next_files_finish(result);
                } catch (e) {
                    enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                    return;
                }

                if (infos.length === 0) {
                    enumerator.close_async(GLib.PRIORITY_LOW, null, null);
                    return;
                }

                for (const info of infos) {
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        this._watchDir(GLib.build_filenamev([projectsDir, info.get_name()]), profileIndex);
                    }
                }

                // Continue with the next batch.
                this._processEnumeratorBatch(projectsDir, enumerator, profileIndex);
            }
        );
    }

    _watchDir(path, profileIndex) {
        try {
            const file = Gio.File.new_for_path(path);
            const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', (mon, changedFile, otherFile, eventType) => {
                this._onFileActivity(path, changedFile, eventType, profileIndex);
            });
            this._fileMonitors.push(monitor);
        } catch (e) {
            // Directory might not exist; ignore.
        }
    }

    _onFileActivity(parentPath, changedFile, eventType, profileIndex) {
        // If a new project directory was created, start watching it too so we
        // see the .jsonl writes that follow. Done asynchronously to avoid
        // blocking the shell's main thread on slow or network filesystems.
        if (eventType === Gio.FileMonitorEvent.CREATED && changedFile) {
            changedFile.query_info_async(
                'standard::type',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                null,
                (f, result) => {
                    try {
                        const info = f.query_info_finish(result);
                        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                            this._watchDir(f.get_path(), profileIndex);
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            );
        }

        this._scheduleActivityRefresh(profileIndex);
    }

    _scheduleActivityRefresh(profileIndex) {
        if (this._isLocked) return;

        const state = this._getProfileTimerState(profileIndex);
        const delaySecs = this._settings.get_int('debounce-delay');
        const minIntervalSecs = this._settings.get_int('debounce-min-interval');

        // Reset the quiet-period debounce on every activity tick.
        if (state.debounceId) {
            GLib.source_remove(state.debounceId);
            state.debounceId = 0;
        }

        state.debounceId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            delaySecs,
            () => {
                state.debounceId = 0;
                // Clear the max-wait ceiling since we're about to refresh.
                if (state.maxWaitId) {
                    GLib.source_remove(state.maxWaitId);
                    state.maxWaitId = 0;
                }

                // Enforce minimum interval between consecutive debounce refreshes.
                const nowMs = Date.now();
                const elapsedSecs = (nowMs - state.lastRefreshMs) / 1000;
                if (state.lastRefreshMs > 0 && elapsedSecs < minIntervalSecs) {
                    const remainSecs = Math.ceil(minIntervalSecs - elapsedSecs);
                    state.debounceId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT,
                        remainSecs,
                        () => {
                            state.debounceId = 0;
                            state.lastRefreshMs = Date.now();
                            this._refreshSingleProfile(profileIndex);
                            return GLib.SOURCE_REMOVE;
                        }
                    );
                    return GLib.SOURCE_REMOVE;
                }

                state.lastRefreshMs = Date.now();
                this._refreshSingleProfile(profileIndex);
                return GLib.SOURCE_REMOVE;
            }
        );

        // Ceiling: if activity never goes quiet, still refresh at least once
        // per refresh-interval so the displayed usage doesn't lag.
        if (!state.maxWaitId) {
            const interval = this._settings.get_int('refresh-interval');
            state.maxWaitId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                interval,
                () => {
                    state.maxWaitId = 0;
                    if (state.debounceId) {
                        GLib.source_remove(state.debounceId);
                        state.debounceId = 0;
                    }
                    state.lastRefreshMs = Date.now();
                    this._refreshSingleProfile(profileIndex);
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _getProfileTimerState(profileIndex) {
        if (!this._profileTimers[profileIndex]) {
            this._profileTimers[profileIndex] = { debounceId: 0, maxWaitId: 0, lastRefreshMs: 0 };
        }
        return this._profileTimers[profileIndex];
    }

    _clearAllProfileTimers() {
        for (const state of Object.values(this._profileTimers)) {
            if (state.debounceId) GLib.source_remove(state.debounceId);
            if (state.maxWaitId) GLib.source_remove(state.maxWaitId);
        }
        this._profileTimers = {};
    }

    _teardownFileMonitors() {
        for (const monitor of this._fileMonitors) {
            monitor.cancel();
        }
        this._fileMonitors = [];
    }

    _buildPanelUIs(profiles) {
        this._panelDataBox.destroy_all_children();
        // Keyed by profile index; entries for hidden profiles stay undefined.
        this._panelUIs = {};

        const visibleProfiles = profiles.filter(p => p.showInPanel !== false);
        const showNames = visibleProfiles.length > 1;

        let visibleIndex = 0;
        profiles.forEach((profile, index) => {
            if (profile.showInPanel === false) return;

            const container = new St.BoxLayout({ vertical: false, y_align: Clutter.ActorAlign.CENTER });

            let nameLabel = null;
            if (showNames) {
                nameLabel = new St.Label({
                    text: `${profile.name}: `,
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'claude-usage-label',
                    style: 'margin-right: 2px;'
                });
                container.add_child(nameLabel);
            }

            const panelProgressBg = new St.Widget({
                style_class: 'claude-panel-progress-bg',
                y_align: Clutter.ActorAlign.CENTER,
            });
            const panelProgressBar = new St.Widget({
                style_class: 'claude-panel-progress-bar',
            });
            panelProgressBg.add_child(panelProgressBar);
            container.add_child(panelProgressBg);

            const label = new St.Label({
                text: '...',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'claude-usage-label',
            });
            container.add_child(label);

            this._panelDataBox.add_child(container);

            if (visibleIndex < visibleProfiles.length - 1) {
                const separator = new St.Label({
                    text: ' • ',
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'claude-usage-label',
                    style: 'margin-left: 6px; margin-right: 6px;'
                });
                this._panelDataBox.add_child(separator);
            }

            this._panelUIs[index] = {
                nameLabel,
                panelProgressBg,
                panelProgressBar,
                label
            };

            visibleIndex++;
        });

        this._updateDisplayMode();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        Object.values(this._panelUIs).forEach(ui => {
            if (!ui) return;
            if (mode === 'bar') {
                ui.panelProgressBg.show();
                ui.label.hide();
                ui.label.set_style('margin-left: 0;');
            } else if (mode === 'both') {
                ui.panelProgressBg.show();
                ui.label.show();
                ui.label.set_style('margin-left: 6px;');
            } else {
                ui.panelProgressBg.hide();
                ui.label.show();
                ui.label.set_style('margin-left: 0;');
            }
        });
    }

    _updateIconVisibility() {
        const showIcon = this._settings.get_boolean('show-icon');
        if (showIcon) {
            this._icon.show();
        } else {
            this._icon.hide();
        }
    }

    _createSession() {
        const session = new Soup.Session();
        const proxyUrl = this._settings.get_string('proxy-url');

        if (proxyUrl && proxyUrl.trim() !== '') {
            const proxyResolver = Gio.SimpleProxyResolver.new(proxyUrl.trim(), null);
            session.set_proxy_resolver(proxyResolver);
        }

        return session;
    }

    _recreateSession() {
        if (this._session) {
            this._session.abort();
        }
        this._session = this._createSession();
        this._refreshUsage();
	}
    _updateIconStyle() {
        const style = this._settings.get_string('icon-style');
        const desatName = 'monochrome-desaturate';
        const brightName = 'monochrome-brightness';
        const hasEffect = this._icon.get_effect(desatName) !== null;

        if (style === 'monochrome' && !hasEffect) {
            this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: desatName}));
            const brightnessEffect = new Clutter.BrightnessContrastEffect({name: brightName});
            brightnessEffect.set_brightness_full(1, 1, 1);
            this._icon.add_effect(brightnessEffect);
        } else if (style !== 'monochrome' && hasEffect) {
            this._icon.remove_effect_by_name(desatName);
            this._icon.remove_effect_by_name(brightName);
        }
    }

    _buildProfilesMenu(profiles) {
        this.menu.removeAll();

        this._profileUIs = [];

        for (const profile of profiles) {
            const profileItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });

            const profileBox = new St.BoxLayout({
                style_class: 'claude-usage-section',
                vertical: true,
            });

            const nameLabel = new St.Label({
                text: profile.name,
                style_class: 'claude-section-title',
                style: 'font-weight: bold; margin-bottom: 8px;'
            });
            profileBox.add_child(nameLabel);

            const fiveHourHeader = new St.BoxLayout({ vertical: false });
            const fiveHourLabel = new St.Label({
                text: '5-Hour Usage',
                style_class: 'claude-section-title',
            });
            fiveHourHeader.add_child(fiveHourLabel);
            const fiveHourPercent = new St.Label({
                text: '...',
                style_class: 'claude-percent-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            fiveHourHeader.add_child(fiveHourPercent);
            profileBox.add_child(fiveHourHeader);

            const fiveHourProgressBg = new St.Widget({
                style_class: 'claude-progress-bg',
            });
            const fiveHourProgressBar = new St.Widget({
                style_class: 'claude-progress-bar usage-low',
            });
            fiveHourProgressBg.add_child(fiveHourProgressBar);
            profileBox.add_child(fiveHourProgressBg);

            const fiveHourResetLabel = new St.Label({
                text: 'Resets: ...',
                style_class: 'claude-reset-label',
            });
            profileBox.add_child(fiveHourResetLabel);

            const sevenDayHeader = new St.BoxLayout({ vertical: false, style: 'margin-top: 8px;' });
            const sevenDayLabel = new St.Label({
                text: '7-Day Usage',
                style_class: 'claude-section-title',
            });
            sevenDayHeader.add_child(sevenDayLabel);
            const sevenDayPercent = new St.Label({
                text: '...',
                style_class: 'claude-percent-label',
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
            });
            sevenDayHeader.add_child(sevenDayPercent);
            profileBox.add_child(sevenDayHeader);

            const sevenDayProgressBg = new St.Widget({
                style_class: 'claude-progress-bg',
            });
            const sevenDayProgressBar = new St.Widget({
                style_class: 'claude-progress-bar usage-low',
            });
            sevenDayProgressBg.add_child(sevenDayProgressBar);
            profileBox.add_child(sevenDayProgressBg);

            const sevenDayResetLabel = new St.Label({
                text: 'Resets: ...',
                style_class: 'claude-reset-label',
            });
            profileBox.add_child(sevenDayResetLabel);

            const lastUpdatedLabel = new St.Label({
                text: 'Last updated: never',
                style_class: 'claude-reset-label',
                style: 'margin-top: 6px; opacity: 0.7;'
            });
            profileBox.add_child(lastUpdatedLabel);

            profileItem.add_child(profileBox);
            this.menu.addMenuItem(profileItem);
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._profileUIs.push({
                fiveHourPercent,
                fiveHourProgressBar,
                fiveHourResetLabel,
                sevenDayPercent,
                sevenDayProgressBar,
                sevenDayResetLabel,
                lastUpdatedLabel,
                lastUpdatedMs: 0,
            });
        }

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _getNextInterval() {
        const base = this._settings.get_int('refresh-interval');
        if (this._backoffLevel <= 0) {
            return base;
        }
        // Exponential backoff capped at 10x base (or 15 min, whichever is lower).
        const factor = Math.min(2 ** this._backoffLevel, 10);
        return Math.min(base * factor, 900);
    }

    _scheduleNext() {
        this._stopTimer();

        if (this._isLocked) {
            return;
        }

        const interval = this._getNextInterval();
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._timerId = null;
                this._refreshUsage();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _startTimer() {
        this._scheduleNext();
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    _refreshSingleProfile(profileIndex) {
        this._refreshUsage([profileIndex]);
    }

    _refreshUsage(profileIndices = null) {
        // Don't poll while locked; the idle monitor will refresh on unlock.
        if (this._isLocked) return;

        // Avoid overlapping refresh cycles.
        if (this._pendingFetches > 0) return;

        const profiles = this._getProfiles();
        const indices = profileIndices ?? profiles.map((_, i) => i);

        if (indices.length === 0) {
            this._scheduleNext();
            return;
        }

        this._pendingFetches = indices.length;
        this._cycleHadError = false;

        for (const index of indices) {
            const profile = profiles[index];
            if (!profile) {
                this._checkFetchesComplete();
                continue;
            }

            const credentialsPath = GLib.build_filenamev([
                this._expandPath(profile.path),
                '.credentials.json',
            ]);

            const file = Gio.File.new_for_path(credentialsPath);
            file.load_contents_async(null, (f, result) => {
                try {
                    const [, contents] = f.load_contents_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const json = JSON.parse(decoder.decode(contents));
                    const token = json.claudeAiOauth?.accessToken;

                    if (!token) {
                        this._updateProfileDisplay(index, null, 'No token');
                        this._cycleHadError = true;
                        this._checkFetchesComplete();
                        return;
                    }

                    this._fetchUsage(token, index);
                } catch (e) {
                    console.error(`Claude Usage: Failed to read credentials for ${profile.name}:`, e.message);
                    this._updateProfileDisplay(index, null, 'No credentials');
                    this._cycleHadError = true;
                    this._checkFetchesComplete();
                }
            });
        }
    }

    _fetchUsage(token, index) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code !== 200) {
                        // For rate-limit (429), keep showing the previous data
                        // rather than clobbering it with an error. Backoff still
                        // grows so we don't hammer the API.
                        if (message.status_code !== 429) {
                            this._updateProfileDisplay(index, null, `HTTP ${message.status_code}`);
                        }
                        this._cycleHadError = true;
                        this._checkFetchesComplete();
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._updateProfileDisplay(index, data);
                } catch (e) {
                    console.error('Claude Usage: Failed to fetch usage:', e.message);
                    this._updateProfileDisplay(index, null, 'Error');
                    this._cycleHadError = true;
                }
                this._checkFetchesComplete();
            }
        );
    }

    _updateProfileDisplay(index, data, errorMsg = null) {
        if (!this._profileUIs || !this._profileUIs[index]) return;
        const ui = this._profileUIs[index];
        const panelUi = this._panelUIs && this._panelUIs[index] ? this._panelUIs[index] : null;

        if (errorMsg) {
            ui.fiveHourPercent.set_text(errorMsg);
            ui.sevenDayPercent.set_text('—');
            if (panelUi) {
                panelUi.label.set_text(errorMsg === 'No token' ? 'No token' : 'Err');
                this._updatePanelProgressBar(panelUi.panelProgressBar, 0);
            }
            return;
        }

        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;

        ui.fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(ui.fiveHourProgressBar, fiveHour);

        ui.sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(ui.sevenDayProgressBar, sevenDay);

        if (data.five_hour?.resets_at) {
            ui.fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        }

        if (data.seven_day?.resets_at) {
            ui.sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        }

        if (panelUi) {
            panelUi.label.set_text(`${Math.round(fiveHour)}%`);
            this._updatePanelProgressBar(panelUi.panelProgressBar, fiveHour);
        }

        ui.lastUpdatedMs = Date.now();
        this._refreshLastUpdatedLabel(ui);
    }

    _refreshLastUpdatedLabel(ui) {
        if (!ui.lastUpdatedLabel) return;
        if (!ui.lastUpdatedMs) {
            ui.lastUpdatedLabel.set_text('Last updated: never');
            return;
        }
        ui.lastUpdatedLabel.set_text(`Last updated: ${this._formatRelativePast(ui.lastUpdatedMs)}`);
    }

    _refreshAllLastUpdatedLabels() {
        for (const ui of this._profileUIs) {
            this._refreshLastUpdatedLabel(ui);
        }
    }

    _formatRelativePast(timestampMs) {
        const diffSecs = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
        if (diffSecs < 60) return '<1m ago';
        const diffMins = Math.floor(diffSecs / 60);
        if (diffMins < 60) return `${diffMins}m ago`;
        const diffHours = Math.floor(diffMins / 60);
        if (diffHours < 24) return `${diffHours}h ${diffMins % 60}m ago`;
        const diffDays = Math.floor(diffHours / 24);
        return `${diffDays}d ${diffHours % 24}h ago`;
    }

    _checkFetchesComplete() {
        this._pendingFetches--;
        if (this._pendingFetches > 0) {
            return;
        }

        // Whole cycle is done. Adjust backoff based on the outcome, then
        // schedule the next poll. Backoff grows on error and resets on success.
        if (this._cycleHadError) {
            this._backoffLevel = Math.min(this._backoffLevel + 1, 5);
        } else {
            this._backoffLevel = 0;
        }

        this._scheduleNext();
    }

    _updatePanelProgressBar(progressBar, usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);
    }

    _updateProgressBar(progressBar, usage) {
        const maxWidth = 200;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        if (usage >= 90) {
            progressBar.add_style_class_name('usage-critical');
        } else if (usage >= 70) {
            progressBar.add_style_class_name('usage-high');
        } else if (usage >= 40) {
            progressBar.add_style_class_name('usage-medium');
        } else {
            progressBar.add_style_class_name('usage-low');
        }
    }

    _formatResetTime(isoString) {
        try {
            const resetDate = new Date(isoString);
            const now = new Date();
            const diffMs = resetDate - now;

            if (diffMs < 0) {
                return 'now';
            }

            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else {
                return `${diffMins}m`;
            }
        } catch (e) {
            return '—';
        }
    }

    destroy() {
        this._destroyed = true;
        if (this._initId) {
            GLib.source_remove(this._initId);
            this._initId = 0;
        }
        this._stopTimer();
        this._clearAllProfileTimers();
        this._teardownFileMonitors();
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._screenSaverProxy && this._screenSaverSignalId) {
            this._screenSaverProxy.disconnectSignal(this._screenSaverSignalId);
            this._screenSaverSignalId = null;
        }
        this._screenSaverProxy = null;
        super.destroy();
    }
});

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new ClaudeUsageIndicator(
            this.path,
            this._settings,
            () => this.openPreferences()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
