'use strict';

const {Adw, Gtk, Gio} = imports.gi;
const ExtensionUtils = imports.misc.extensionUtils;

function init() {}

function fillPreferencesWindow(window) {
    const settings = ExtensionUtils.getSettings('org.gnome.shell.extensions.claude-code-usage');

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

    const refreshSpin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({
            lower: 10,
            upper: 600,
            step_increment: 10,
            page_increment: 60,
        }),
        valign: Gtk.Align.CENTER,
        numeric: true,
    });
    settings.bind('refresh-interval', refreshSpin, 'value', Gio.SettingsBindFlags.DEFAULT);

    const refreshRow = new Adw.ActionRow({
        title: 'Refresh Interval',
        subtitle: 'How often to refresh usage data (in seconds)',
    });
    refreshRow.add_suffix(refreshSpin);
    refreshRow.set_activatable_widget(refreshSpin);
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

    const showIconSwitch = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
    });
    settings.bind('show-icon', showIconSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

    const showIconRow = new Adw.ActionRow({
        title: 'Show Icon',
        subtitle: 'Display the Claude icon in the top bar',
    });
    showIconRow.add_suffix(showIconSwitch);
    showIconRow.set_activatable_widget(showIconSwitch);
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
}
