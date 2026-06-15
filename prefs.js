import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

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

        const displayGroup = new Adw.PreferencesGroup({
            title: 'Panel Display',
            description: 'Configure how usage is shown in the top panel',
        });
        page.add(displayGroup);

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

        const fileMonitorGroup = new Adw.PreferencesGroup({
            title: 'File Monitoring',
            description: 'Watch Claude config directories and refresh usage shortly after session activity stops',
        });
        page.add(fileMonitorGroup);

        const fileMonitorEnabledRow = new Adw.SwitchRow({
            title: 'Enable File Monitoring',
            subtitle: 'When off, only the periodic refresh timer triggers API calls',
        });
        settings.bind('file-monitoring-enabled', fileMonitorEnabledRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        fileMonitorGroup.add(fileMonitorEnabledRow);

        const debounceDelayRow = new Adw.SpinRow({
            title: 'Debounce Delay',
            subtitle: 'Seconds of file-activity silence before refreshing (resets on each new change)',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 300,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('debounce-delay'),
            }),
        });
        settings.bind('debounce-delay', debounceDelayRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('file-monitoring-enabled', debounceDelayRow, 'sensitive', Gio.SettingsBindFlags.GET);
        fileMonitorGroup.add(debounceDelayRow);

        const debounceMinIntervalRow = new Adw.SpinRow({
            title: 'Minimum Refresh Interval',
            subtitle: 'Minimum seconds between consecutive activity-triggered refreshes per profile',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 600,
                step_increment: 10,
                page_increment: 60,
                value: settings.get_int('debounce-min-interval'),
            }),
        });
        settings.bind('debounce-min-interval', debounceMinIntervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        settings.bind('file-monitoring-enabled', debounceMinIntervalRow, 'sensitive', Gio.SettingsBindFlags.GET);
        fileMonitorGroup.add(debounceMinIntervalRow);

        const profilesGroup = new Adw.PreferencesGroup({
            title: 'Profiles',
            description: 'Configure multiple Claude Code config directories',
        });
        page.add(profilesGroup);

        const getProfiles = () => {
            try {
                const parsed = JSON.parse(settings.get_string('profiles'));
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
                }
            } catch (e) {
                // fall through
            }
            return [{ name: 'Default', path: '~/.claude', showInPanel: true }];
        };

        // Adw.AlertDialog replaced Adw.MessageDialog in libadwaita 1.5 (GNOME 47).
        // Fall back to MessageDialog on GNOME 46 where AlertDialog doesn't exist.
        const useAlertDialog = typeof Adw.AlertDialog !== 'undefined';

        const showProfileDialog = (heading, profile, onSave) => {
            const dialog = useAlertDialog
                ? new Adw.AlertDialog({ heading })
                : new Adw.MessageDialog({ transient_for: window, modal: true, heading });

            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 10,
            });

            const nameEntry = new Gtk.Entry({ placeholder_text: 'Profile Name' });
            nameEntry.set_text(profile.name ?? '');
            const pathEntry = new Gtk.Entry({ placeholder_text: 'Config Path (e.g. ~/.claude)' });
            pathEntry.set_text(profile.path ?? '');

            const showInPanelBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });
            const showInPanelLabel = new Gtk.Label({ label: 'Show in Panel', hexpand: true, xalign: 0 });
            const showInPanelSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
            showInPanelSwitch.set_active(profile.showInPanel !== false);
            showInPanelBox.append(showInPanelLabel);
            showInPanelBox.append(showInPanelSwitch);

            content.append(nameEntry);
            content.append(pathEntry);
            content.append(showInPanelBox);
            dialog.set_extra_child(content);

            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('save', 'Save');
            dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
            dialog.set_default_response('save');
            dialog.set_close_response('cancel');

            dialog.connect('response', (d, response) => {
                if (response === 'save') {
                    const name = nameEntry.get_text().trim();
                    const path = pathEntry.get_text().trim();
                    if (name && path) {
                        onSave({
                            name,
                            path,
                            showInPanel: showInPanelSwitch.get_active(),
                        });
                    }
                }
                d.destroy();
            });

            useAlertDialog ? dialog.present(window) : dialog.present();
        };

        // Track the widgets we add so we can remove exactly those on re-render.
        // Adw.PreferencesGroup.get_first_child() returns internal scaffolding
        // (header + list box), not the rows we add, so iterating children to
        // clear them doesn't work and causes duplicated rows.
        let addedWidgets = [];

        const renderProfiles = () => {
            for (const widget of addedWidgets) {
                profilesGroup.remove(widget);
            }
            addedWidgets = [];

            const profiles = getProfiles();

            profiles.forEach((profile, index) => {
                const row = new Adw.ActionRow({
                    title: profile.name,
                    subtitle: profile.path,
                });

                const editButton = new Gtk.Button({
                    icon_name: 'document-edit-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });

                editButton.connect('clicked', () => {
                    showProfileDialog('Edit Profile', profile, (updated) => {
                        profiles[index] = updated;
                        settings.set_string('profiles', JSON.stringify(profiles));
                        renderProfiles();
                    });
                });

                const deleteButton = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'error'],
                });

                deleteButton.connect('clicked', () => {
                    profiles.splice(index, 1);
                    settings.set_string('profiles', JSON.stringify(profiles));
                    renderProfiles();
                });

                row.add_suffix(editButton);
                row.add_suffix(deleteButton);
                profilesGroup.add(row);
                addedWidgets.push(row);
            });

            const addButton = new Gtk.Button({
                label: 'Add Profile',
                margin_top: 10,
                halign: Gtk.Align.CENTER,
            });

            addButton.connect('clicked', () => {
                showProfileDialog('Add Profile', { showInPanel: true }, (created) => {
                    profiles.push(created);
                    settings.set_string('profiles', JSON.stringify(profiles));
                    renderProfiles();
                });
            });

            profilesGroup.add(addButton);
            addedWidgets.push(addButton);
        };

        renderProfiles();
    }
}
