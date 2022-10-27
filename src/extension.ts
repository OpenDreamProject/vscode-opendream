// Main module for OpenDream extension.
'use strict';

import { CancellationToken, commands, ExtensionContext, FileType, ProcessExecution, Task, TaskGroup, TaskProvider, TaskScope, workspace } from 'vscode';
import * as vscode from 'vscode';

const TaskNames = {
	COMPILER: 'OpenDream: build compiler',
	CLIENT: 'OpenDream: build client',
	SERVER: 'OpenDream: build server',
	RUN_COMPILER: (dme: string) => `OpenDream: build - ${dme}`,
};

// Entry point.
export async function activate(context: ExtensionContext) {
	// ------------------------------------------------------------------------
	// Register commands.

	// Hidden command used in implementing `launch.json`.
	context.subscriptions.push(commands.registerCommand('opendream.getFilenameJson', async () => {
		return (await commands.executeCommand<string>('dreammaker.getFilenameDme'))!.replace(/\.dme$/, ".json");
	}));

	// ------------------------------------------------------------------------
	// Register the debugger mode.

	// I don't really know why this is necessary. The debug configuration this
	// provider returns is the same as the one in "initialConfigurations" in
	// package.json, but apparently VSC uses that only when creating a new
	// launch.json and not when handling an F5 press when a launch.json does
	// not exist.
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('opendream', {
		async resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, debugConfiguration: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
			// Called with debugConfiguration = {} if launch.json does not exist.
			return debugConfiguration.type ? debugConfiguration : {
				"type": "opendream",
				"request": "launch",
				"name": "Launch DreamSeeker",
				"preLaunchTask": "dm: build - ${command:CurrentDME}",
				"json": "${workspaceFolder}/${command:CurrentJson}",
				"noDebug": debugConfiguration.noDebug || false,
			};
		}
	}));

	// register debugger factory to point at OpenDream's debugger mode
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('opendream', {
		async createDebugAdapterDescriptor(session: vscode.DebugSession, executable: vscode.DebugAdapterExecutable | undefined): Promise<vscode.DebugAdapterDescriptor | null> {
			//return new vscode.DebugAdapterServer(result.port);
			return null;
		}
	}));
}
