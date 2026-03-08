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

const WINDOW_DURATION = {
    five_hour: 5 * 3600,
    seven_day: 7 * 86400,
    seven_day_sonnet: 7 * 86400,
};

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

        this._panelProgressBg = new St.Widget({
            style_class: 'claude-panel-progress-bg',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelProgressBar = new St.Widget({
            style_class: 'claude-panel-progress-bar',
        });
        this._panelProgressBg.add_child(this._panelProgressBar);
        this._box.add_child(this._panelProgressBg);

        this._label = new St.Label({
            text: '...',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'claude-usage-label',
        });
        this._box.add_child(this._label);

        this.add_child(this._box);

        this._createMenu();

        this._updateDisplayMode();
        this._updateIconVisibility();
        this._updateIconStyle();

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
            }
        });

        this._fiveHourResetsAt = null;
        this._sevenDayResetsAt = null;
        this._countdownTimerId = null;
        this._prevWasLimited = {five_hour: false, seven_day: false};

        this._refreshUsage();
        this._startTimer();
    }

    _updateDisplayMode() {
        const mode = this._settings.get_string('display-mode');
        if (mode === 'bar') {
            this._panelProgressBg.show();
            this._label.hide();
            this._label.set_style('margin-left: 0;');
        } else if (mode === 'both') {
            this._panelProgressBg.show();
            this._label.show();
            this._label.set_style('margin-left: 6px;');
        } else {
            this._panelProgressBg.hide();
            this._label.show();
            this._label.set_style('margin-left: 0;');
        }
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

    _createMenu() {
        const fiveHourBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({ vertical: false });
        const fiveHourLabel = new St.Label({
            text: '5-Hour Usage',
            style_class: 'claude-section-title',
        });
        fiveHourHeader.add_child(fiveHourLabel);
        this._fiveHourPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        fiveHourHeader.add_child(this._fiveHourPercent);
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        this._fiveHourProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        fiveHourProgressBg.add_child(this._fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        this._fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        fiveHourBox.add_child(this._fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const sevenDayBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({ vertical: false });
        const sevenDayLabel = new St.Label({
            text: '7-Day Usage',
            style_class: 'claude-section-title',
        });
        sevenDayHeader.add_child(sevenDayLabel);
        this._sevenDayPercent = new St.Label({
            text: '...',
            style_class: 'claude-percent-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
        });
        sevenDayHeader.add_child(this._sevenDayPercent);
        sevenDayBox.add_child(sevenDayHeader);

        const sevenDayProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        this._sevenDayProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        sevenDayProgressBg.add_child(this._sevenDayProgressBar);
        sevenDayBox.add_child(sevenDayProgressBg);

        this._sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        sevenDayBox.add_child(this._sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshUsage();
                return GLib.SOURCE_CONTINUE;
            }
        );
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

    _refreshUsage() {
        const configDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const credentialsPath = GLib.build_filenamev([
            configDir,
            '.credentials.json',
        ]);

        const file = Gio.File.new_for_path(credentialsPath);
        file.load_contents_async(null, (file, result) => {
            try {
                const [, contents] = file.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;

                if (!token) {
                    this._label.set_text('No token');
                    this._fiveHourPercent.set_text('No credentials');
                    this._sevenDayPercent.set_text('—');
                    return;
                }

                this._fetchUsage(token);
            } catch (e) {
                console.error('Claude Usage: Failed to read credentials:', e.message);
                this._label.set_text('No token');
                this._fiveHourPercent.set_text('No credentials');
                this._sevenDayPercent.set_text('—');
            }
        });
    }

    _fetchUsage(token) {
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
                        this._label.set_text('Error');
                        this._fiveHourPercent.set_text(`HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    this._updateDisplay(data);
                } catch (e) {
                    console.error('Claude Usage: Failed to fetch usage:', e.message);
                    this._label.set_text('Error');
                }
            }
        );
    }

    _projectRate(utilization, resetsAt, windowKey) {
        const windowDuration = WINDOW_DURATION[windowKey];
        if (!windowDuration || !resetsAt) {
            return {projected: utilization, color: 'normal'};
        }

        try {
            const resetDate = new Date(resetsAt);
            const now = new Date();
            const timeUntilReset = (resetDate - now) / 1000;
            const elapsed = windowDuration - timeUntilReset;

            if (elapsed < windowDuration * 0.05) {
                return {projected: utilization, color: 'normal'};
            }

            const projected = (utilization / elapsed) * windowDuration;

            if (projected > 100) {
                return {projected, color: 'critical'};
            } else if (projected > 90) {
                return {projected, color: 'warning'};
            } else {
                return {projected, color: 'normal'};
            }
        } catch (e) {
            return {projected: utilization, color: 'normal'};
        }
    }

    _updateDisplay(data) {
        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;
        const fiveHourResetsAt = data.five_hour?.resets_at;
        const sevenDayResetsAt = data.seven_day?.resets_at;

        this._fiveHourResetsAt = fiveHourResetsAt;
        this._sevenDayResetsAt = sevenDayResetsAt;

        const fiveHourProj = this._projectRate(fiveHour, fiveHourResetsAt, 'five_hour');
        const sevenDayProj = this._projectRate(sevenDay, sevenDayResetsAt, 'seven_day');

        this._label.set_text(`${Math.round(fiveHour)}%`);

        this._updatePanelProgressBar(fiveHour, fiveHourResetsAt, 'five_hour');

        let fiveHourText = `${fiveHour.toFixed(1)}%`;
        if (fiveHourProj.color !== 'normal') {
            fiveHourText += ` (proj: ${Math.round(fiveHourProj.projected)}%)`;
        }
        this._fiveHourPercent.set_text(fiveHourText);
        this._updateProgressBar(this._fiveHourProgressBar, fiveHour, fiveHourResetsAt, 'five_hour');

        let sevenDayText = `${sevenDay.toFixed(1)}%`;
        if (sevenDayProj.color !== 'normal') {
            sevenDayText += ` (proj: ${Math.round(sevenDayProj.projected)}%)`;
        }
        this._sevenDayPercent.set_text(sevenDayText);
        this._updateProgressBar(this._sevenDayProgressBar, sevenDay, sevenDayResetsAt, 'seven_day');

        this._checkForReset('five_hour', fiveHour);
        this._checkForReset('seven_day', sevenDay);

        this._prevWasLimited.five_hour = fiveHour >= 100;
        this._prevWasLimited.seven_day = sevenDay >= 100;

        this._updateCountdownLabels();
        this._scheduleCountdownTick();
    }

    _checkForReset(windowKey, currentUtilization) {
        if (this._prevWasLimited[windowKey] && currentUtilization < 80) {
            const label = windowKey === 'five_hour' ? '5-hour' : '7-day';
            this._notifyReset(label);
        }
    }

    _notifyReset(windowLabel) {
        try {
            Main.notify('Claude Usage', `${windowLabel} usage limit reset! You're good to go.`);
        } catch (e) {
            console.error('Claude Usage: Failed to show notification:', e.message);
        }
        this._playRacingBeep();
    }

    _playRacingBeep() {
        try {
            const script = `
                play_beep() {
                    timeout "$2" gst-launch-1.0 -q audiotestsrc freq="$1" ! audioconvert ! autoaudiosink 2>/dev/null
                }
                play_beep 880 0.3
                sleep 0.3
                play_beep 880 0.3
                sleep 0.3
                play_beep 880 0.3
                sleep 0.3
                play_beep 1320 0.9
            `;
            // Subprocess starts immediately; no need to await
            Gio.Subprocess.new(
                ['bash', '-c', script],
                Gio.SubprocessFlags.NONE
            );
        } catch (e) {
            console.error('Claude Usage: Failed to play sound:', e.message);
        }
    }

    _updateCountdownLabels() {
        if (this._fiveHourResetsAt) {
            const text = this._formatResetTime(this._fiveHourResetsAt);
            if (text === 'now') {
                this._fiveHourResetLabel.set_text('Resetting...');
            } else {
                this._fiveHourResetLabel.set_text(`Resets in ${text}`);
            }
        }

        if (this._sevenDayResetsAt) {
            const text = this._formatResetTime(this._sevenDayResetsAt);
            if (text === 'now') {
                this._sevenDayResetLabel.set_text('Resetting...');
            } else {
                this._sevenDayResetLabel.set_text(`Resets in ${text}`);
            }
        }
    }

    _stopCountdownTimer() {
        if (this._countdownTimerId) {
            GLib.source_remove(this._countdownTimerId);
            this._countdownTimerId = null;
        }
    }

    _scheduleCountdownTick() {
        this._stopCountdownTimer();

        const now = new Date();
        let minSecondsUntilReset = Infinity;

        for (const resetsAt of [this._fiveHourResetsAt, this._sevenDayResetsAt]) {
            if (!resetsAt) continue;
            try {
                const resetDate = new Date(resetsAt);
                const secsLeft = (resetDate - now) / 1000;
                if (secsLeft > 0 && secsLeft < minSecondsUntilReset) {
                    minSecondsUntilReset = secsLeft;
                }
            } catch (e) {
                // skip invalid dates
            }
        }

        if (minSecondsUntilReset === Infinity) {
            return;
        }

        if (minSecondsUntilReset <= 0) {
            this._updateCountdownLabels();
            if (this._prevWasLimited.five_hour) {
                this._notifyReset('5-hour');
                this._prevWasLimited.five_hour = false;
            }
            if (this._prevWasLimited.seven_day) {
                this._notifyReset('7-day');
                this._prevWasLimited.seven_day = false;
            }
            this._resetRefreshTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._resetRefreshTimerId = null;
                this._refreshUsage();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        if (minSecondsUntilReset <= 60) {
            this._countdownTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                1000,
                () => {
                    this._countdownTimerId = null;
                    this._updateCountdownLabels();
                    this._scheduleCountdownTick();
                    return GLib.SOURCE_REMOVE;
                }
            );
        } else {
            this._countdownTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                60,
                () => {
                    this._countdownTimerId = null;
                    this._updateCountdownLabels();
                    this._scheduleCountdownTick();
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    _updatePanelProgressBar(usage, resetsAt, windowKey) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);

        this._panelProgressBar.remove_style_class_name('usage-low');
        this._panelProgressBar.remove_style_class_name('usage-medium');
        this._panelProgressBar.remove_style_class_name('usage-high');
        this._panelProgressBar.remove_style_class_name('usage-critical');

        const {color} = this._projectRate(usage, resetsAt, windowKey);
        if (color === 'critical') {
            this._panelProgressBar.add_style_class_name('usage-critical');
        } else if (color === 'warning') {
            this._panelProgressBar.add_style_class_name('usage-medium');
        } else {
            this._panelProgressBar.add_style_class_name('usage-low');
        }
    }

    _updateProgressBar(progressBar, usage, resetsAt, windowKey) {
        const maxWidth = 200;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        progressBar.set_width(width);

        progressBar.remove_style_class_name('usage-low');
        progressBar.remove_style_class_name('usage-medium');
        progressBar.remove_style_class_name('usage-high');
        progressBar.remove_style_class_name('usage-critical');

        const {color} = this._projectRate(usage, resetsAt, windowKey);
        if (color === 'critical') {
            progressBar.add_style_class_name('usage-critical');
        } else if (color === 'warning') {
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

            const diffSecs = Math.floor(diffMs / 1000);
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMins / 60);
            const diffDays = Math.floor(diffHours / 24);

            if (diffDays > 0) {
                return `${diffDays}d ${diffHours % 24}h`;
            } else if (diffHours > 0) {
                return `${diffHours}h ${diffMins % 60}m`;
            } else if (diffMins > 0) {
                return `${diffMins}m ${diffSecs % 60}s`;
            } else {
                return `${diffSecs}s`;
            }
        } catch (e) {
            return '—';
        }
    }

    destroy() {
        this._stopTimer();
        this._stopCountdownTimer();
        if (this._resetRefreshTimerId) {
            GLib.source_remove(this._resetRefreshTimerId);
            this._resetRefreshTimerId = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
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
