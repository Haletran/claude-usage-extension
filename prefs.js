import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Claude Usage Settings',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({
            title: 'General',
            description: 'Configure the Claude Usage extension',
        });
        page.add(generalGroup);

        const refreshRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'How often to refresh usage data (in seconds)',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('refresh-interval'),
            }),
        });
        settings.bind(
            'refresh-interval',
            refreshRow,
            'value',
            Gio.SettingsBindFlags.DEFAULT
        );
        generalGroup.add(refreshRow);

        // --- Accounts group ---
        const accounts = this._discoverAccountPaths(settings);
        const isMultiAccount = accounts.length >= 2;
        this._buildAccountsGroup(page, settings, accounts, isMultiAccount);

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'Configure how usage is shown in the top panel',
        });
        page.add(displayGroup);

        // Panel Account Mode (only for 2+ accounts)
        if (isMultiAccount) {
            const accountModeRow = new Adw.ComboRow({
                title: 'Panel Account Mode',
                subtitle: 'Which account to show in the top panel',
            });

            const accountModeModel = new Gtk.StringList();
            accountModeModel.append('Highest usage');
            accountModeModel.append('Lowest usage');
            accountModeModel.append('Pinned accounts');
            accountModeRow.set_model(accountModeModel);

            const currentAccountMode = settings.get_string('panel-account-mode');
            const accountModeIndex = currentAccountMode === 'lowest' ? 1
                : currentAccountMode === 'pinned' ? 2 : 0;
            accountModeRow.set_selected(accountModeIndex);

            accountModeRow.connect('notify::selected', () => {
                const selected = accountModeRow.get_selected();
                const modes = ['highest', 'lowest', 'pinned'];
                settings.set_string('panel-account-mode', modes[selected]);
            });

            displayGroup.add(accountModeRow);
        }

        const displayModeRow = new Adw.ComboRow({
            title: 'Display Mode',
            subtitle: 'Show usage as text percentage, progress bar, or both',
        });

        const displayModeModel = new Gtk.StringList();
        displayModeModel.append('Text (percentage)');
        displayModeModel.append('Progress Bar');
        displayModeModel.append('Both');
        displayModeRow.set_model(displayModeModel);

        const currentMode = settings.get_string('display-mode');
        const modeIndex = currentMode === 'bar' ? 1 : currentMode === 'both' ? 2 : 0;
        displayModeRow.set_selected(modeIndex);

        displayModeRow.connect('notify::selected', () => {
            const selected = displayModeRow.get_selected();
            const modes = ['text', 'bar', 'both'];
            settings.set_string('display-mode', modes[selected]);
        });

        displayGroup.add(displayModeRow);

        const iconStyleRow = new Adw.ComboRow({
            title: 'Icon Style',
            subtitle: 'Use a color or monochrome icon in the panel',
        });

        const iconStyleModel = new Gtk.StringList();
        iconStyleModel.append('Color');
        iconStyleModel.append('Monochrome');
        iconStyleRow.set_model(iconStyleModel);

        const currentStyle = settings.get_string('icon-style');
        iconStyleRow.set_selected(currentStyle === 'monochrome' ? 1 : 0);

        iconStyleRow.connect('notify::selected', () => {
            const selected = iconStyleRow.get_selected();
            settings.set_string('icon-style', selected === 1 ? 'monochrome' : 'color');
        });

        displayGroup.add(iconStyleRow);

        const showIconRow = new Adw.SwitchRow({
            title: 'Show Icon',
            subtitle: 'Display the Claude icon in the top bar',
        });
        settings.bind(
            'show-icon',
            showIconRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(showIconRow);

        const hideOnExpiredRow = new Adw.SwitchRow({
            title: 'Hide on Expired Token',
            subtitle: 'Hide the indicator when the OAuth token has expired',
        });
        settings.bind(
            'hide-on-expired',
            hideOnExpiredRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        displayGroup.add(hideOnExpiredRow);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network',
            description: 'Configure network settings',
        });
        page.add(networkGroup);

        const proxyRow = new Adw.EntryRow({
            title: 'Proxy URL',
            show_apply_button: true,
        });
        proxyRow.set_text(settings.get_string('proxy-url'));
        proxyRow.connect('apply', () => {
            settings.set_string('proxy-url', proxyRow.get_text());
        });
        networkGroup.add(proxyRow);

        const proxyHint = new Gtk.Label({
            label: 'Example: http://localhost:11809 (leave empty for no proxy)',
            xalign: 0,
            css_classes: ['dim-label', 'caption'],
            margin_start: 12,
            margin_top: 4,
        });
        networkGroup.add(proxyHint);
    }

    _buildAccountsGroup(page, settings, accounts, isMultiAccount) {
        const accountsGroup = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'Directories matching ~/.claude-*/ are detected automatically',
        });
        page.add(accountsGroup);

        const accountLabels = settings.get_strv('account-labels');

        for (const account of accounts) {
            const currentLabel = this._getLabelForPath(account.path, accountLabels) ?? account.defaultLabel;

            const row = new Adw.EntryRow({
                title: account.path,
                show_apply_button: true,
            });
            row.set_text(currentLabel);

            row.connect('apply', () => {
                const newLabel = row.get_text().trim();
                this._setLabelForPath(settings, account.path, newLabel);
            });

            // Pin button (only for 2+ accounts)
            if (isMultiAccount)
                this._addPinButton(row, account.path, settings);

            // Add delete button for manually added accounts only
            if (account.isManual) {
                const deleteButton = new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Remove this account',
                });
                deleteButton.connect('clicked', () => {
                    const current = settings.get_strv('extra-accounts');
                    const updated = current.filter(p => p !== account.path);
                    settings.set_strv('extra-accounts', updated);
                    accountsGroup.remove(row);
                });
                row.add_suffix(deleteButton);
            }

            accountsGroup.add(row);
        }

        // Add account button
        const addRow = new Adw.ActionRow({
            title: 'Add Account',
            subtitle: 'Add a custom config directory path',
            activatable: true,
        });
        addRow.add_suffix(new Gtk.Image({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
        }));
        addRow.connect('activated', () => {
            this._showAddAccountDialog(page.get_root(), settings, accountsGroup, addRow, isMultiAccount);
        });
        accountsGroup.add(addRow);
    }

    _discoverAccountPaths(settings) {
        const seen = new Set();
        const results = [];

        // Default account
        const defaultDir = GLib.getenv('CLAUDE_CONFIG_DIR') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        const defaultResolved = Gio.File.new_for_path(defaultDir).get_path();
        seen.add(defaultResolved);
        results.push({
            path: defaultResolved,
            defaultLabel: 'default',
            isManual: false,
        });

        // Auto-scan ~/.claude-*/
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
                results.push({
                    path: resolved,
                    defaultLabel: name.replace(/^\./, ''),
                    isManual: false,
                });
            }
            enumerator.close(null);
        } catch (e) {
            console.error('Claude Usage Prefs: Failed to scan home directory:', e.message);
        }

        // Manual extra accounts
        const extraAccounts = settings.get_strv('extra-accounts');
        for (const dirPath of extraAccounts) {
            const resolved = Gio.File.new_for_path(dirPath).get_path();
            if (seen.has(resolved))
                continue;

            seen.add(resolved);
            const baseName = GLib.path_get_basename(resolved).replace(/^\./, '');
            results.push({
                path: resolved,
                defaultLabel: baseName,
                isManual: true,
            });
        }

        return results;
    }

    _getLabelForPath(path, accountLabels) {
        const resolved = Gio.File.new_for_path(path).get_path();
        for (const entry of accountLabels) {
            const sepIdx = entry.indexOf('|');
            if (sepIdx === -1)
                continue;
            const entryPath = entry.substring(0, sepIdx);
            const entryLabel = entry.substring(sepIdx + 1);
            if (Gio.File.new_for_path(entryPath).get_path() === resolved)
                return entryLabel;
        }
        return null;
    }

    _setLabelForPath(settings, path, label) {
        const resolved = Gio.File.new_for_path(path).get_path();
        const current = settings.get_strv('account-labels');
        const filtered = current.filter(entry => {
            const sepIdx = entry.indexOf('|');
            if (sepIdx === -1) return false;
            const entryPath = entry.substring(0, sepIdx);
            return Gio.File.new_for_path(entryPath).get_path() !== resolved;
        });
        if (label)
            filtered.push(`${resolved}|${label}`);
        settings.set_strv('account-labels', filtered);
    }

    _addPinButton(row, accountPath, settings) {
        const pinned = settings.get_strv('pinned-accounts');
        const isPinned = pinned.includes(accountPath);

        const pinButton = new Gtk.ToggleButton({
            icon_name: 'view-pin-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            active: isPinned,
        });

        const updateOpacityAndTooltip = () => {
            const mode = settings.get_string('panel-account-mode');
            if (mode === 'pinned') {
                pinButton.set_opacity(1.0);
                pinButton.set_tooltip_text(
                    pinButton.get_active() ? 'Unpin from panel' : 'Pin to panel'
                );
            } else {
                pinButton.set_opacity(0.5);
                pinButton.set_tooltip_text('Switch to "Pinned accounts" mode to use pins');
            }
        };
        updateOpacityAndTooltip();

        pinButton.connect('toggled', () => {
            const current = settings.get_strv('pinned-accounts');
            if (pinButton.get_active()) {
                if (!current.includes(accountPath)) {
                    current.push(accountPath);
                    settings.set_strv('pinned-accounts', current);
                }
            } else {
                const updated = current.filter(p => p !== accountPath);
                settings.set_strv('pinned-accounts', updated);
            }
            updateOpacityAndTooltip();
        });

        const modeChangedId = settings.connect('changed::panel-account-mode', () => {
            updateOpacityAndTooltip();
        });
        row.connect('destroy', () => {
            settings.disconnect(modeChangedId);
        });

        row.add_suffix(pinButton);
    }

    _showAddAccountDialog(parentWindow, settings, accountsGroup, addRow, isMultiAccount) {
        const dialog = new Adw.AlertDialog({
            heading: 'Add Account',
            body: 'Enter the full path to a Claude config directory containing .credentials.json',
        });

        const entry = new Gtk.Entry({
            placeholder_text: '/home/user/.claude-work',
            hexpand: true,
        });
        dialog.set_extra_child(entry);

        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('add', 'Add');
        dialog.set_response_appearance('add', Adw.ResponseAppearance.SUGGESTED);

        dialog.connect('response', (dlg, response) => {
            if (response !== 'add')
                return;

            const path = entry.get_text().trim();
            if (!path)
                return;

            const resolved = Gio.File.new_for_path(path).get_path();
            const credFile = Gio.File.new_for_path(
                GLib.build_filenamev([resolved, '.credentials.json'])
            );

            if (!credFile.query_exists(null)) {
                const errorDialog = new Adw.AlertDialog({
                    heading: 'Invalid Path',
                    body: `No .credentials.json found in ${resolved}`,
                });
                errorDialog.add_response('ok', 'OK');
                errorDialog.present(parentWindow);
                return;
            }

            const current = settings.get_strv('extra-accounts');
            if (!current.includes(resolved)) {
                current.push(resolved);
                settings.set_strv('extra-accounts', current);
            }

            // Add a row dynamically
            const baseName = GLib.path_get_basename(resolved).replace(/^\./, '');
            const row = new Adw.EntryRow({
                title: resolved,
                show_apply_button: true,
            });
            row.set_text(baseName);
            row.connect('apply', () => {
                const newLabel = row.get_text().trim();
                this._setLabelForPath(settings, resolved, newLabel);
            });

            // Pin button (adding a new account means we now have 2+ accounts)
            if (isMultiAccount)
                this._addPinButton(row, resolved, settings);

            const deleteButton = new Gtk.Button({
                icon_name: 'edit-delete-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: 'Remove this account',
            });
            deleteButton.connect('clicked', () => {
                const cur = settings.get_strv('extra-accounts');
                const updated = cur.filter(p => p !== resolved);
                settings.set_strv('extra-accounts', updated);
                accountsGroup.remove(row);
            });
            row.add_suffix(deleteButton);

            // Insert before the "Add" row
            accountsGroup.remove(addRow);
            accountsGroup.add(row);
            accountsGroup.add(addRow);
        });

        dialog.present(parentWindow);
    }
}
