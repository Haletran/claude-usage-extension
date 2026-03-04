import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'user:profile user:inference';

function generateCodeVerifier() {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        bytes[i] = GLib.random_int_range(0, 256);
    return GLib.base64_encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function codeChallenge(verifier) {
    const hex = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, verifier, -1);
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
        raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return GLib.base64_encode(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

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

        // Authentication group
        const authGroup = new Adw.PreferencesGroup({
            title: 'Authentication',
            description: 'Connect your Claude account so the extension manages its own token',
        });
        page.add(authGroup);

        const isConnected = () => settings.get_string('access-token') !== '';

        // Status row
        const statusRow = new Adw.ActionRow({
            title: 'Status',
        });
        const statusLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
        });
        statusRow.add_suffix(statusLabel);
        authGroup.add(statusRow);

        const updateStatus = (msg, connected) => {
            statusLabel.set_label(msg);
            if (connected) {
                statusLabel.set_css_classes(['success']);
            } else {
                statusLabel.set_css_classes(['dim-label']);
            }
        };

        // Connect button row
        const connectRow = new Adw.ActionRow({
            title: 'Connect Claude Account',
            subtitle: 'Opens your browser to authorize the extension',
        });
        const connectButton = new Gtk.Button({
            label: 'Connect',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        connectRow.add_suffix(connectButton);
        connectRow.set_activatable_widget(connectButton);
        authGroup.add(connectRow);

        // Code entry row (hidden until Connect is clicked)
        const codeRow = new Adw.EntryRow({
            title: 'Code from browser',
            show_apply_button: true,
        });
        codeRow.set_visible(false);
        authGroup.add(codeRow);

        // Disconnect row (only shown when connected)
        const disconnectRow = new Adw.ActionRow({
            title: 'Disconnect',
            subtitle: 'Remove stored credentials',
        });
        const disconnectButton = new Gtk.Button({
            label: 'Disconnect',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        disconnectRow.add_suffix(disconnectButton);
        disconnectRow.set_activatable_widget(disconnectButton);
        disconnectRow.set_visible(isConnected());
        authGroup.add(disconnectRow);

        // Set initial status
        if (isConnected()) {
            updateStatus('Connected', true);
        } else {
            updateStatus('Not connected', false);
        }

        // State for PKCE flow
        let codeVerifier = null;
        let oauthState = null;

        // Connect button handler
        connectButton.connect('clicked', () => {
            codeVerifier = generateCodeVerifier();
            const challenge = codeChallenge(codeVerifier);
            oauthState = generateCodeVerifier(); // reuse for random state
            const state = oauthState;

            const params = [
                `response_type=code`,
                `client_id=${encodeURIComponent(CLIENT_ID)}`,
                `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
                `scope=${encodeURIComponent(OAUTH_SCOPES)}`,
                `code_challenge=${encodeURIComponent(challenge)}`,
                `code_challenge_method=S256`,
                `state=${encodeURIComponent(state)}`,
            ].join('&');

            const url = `${AUTHORIZE_URL}?${params}`;
            Gio.AppInfo.launch_default_for_uri(url, null);
            codeRow.set_visible(true);
            codeRow.set_text('');
            updateStatus('Waiting for code…', false);
        });

        // Submit handler (apply button on codeRow)
        codeRow.connect('apply', () => {
            if (!codeVerifier) {
                updateStatus('Click Connect first', false);
                return;
            }

            let input = codeRow.get_text().trim();
            let code = input;
            let extractedState = oauthState;

            // If user pasted a full URL, extract code and state from it
            try {
                const url = new URL(input);
                if (url.searchParams.has('code'))
                    code = url.searchParams.get('code');
                if (url.searchParams.has('state'))
                    extractedState = url.searchParams.get('state');
            } catch (_) {
                // Not a URL — treat as raw code, strip any #fragment
                const hashIdx = code.indexOf('#');
                if (hashIdx !== -1)
                    code = code.slice(0, hashIdx);
            }

            if (!code) {
                updateStatus('Code cannot be empty', false);
                return;
            }

            updateStatus('Exchanging code…', false);
            connectButton.set_sensitive(false);

            const body = JSON.stringify({
                grant_type: 'authorization_code',
                code,
                state: extractedState,
                client_id: CLIENT_ID,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier,
            });

            const session = new Soup.Session();
            const message = Soup.Message.new('POST', TOKEN_URL);
            message.request_headers.append('Content-Type', 'application/json');
            message.set_request_body_from_bytes(
                null,
                new GLib.Bytes(new TextEncoder().encode(body))
            );

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (_session, result) => {
                try {
                    const bytes = _session.send_and_read_finish(result);
                    if (message.status_code !== 200) {
                        const errText = new TextDecoder().decode(bytes.get_data());
                        console.error('Claude Usage prefs: Token exchange failed:', errText);
                        updateStatus(`Error ${message.status_code}`, false);
                        connectButton.set_sensitive(true);
                        return;
                    }
                    const resp = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    settings.set_string('access-token', resp.access_token);
                    settings.set_string('refresh-token', resp.refresh_token);
                    settings.set_int64('expires-at', Date.now() + (resp.expires_in ?? 28800) * 1000);
                    updateStatus('Connected', true);
                    codeRow.set_visible(false);
                    disconnectRow.set_visible(true);
                    codeVerifier = null;
                    oauthState = null;
                } catch (e) {
                    console.error('Claude Usage prefs: Token exchange error:', e.message);
                    updateStatus('Exchange failed', false);
                } finally {
                    connectButton.set_sensitive(true);
                }
            });
        });

        // Disconnect handler
        disconnectButton.connect('clicked', () => {
            settings.set_string('access-token', '');
            settings.set_string('refresh-token', '');
            settings.set_int64('expires-at', 0);
            updateStatus('Not connected', false);
            disconnectRow.set_visible(false);
            codeRow.set_visible(false);
            codeVerifier = null;
            oauthState = null;
        });
    }
}
