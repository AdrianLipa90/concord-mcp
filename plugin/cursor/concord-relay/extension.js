/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

async function probe() {
  const commands = new Set(await vscode.commands.getCommands(true));
  const required = ['composer.desktopBridge.listThreads', 'composer.desktopBridge.sendMessage'];
  const present = required.filter((command) => commands.has(command));
  const discoveryDirectory = path.join(os.homedir(), '.cursor', 'desktop-bridge');
  const discoveries = fs.existsSync(discoveryDirectory)
    ? fs.readdirSync(discoveryDirectory).filter((entry) => entry.endsWith('.json'))
    : [];
  const compatible = present.length === required.length && discoveries.length > 0;
  const detail = compatible
    ? 'Cursor Desktop Bridge is enabled and discoverable.'
    : present.length === required.length
      ? 'Cursor contains Desktop Bridge commands, but the bridge is not enabled for this installation.'
      : 'No compatible Cursor Desktop Bridge contract was found.';
  await vscode.window.showInformationMessage(`Concord adapter: ${detail}`);
  return { compatible, commands: present, discoveries, detail };
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('concordRelay.probe', probe));
}

module.exports = { activate };
