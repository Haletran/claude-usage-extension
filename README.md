# Claude Code usage extension
![GNOME Shell 46+](https://img.shields.io/badge/GNOME%20Shell-46%2B-blue)   

A GNOME Shell extension that displays your Claude Code API usage percentage in the top panel. 

## Features                                                                                                                                                                                                      
                                                                                                                                                                                                                   
- **Real-time usage monitoring** - View your 5-hour and 7-day Claude Code usage                                                                                                                                  
- **Per-model weekly limits** - Optionally show 7-day usage broken down per model (e.g. Opus, Sonnet) when exposed by the API. Toggle in settings.
- **Settings menu*** - Change the layout or the refresh time                                                                                                                                              
                                                                                                                                                                                                            
## Requirements                                                                                                                                                                                                  
                                                                                                                                                                                                                   
- GNOME Shell 48 or later                                                                                                                                                                                        
- Claude Code installed and authenticated (`~/.claude/.credentials.json`)   

## Installation                                                                                                                                                                                                  

### Automatic

The extension is distributed on *extensions.gnome.org* here : [link](https://extensions.gnome.org/extension/9231/claude-code-usage/)


### Manual

```bash
git clone https://github.com/Haletran/claude-usage-extension
cp -r claude-usage-extension ~/.local/share/gnome-shell/extensions/claude-code-usage@haletran.com 
cd ~/.local/share/gnome-shell/extensions/claude-code-usage@haletran.com/schemas                                                                                                                                        
glib-compile-schemas .
## Restart Gnome Shell with Alt + F2 type r or logout
## Then enable the extension
```
