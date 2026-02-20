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

class AccountState {
    constructor(id, label, configDir) {
        this.id = id;
        this.label = label;
        this.configDir = configDir;
        this.credentialsPath = GLib.build_filenamev([configDir, '.credentials.json']);
        this.cachedData = null;
        this.isTokenExpired = false;
        this.fileMonitor = null;
        this.fileMonitorSignalId = null;
        this.debounceTimerId = null;
        this.menuWidgets = null;
    }

    destroy() {
        if (this.debounceTimerId) {
            GLib.source_remove(this.debounceTimerId);
            this.debounceTimerId = null;
        }
        if (this.fileMonitorSignalId && this.fileMonitor) {
            this.fileMonitor.disconnect(this.fileMonitorSignalId);
            this.fileMonitorSignalId = null;
        }
        if (this.fileMonitor) {
            this.fileMonitor.cancel();
            this.fileMonitor = null;
        }
        this.cachedData = null;
        this.menuWidgets = null;
    }
}

const ClaudeUsageIndicator = GObject.registerClass(
class ClaudeUsageIndicator extends PanelMenu.Button {
    _init(extensionPath, settings, openPreferences) {
        super._init(0.0, 'Claude Usage Indicator');

        this._extensionPath = extensionPath;
        this._settings = settings;
        this._openPreferences = openPreferences;
        this._session = this._createSession();
        this._accounts = [];
        this._allTokensExpired = false;

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
            } else if (key === 'hide-on-expired') {
                this._updateExpiredVisibility();
            } else if (key === 'extra-accounts' || key === 'account-labels') {
                this._rebuildAccounts();
            } else if (key === 'panel-account-mode' || key === 'pinned-accounts') {
                this._updatePanelFromAccounts();
            }
        });

        this._rebuildAccounts();
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
        this._refreshAllAccounts();
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

    // --- Account discovery ---

    _discoverAccounts() {
        const seen = new Set();
        const results = [];

        // Default account
        const defaultDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const defaultResolved = Gio.File.new_for_path(defaultDir).get_path();
        seen.add(defaultResolved);
        results.push({id: 'default', label: 'default', configDir: defaultResolved});

        // Auto-scan: ~/.claude-*/ directories with .credentials.json
        try {
            const homeDir = Gio.File.new_for_path(GLib.get_home_dir());
            const enumerator = homeDir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE,
                null
            );

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;
                if (!name.match(/^\.claude-.+$/))
                    continue;

                const dirPath = GLib.build_filenamev([GLib.get_home_dir(), name]);
                const resolved = Gio.File.new_for_path(dirPath).get_path();
                if (seen.has(resolved))
                    continue;

                const credFile = Gio.File.new_for_path(
                    GLib.build_filenamev([dirPath, '.credentials.json'])
                );
                if (!credFile.query_exists(null))
                    continue;

                seen.add(resolved);
                const label = name.replace(/^\./, '');
                results.push({id: label, label, configDir: resolved});
            }
            enumerator.close(null);
        } catch (e) {
            console.error('Claude Usage: Failed to scan home directory:', e.message);
        }

        // Manual extra accounts from settings
        const extraAccounts = this._settings.get_strv('extra-accounts');
        for (const dirPath of extraAccounts) {
            const resolved = Gio.File.new_for_path(dirPath).get_path();
            if (seen.has(resolved))
                continue;

            const credFile = Gio.File.new_for_path(
                GLib.build_filenamev([resolved, '.credentials.json'])
            );
            if (!credFile.query_exists(null))
                continue;

            seen.add(resolved);
            const baseName = GLib.path_get_basename(resolved).replace(/^\./, '');
            results.push({id: baseName, label: baseName, configDir: resolved});
        }

        // Apply custom labels
        const accountLabels = this._settings.get_strv('account-labels');
        for (const entry of accountLabels) {
            const sepIdx = entry.indexOf('|');
            if (sepIdx === -1)
                continue;
            const path = entry.substring(0, sepIdx);
            const customLabel = entry.substring(sepIdx + 1);
            const resolvedPath = Gio.File.new_for_path(path).get_path();
            const account = results.find(a => a.configDir === resolvedPath);
            if (account)
                account.label = customLabel;
        }

        // Sort: default first, then alphabetical by label
        results.sort((a, b) => {
            if (a.id === 'default') return -1;
            if (b.id === 'default') return 1;
            return a.label.localeCompare(b.label);
        });

        return results;
    }

    // --- Account lifecycle ---

    _rebuildAccounts() {
        for (const account of this._accounts) {
            account.destroy();
        }
        this._accounts = [];

        const discovered = this._discoverAccounts();
        for (const info of discovered) {
            const account = new AccountState(info.id, info.label, info.configDir);
            this._startAccountMonitor(account);
            this._accounts.push(account);
        }

        this._rebuildMenu();
        this._refreshAllAccounts();
    }

    // --- File monitoring per account ---

    _startAccountMonitor(account) {
        try {
            const file = Gio.File.new_for_path(account.credentialsPath);
            account.fileMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            account.fileMonitorSignalId = account.fileMonitor.connect(
                'changed',
                (monitor, changedFile, otherFile, eventType) => {
                    if (eventType === Gio.FileMonitorEvent.CHANGED ||
                        eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
                        this._debouncedRefreshAccount(account);
                    }
                }
            );
        } catch (e) {
            console.error(`Claude Usage: Failed to monitor ${account.credentialsPath}:`, e.message);
        }
    }

    _debouncedRefreshAccount(account) {
        if (account.debounceTimerId) {
            GLib.source_remove(account.debounceTimerId);
            account.debounceTimerId = null;
        }
        account.debounceTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            account.debounceTimerId = null;
            if (this._accounts.includes(account))
                this._refreshAccount(account);
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Polling ---

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refreshAllAccounts();
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

    _refreshAllAccounts() {
        this._accounts.forEach((account, index) => {
            if (index === 0) {
                this._refreshAccount(account);
            } else {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, index * 200, () => {
                    if (this._accounts.includes(account))
                        this._refreshAccount(account);
                    return GLib.SOURCE_REMOVE;
                });
            }
        });
    }

    _refreshAccount(account) {
        if (!this._accounts.includes(account))
            return;

        const file = Gio.File.new_for_path(account.credentialsPath);
        file.load_contents_async(null, (f, result) => {
            if (!this._accounts.includes(account))
                return;

            try {
                const [, contents] = f.load_contents_finish(result);
                const decoder = new TextDecoder('utf-8');
                const json = JSON.parse(decoder.decode(contents));
                const token = json.claudeAiOauth?.accessToken;

                if (!token) {
                    this._setAccountNoToken(account);
                    this._updatePanelFromAccounts();
                    return;
                }

                this._fetchAccountUsage(account, token);
            } catch (e) {
                console.error(`Claude Usage: Failed to read credentials for ${account.id}:`, e.message);
                this._setAccountNoToken(account);
                this._updatePanelFromAccounts();
            }
        });
    }

    _setAccountNoToken(account) {
        if (!account.menuWidgets)
            return;
        account.menuWidgets.fiveHourPercent.set_text('No credentials');
        account.menuWidgets.sevenDayPercent.set_text('—');
    }

    _fetchAccountUsage(account, token) {
        const message = Soup.Message.new('GET', API_URL);
        message.request_headers.append('Authorization', `Bearer ${token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                if (!this._accounts.includes(account))
                    return;

                try {
                    const bytes = session.send_and_read_finish(result);

                    if (message.status_code === 401) {
                        this._setAccountExpired(account, true);
                        this._updatePanelFromAccounts();
                        return;
                    }

                    if (message.status_code !== 200) {
                        if (account.menuWidgets)
                            account.menuWidgets.fiveHourPercent.set_text(`HTTP ${message.status_code}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));

                    account.cachedData = data;
                    this._setAccountExpired(account, false);
                    this._updateAccountMenu(account, data);
                    this._updatePanelFromAccounts();
                } catch (e) {
                    console.error(`Claude Usage: Failed to fetch usage for ${account.id}:`, e.message);
                }
            }
        );
    }

    // --- Menu UI ---

    _rebuildMenu() {
        this.menu.removeAll();

        if (this._accounts.length === 1) {
            // Single account: identical layout to original
            const account = this._accounts[0];
            account.menuWidgets = this._createUsageSectionWidgets(account);
        } else {
            // Multi-account: header per account
            this._accounts.forEach((account, index) => {
                // Account header
                const headerItem = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                });
                const headerLabel = new St.Label({
                    text: account.label,
                    style_class: 'claude-account-header-label',
                });
                headerItem.add_child(headerLabel);
                this.menu.addMenuItem(headerItem);

                account.menuWidgets = this._createUsageSectionWidgets(account);

                if (index < this._accounts.length - 1)
                    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            });
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    _createUsageSectionWidgets(account) {
        // 5-Hour section
        const fiveHourBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const fiveHourHeader = new St.BoxLayout({vertical: false});
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
        fiveHourBox.add_child(fiveHourHeader);

        const fiveHourProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        const fiveHourProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        fiveHourProgressBg.add_child(fiveHourProgressBar);
        fiveHourBox.add_child(fiveHourProgressBg);

        const fiveHourResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        fiveHourBox.add_child(fiveHourResetLabel);

        const fiveHourItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        fiveHourItem.add_child(fiveHourBox);
        this.menu.addMenuItem(fiveHourItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // 7-Day section
        const sevenDayBox = new St.BoxLayout({
            style_class: 'claude-usage-section',
            vertical: true,
        });
        const sevenDayHeader = new St.BoxLayout({vertical: false});
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
        sevenDayBox.add_child(sevenDayHeader);

        const sevenDayProgressBg = new St.Widget({
            style_class: 'claude-progress-bg',
        });
        const sevenDayProgressBar = new St.Widget({
            style_class: 'claude-progress-bar usage-low',
        });
        sevenDayProgressBg.add_child(sevenDayProgressBar);
        sevenDayBox.add_child(sevenDayProgressBg);

        const sevenDayResetLabel = new St.Label({
            text: 'Resets: ...',
            style_class: 'claude-reset-label',
        });
        sevenDayBox.add_child(sevenDayResetLabel);

        const sevenDayItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        sevenDayItem.add_child(sevenDayBox);
        this.menu.addMenuItem(sevenDayItem);

        return {
            fiveHourPercent,
            fiveHourProgressBar,
            fiveHourResetLabel,
            sevenDayPercent,
            sevenDayProgressBar,
            sevenDayResetLabel,
        };
    }

    _updateAccountMenu(account, data) {
        if (!account.menuWidgets)
            return;

        const w = account.menuWidgets;
        const fiveHour = data.five_hour?.utilization ?? 0;
        const sevenDay = data.seven_day?.utilization ?? 0;

        w.fiveHourPercent.set_text(`${fiveHour.toFixed(1)}%`);
        this._updateProgressBar(w.fiveHourProgressBar, fiveHour);

        w.sevenDayPercent.set_text(`${sevenDay.toFixed(1)}%`);
        this._updateProgressBar(w.sevenDayProgressBar, sevenDay);

        if (data.five_hour?.resets_at) {
            w.fiveHourResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.five_hour.resets_at)}`
            );
        }

        if (data.seven_day?.resets_at) {
            w.sevenDayResetLabel.set_text(
                `Resets in ${this._formatResetTime(data.seven_day.resets_at)}`
            );
        }
    }

    // --- Panel UI ---

    _updatePanelFromAccounts() {
        // Single account: simple display, no mode dispatch
        if (this._accounts.length <= 1) {
            this._updatePanelSingleAccount('highest');
        } else {
            const mode = this._settings.get_string('panel-account-mode');
            if (mode === 'pinned')
                this._updatePanelPinned();
            else
                this._updatePanelSingleAccount(mode);
        }

        // Global expired state
        const allExpired = this._accounts.length > 0 &&
            this._accounts.every(a => a.isTokenExpired);
        this._setGlobalExpiredState(allExpired);
    }

    _updatePanelSingleAccount(mode) {
        const isLowest = mode === 'lowest';
        let selectedAccount = null;
        let selectedUsage = isLowest ? Infinity : -1;

        // First pass: non-expired accounts with data
        for (const account of this._accounts) {
            if (account.isTokenExpired || !account.cachedData)
                continue;
            const usage = account.cachedData.five_hour?.utilization ?? 0;
            if (isLowest ? usage < selectedUsage : usage > selectedUsage) {
                selectedUsage = usage;
                selectedAccount = account;
            }
        }

        // Fallback: expired accounts with cached data
        if (!selectedAccount) {
            selectedUsage = isLowest ? Infinity : -1;
            for (const account of this._accounts) {
                if (!account.cachedData)
                    continue;
                const usage = account.cachedData.five_hour?.utilization ?? 0;
                if (isLowest ? usage < selectedUsage : usage > selectedUsage) {
                    selectedUsage = usage;
                    selectedAccount = account;
                }
            }
        }

        if (selectedAccount) {
            const usage = selectedUsage;
            const suffix = selectedAccount.isTokenExpired ? ' (cached)' : '';

            if (this._accounts.length === 1) {
                this._label.set_text(`${Math.round(usage)}%${suffix}`);
            } else {
                this._label.set_text(`${selectedAccount.label}: ${Math.round(usage)}%${suffix}`);
            }

            this._updatePanelProgressBar(usage);
        } else {
            this._label.set_text('...');
            this._updatePanelProgressBar(0);
        }
    }

    _updatePanelPinned() {
        const pinnedPaths = this._settings.get_strv('pinned-accounts');

        // Clean up stale pinned paths
        const validPaths = pinnedPaths.filter(p =>
            this._accounts.some(a => a.configDir === p)
        );
        if (validPaths.length !== pinnedPaths.length)
            this._settings.set_strv('pinned-accounts', validPaths);

        // Filter accounts to pinned ones
        const pinnedAccounts = this._accounts.filter(a =>
            validPaths.includes(a.configDir)
        );

        if (pinnedAccounts.length === 0) {
            this._label.set_text('No pins');
            this._updatePanelProgressBar(0);
            return;
        }

        // Build label: "work: 45% | personal: 20%"
        const parts = [];
        let maxUsage = 0;

        for (const account of pinnedAccounts) {
            const data = account.cachedData;
            if (!data) {
                if (account.isTokenExpired)
                    parts.push(`${account.label}: expired`);
                else
                    parts.push(`${account.label}: ...`);
                continue;
            }

            const usage = data.five_hour?.utilization ?? 0;
            if (usage > maxUsage)
                maxUsage = usage;

            const suffix = account.isTokenExpired ? '*' : '';
            parts.push(`${account.label}: ${Math.round(usage)}%${suffix}`);
        }

        this._label.set_text(parts.join(' | '));
        this._updatePanelProgressBar(maxUsage);
    }

    _setAccountExpired(account, expired) {
        account.isTokenExpired = expired;

        if (!account.menuWidgets)
            return;

        if (expired) {
            if (account.cachedData) {
                const fiveHour = account.cachedData.five_hour?.utilization ?? 0;
                account.menuWidgets.fiveHourPercent.set_text(`${fiveHour.toFixed(1)}% (cached)`);
            } else {
                account.menuWidgets.fiveHourPercent.set_text('Token expired');
            }
        }
    }

    _setGlobalExpiredState(allExpired) {
        this._allTokensExpired = allExpired;
        const effectName = 'expired-desaturate';

        if (allExpired) {
            if (!this._icon.get_effect(effectName)) {
                this._icon.add_effect(new Clutter.DesaturateEffect({factor: 1.0, name: effectName}));
            }
            this._icon.set_opacity(128);
            this._updateExpiredVisibility();
        } else {
            this._icon.remove_effect_by_name(effectName);
            this._icon.set_opacity(255);
            this.show();
        }
    }

    _updateExpiredVisibility() {
        if (this._allTokensExpired && this._settings.get_boolean('hide-on-expired')) {
            this.hide();
        } else {
            this.show();
        }
    }

    // --- Progress bars ---

    _updatePanelProgressBar(usage) {
        const maxWidth = 50;
        const width = Math.round((Math.min(100, Math.max(0, usage)) / 100) * maxWidth);
        this._panelProgressBar.set_width(width);
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

    // --- Utilities ---

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
        this._stopTimer();
        for (const account of this._accounts) {
            account.destroy();
        }
        this._accounts = [];
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
